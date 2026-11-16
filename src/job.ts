// Formato de un trabajo de impresión. Es el mismo JSON que el TPV enviaba al servicio Python:
//   { connection: { type, params }, lines: [{ type, content }], action: 'print' | 'open_cash' }
// y el mismo que viaja en la columna `payload` de la tabla `impresiones`.
import { EscPosEncoder, type Align, type CodepageName } from './escpos/encoder.js'
import { imageToRaster } from './escpos/image.js'

export interface Connection {
  /** file | usb | serial | lan | tcp | ip | windows */
  type: string
  params: string
}

export interface JobLine {
  type: string
  content: string
}

export interface PrintJob {
  connection: Connection
  lines: JobLine[]
  action: 'print' | 'open_cash'
}

export class JobError extends Error {
  constructor(
    message: string,
    /** 400: el trabajo está mal formado; 502: falló la impresora o la descarga de una imagen */
    readonly status: 400 | 502 = 502
  ) {
    super(message)
  }
}

const MAX_LINES = 5000

export function parseJob(input: unknown): PrintJob {
  if (!isObject(input)) throw new JobError('El cuerpo debe ser un objeto JSON', 400)
  const conn = input.connection
  if (!isObject(conn) || typeof conn.type !== 'string' || typeof conn.params !== 'string') {
    throw new JobError('Falta connection.type o connection.params', 400)
  }
  const action = input.action === undefined ? 'print' : input.action
  if (action !== 'print' && action !== 'open_cash') throw new JobError(`Acción desconocida: ${String(action)}`, 400)
  const rawLines = input.lines === undefined ? [] : input.lines
  if (!Array.isArray(rawLines)) throw new JobError('lines debe ser una lista', 400)
  if (rawLines.length > MAX_LINES) throw new JobError(`Demasiadas líneas (máximo ${MAX_LINES})`, 400)
  const lines: JobLine[] = rawLines.map((l, i) => {
    if (!isObject(l) || typeof l.type !== 'string') throw new JobError(`Línea ${i} sin tipo`, 400)
    const content = l.content == null ? '' : String(l.content)
    return { type: l.type, content }
  })
  return {
    connection: { type: conn.type.trim().toLowerCase(), params: conn.params.trim() },
    lines,
    action
  }
}

export interface RenderOptions {
  codepage: CodepageName
  maxImageWidth: number
  fetchImage: (url: string) => Promise<Buffer>
}

/** Traduce el trabajo a bytes ESC/POS. Los tipos de línea desconocidos se ignoran, como antes. */
export async function renderJob(job: PrintJob, opts: RenderOptions): Promise<Buffer> {
  const enc = new EscPosEncoder(opts.codepage).initialize()

  if (job.action === 'open_cash') {
    return enc.openCashDrawer().encode()
  }

  enc.align('center') // el servicio Python centraba todo por defecto
  for (const line of job.lines) {
    switch (line.type) {
      case 'text':
        enc.text(line.content)
        break
      case 'setJustification':
        enc.align(toAlign(line.content))
        break
      case 'url_image':
      case 'image': {
        if (!line.content) break
        const img = await opts.fetchImage(line.content)
        try {
          enc.image(imageToRaster(img, opts.maxImageWidth))
        } catch (e) {
          throw new JobError(`No se pudo procesar la imagen ${line.content}: ${(e as Error).message}`, 502)
        }
        break
      }
      case 'qr':
      case 'qr_code':
        enc.qr(line.content)
        break
      case 'feed':
        enc.feed(Number(line.content) || 1)
        break
      case 'open_cash':
        enc.openCashDrawer()
        break
      default:
        break
    }
  }
  return enc.cut().encode()
}

function toAlign(v: string): Align {
  const s = v.trim().toLowerCase()
  return s === 'center' || s === 'right' ? s : 'left'
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export async function fetchImage(url: string): Promise<Buffer> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new JobError(`URL de imagen no válida: ${url}`, 400)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new JobError(`Solo se admiten imágenes por http(s): ${url}`, 400)
  }
  let res: Response
  try {
    res = await fetch(parsed, { signal: AbortSignal.timeout(15_000), redirect: 'follow' })
  } catch (e) {
    throw new JobError(`No se pudo descargar la imagen ${url}: ${(e as Error).message}`)
  }
  if (!res.ok) throw new JobError(`La imagen ${url} respondió ${res.status}`)
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > MAX_IMAGE_BYTES) throw new JobError(`La imagen ${url} supera 8 MB`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_IMAGE_BYTES) throw new JobError(`La imagen ${url} supera 8 MB`)
  return buf
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
