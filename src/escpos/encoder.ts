// Generador de comandos ESC/POS. Solo lo que usa el TPV: texto, alineación, imagen raster, QR,
// avance, corte y apertura del cajón. Referencia: Epson ESC/POS Application Programming Guide.
import iconv from 'iconv-lite'
import type { RasterImage } from './image.js'

const ESC = 0x1b
const GS = 0x1d

export type Align = 'left' | 'center' | 'right'

/** Páginas de códigos que admiten las térmicas habituales, con su número para ESC t. */
export const CODEPAGES = {
  cp858: { table: 19, encoding: 'cp858' }, // PC858: como PC850, con el símbolo €
  cp850: { table: 2, encoding: 'cp850' },
  cp437: { table: 0, encoding: 'cp437' },
  cp1252: { table: 16, encoding: 'win1252' }
} as const

export type CodepageName = keyof typeof CODEPAGES

export function isCodepage(value: unknown): value is CodepageName {
  return typeof value === 'string' && Object.hasOwn(CODEPAGES, value)
}

/** Filas por bloque de imagen: bloques pequeños para no desbordar el búfer de impresoras baratas. */
const RASTER_BAND_ROWS = 256

export class EscPosEncoder {
  private readonly parts: Buffer[] = []
  private readonly codepage: (typeof CODEPAGES)[CodepageName]

  constructor(codepage: CodepageName = 'cp858') {
    this.codepage = CODEPAGES[codepage]
  }

  raw(bytes: Buffer | Uint8Array | number[]): this {
    this.parts.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))
    return this
  }

  /** ESC @ (reinicia la impresora) y ESC t (página de códigos). */
  initialize(): this {
    return this.raw([ESC, 0x40, ESC, 0x74, this.codepage.table])
  }

  align(value: Align): this {
    const n = value === 'center' ? 1 : value === 'right' ? 2 : 0
    return this.raw([ESC, 0x61, n])
  }

  text(value: string): this {
    // Normaliza a NFC (acentos compuestos) y quita controles que la impresora interpretaría como comandos.
    const clean = value
      .normalize('NFC')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    return this.raw(iconv.encode(clean, this.codepage.encoding))
  }

  /** ESC d n: imprime y avanza n líneas. */
  feed(lines = 1): this {
    return this.raw([ESC, 0x64, clampByte(lines)])
  }

  /** Avanza y corta. GS V 0 (corte total), como el servicio Python anterior. */
  cut(): this {
    return this.feed(6).raw([GS, 0x56, 0x00])
  }

  /** Pulso al cajón portamonedas por el pin 2: ESC p 0 25 250, el mismo que enviaba python-escpos. */
  openCashDrawer(): this {
    return this.raw([ESC, 0x70, 0x00, 0x19, 0xfa])
  }

  /** QR nativo (GS ( k), modelo 2, corrección L. `size` es el tamaño del módulo en puntos (1-16). */
  qr(data: string, size = 5): this {
    const payload = Buffer.from(data, 'utf8')
    if (payload.length === 0) return this
    if (payload.length > 7089) throw new Error('El contenido del QR es demasiado largo')
    const store = payload.length + 3
    this.raw([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]) // modelo 2
    this.raw([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, Math.min(16, Math.max(1, size))]) // tamaño
    this.raw([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x30]) // corrección L
    this.raw([GS, 0x28, 0x6b, store & 0xff, (store >> 8) & 0xff, 0x31, 0x50, 0x30])
    this.raw(payload)
    this.raw([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]) // imprimir
    return this.feed(1)
  }

  /** Imagen 1 bit con GS v 0, en bandas de RASTER_BAND_ROWS filas. */
  image(img: RasterImage): this {
    const { bytesPerRow, height, bits } = img
    for (let y = 0; y < height; y += RASTER_BAND_ROWS) {
      const rows = Math.min(RASTER_BAND_ROWS, height - y)
      this.raw([GS, 0x76, 0x30, 0x00, bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff, rows & 0xff, (rows >> 8) & 0xff])
      this.raw(bits.subarray(y * bytesPerRow, (y + rows) * bytesPerRow))
    }
    return this
  }

  encode(): Buffer {
    return Buffer.concat(this.parts)
  }
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.trunc(n)))
}
