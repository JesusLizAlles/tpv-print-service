// Intérprete de ESC/POS para la vista previa: convierte los bytes que se envían a la impresora en
// una lista de operaciones que el panel dibuja como un ticket. Cubre lo que genera el agente
// (EscPosEncoder) y lo más habitual de otros generadores; lo desconocido queda como 'unknown'.
import iconv from 'iconv-lite'
import qrcode from 'qrcode-generator'
import { CODEPAGES, type Align } from './encoder.js'

export type PreviewOp =
  | { op: 'text'; text: string; align: Align; bold: boolean; size: number }
  | { op: 'feed'; lines: number }
  | { op: 'image'; align: Align; width: number; height: number; bytesPerRow: number; bits: string; source: 'raster' | 'qr' }
  | { op: 'cut' }
  | { op: 'drawer' }
  | { op: 'unknown'; bytes: string }

const ESC = 0x1b
const GS = 0x1d
const FS = 0x1c

const TABLE_TO_ENCODING = new Map<number, string>(Object.values(CODEPAGES).map((c) => [c.table, c.encoding]))

export function decodeEscPos(data: Buffer): PreviewOp[] {
  const ops: PreviewOp[] = []
  let align: Align = 'left'
  let bold = false
  let size = 1
  let encoding = 'cp437'
  let line: number[] = []
  // QR en curso (GS ( k): el contenido llega en una función y la orden de imprimir en otra
  let qrSize = 3
  let qrLevel: 'L' | 'M' | 'Q' | 'H' = 'L'
  let qrData: Buffer | null = null

  const flush = (newline: boolean) => {
    if (line.length || newline) {
      ops.push({ op: 'text', text: iconv.decode(Buffer.from(line), encoding), align, bold, size })
    }
    line = []
  }
  const unknown = (from: number, to: number) => {
    ops.push({ op: 'unknown', bytes: data.subarray(from, Math.min(to, data.length)).toString('hex') })
  }

  let i = 0
  while (i < data.length) {
    const b = data[i]!
    if (b === 0x0a) {
      flush(true)
      i++
      continue
    }
    if (b === 0x0d) {
      i++
      continue
    }
    if (b === 0x09) {
      line.push(0x20, 0x20, 0x20, 0x20)
      i++
      continue
    }

    if (b === ESC) {
      const c = data[i + 1]
      switch (c) {
        case 0x40: // ESC @: inicializar
          flush(false)
          align = 'left'
          bold = false
          size = 1
          i += 2
          continue
        case 0x74: // ESC t n: página de códigos
          encoding = TABLE_TO_ENCODING.get(data[i + 2] ?? 0) ?? 'cp437'
          i += 3
          continue
        case 0x61: {
          // ESC a n: alineación (afecta a la línea que empieza)
          if (line.length) flush(false)
          const n = data[i + 2] ?? 0
          align = n === 1 || n === 49 ? 'center' : n === 2 || n === 50 ? 'right' : 'left'
          i += 3
          continue
        }
        case 0x45: // ESC E n: negrita
        case 0x47: // ESC G n: doble golpe (se ve como negrita)
          bold = ((data[i + 2] ?? 0) & 1) === 1
          i += 3
          continue
        case 0x21: {
          // ESC ! n: modo de impresión (negrita y doble alto/ancho)
          const n = data[i + 2] ?? 0
          bold = (n & 0x08) !== 0
          size = n & 0x30 ? 2 : 1
          i += 3
          continue
        }
        case 0x64: // ESC d n: avanzar n líneas
          flush(false)
          ops.push({ op: 'feed', lines: data[i + 2] ?? 0 })
          i += 3
          continue
        case 0x4a: // ESC J n: avanzar n puntos
          flush(false)
          ops.push({ op: 'feed', lines: Math.max(1, Math.round((data[i + 2] ?? 0) / 30)) })
          i += 3
          continue
        case 0x70: // ESC p m t1 t2: abrir cajón
          flush(false)
          ops.push({ op: 'drawer' })
          i += 5
          continue
        case 0x2d: // ESC - n: subrayado (no se dibuja)
        case 0x4d: // ESC M n: fuente
        case 0x32: // ESC 2: interlineado por defecto
          i += c === 0x32 ? 2 : 3
          continue
        case 0x33: // ESC 3 n: interlineado
          i += 3
          continue
        default:
          unknown(i, i + 2)
          i += 2
          continue
      }
    }

    if (b === GS) {
      const c = data[i + 1]
      if (c === 0x56) {
        // GS V m [n]: corte
        flush(false)
        const m = data[i + 2] ?? 0
        ops.push({ op: 'cut' })
        i += m === 65 || m === 66 ? 4 : 3
        continue
      }
      if (c === 0x76 && data[i + 2] === 0x30) {
        // GS v 0 m xL xH yL yH d…: imagen raster
        flush(false)
        const bytesPerRow = (data[i + 4] ?? 0) | ((data[i + 5] ?? 0) << 8)
        const height = (data[i + 6] ?? 0) | ((data[i + 7] ?? 0) << 8)
        const start = i + 8
        const end = start + bytesPerRow * height
        const bits = data.subarray(start, Math.min(end, data.length))
        pushRaster(ops, align, bytesPerRow, height, bits)
        i = end
        continue
      }
      if (c === 0x28 && data[i + 2] === 0x6b) {
        // GS ( k pL pH cn fn …: QR
        const len = (data[i + 3] ?? 0) | ((data[i + 4] ?? 0) << 8)
        const cn = data[i + 5]
        const fn = data[i + 6]
        const params = data.subarray(i + 7, i + 5 + len)
        if (cn === 0x31) {
          if (fn === 0x43) qrSize = Math.max(1, Math.min(16, params[0] ?? 3))
          else if (fn === 0x45) qrLevel = (['L', 'M', 'Q', 'H'] as const)[(params[0] ?? 48) - 48] ?? 'L'
          else if (fn === 0x50) qrData = Buffer.from(params.subarray(1)) // tras el byte 0x30
          else if (fn === 0x51 && qrData) {
            flush(false)
            ops.push(qrOp(qrData, qrSize, qrLevel, align))
          }
        }
        i += 5 + len
        continue
      }
      if (c === 0x21) {
        // GS ! n: tamaño de carácter
        const n = data[i + 2] ?? 0
        size = n & 0x77 ? 2 : 1
        i += 3
        continue
      }
      if (c === 0x42 || c === 0x48 || c === 0x66 || c === 0x68 || c === 0x77 || c === 0x4c || c === 0x57) {
        // GS B (inverso), GS H/f/h/w (código de barras), GS L/W (márgenes): sin dibujo
        i += c === 0x4c || c === 0x57 ? 4 : 3
        continue
      }
      unknown(i, i + 2)
      i += 2
      continue
    }

    if (b === FS) {
      // FS: comandos de kanji y logotipos guardados; no se dibujan
      unknown(i, i + 2)
      i += 2
      continue
    }

    if (b < 0x20) {
      unknown(i, i + 1)
      i++
      continue
    }

    line.push(b)
    i++
  }
  flush(false)
  return ops
}

