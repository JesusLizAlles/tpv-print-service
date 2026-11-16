// Punto único para imprimir un trabajo, venga de la API local o de la cola del servidor.
import type { Config } from './config.js'
import { fetchImage, renderJob, type PrintJob } from './job.js'
import { describeTarget, resolveTarget, runSerial, send } from './transports/index.js'

export interface PrintResult {
  target: string
  bytes: number
  ms: number
}

export interface PrintDeps {
  fetchImage: (url: string) => Promise<Buffer>
}

const defaultDeps: PrintDeps = { fetchImage }

export async function printJob(job: PrintJob, cfg: Config, deps: PrintDeps = defaultDeps): Promise<PrintResult> {
  const started = Date.now()
  // El turno en la cola de la impresora se coge al llegar, para respetar el orden de llegada, pero
  // el render (que puede descargar imágenes) empieza ya en paralelo y no espera a los anteriores.
  const rendering = renderJob(job, {
    codepage: cfg.codepage,
    maxImageWidth: cfg.maxImageWidth,
    fetchImage: deps.fetchImage
  })
  rendering.catch(() => undefined) // el error se recoge dentro del turno
  const key = `${job.connection.type}|${job.connection.params.toLowerCase()}`
  return runSerial(key, async () => {
    const target = await resolveTarget(job.connection)
    const data = await rendering
    await send(target, data)
    return { target: describeTarget(target), bytes: data.length, ms: Date.now() - started }
  })
}