function pushRaster(ops: PreviewOp[], align: Align, bytesPerRow: number, height: number, bits: Buffer): void {
  // Las imágenes grandes llegan en bandas consecutivas: se juntan en una sola para dibujarlas.
  const last = ops[ops.length - 1]
  if (last && last.op === 'image' && last.source === 'raster' && last.bytesPerRow === bytesPerRow && last.align === align) {
    const merged = Buffer.concat([Buffer.from(last.bits, 'base64'), bits])
    last.height += height
    last.bits = merged.toString('base64')
    return
  }
  ops.push({ op: 'image', align, width: bytesPerRow * 8, height, bytesPerRow, bits: bits.toString('base64'), source: 'raster' })
}

/** El QR lo dibuja la impresora; aquí se genera uno equivalente para la vista previa. */
function qrOp(data: Buffer, moduleSize: number, level: 'L' | 'M' | 'Q' | 'H', align: Align): PreviewOp {
  const qr = qrcode(0, level)
  qr.addData(data.toString('latin1'), 'Byte') // bytes tal cual (la función por defecto toma c & 0xff)
  qr.make()
  const modules = qr.getModuleCount()
  const quiet = 4
  const width = (modules + quiet * 2) * moduleSize
  const bytesPerRow = Math.ceil(width / 8)
  const bits = Buffer.alloc(bytesPerRow * width)
  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      if (!qr.isDark(r, c)) continue
      for (let dy = 0; dy < moduleSize; dy++) {
        const y = (r + quiet) * moduleSize + dy
        for (let dx = 0; dx < moduleSize; dx++) {
          const x = (c + quiet) * moduleSize + dx
          bits[y * bytesPerRow + (x >> 3)]! |= 0x80 >> (x & 7)
        }
      }
    }
  }
  return { op: 'image', align, width, height: width, bytesPerRow, bits: bits.toString('base64'), source: 'qr' }
}
