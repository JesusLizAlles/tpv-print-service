// Punto único para imprimir un trabajo, venga de la web del TPV, de la cola o del panel. Cada
// trabajo queda en el historial (src/history.ts) con los bytes enviados, para la vista previa.
import { isSimulating, type Config } from './config.js'
import { jobHistory, type JobSource } from './history.js'
import { fetchImage, JobError, renderJob, type PrintJob } from './job.js'
import { log } from './log.js'
import { describeTarget, resolveTarget, runSerial, send } from './transports/index.js'

export interface PrintResult {
  target: string
  bytes: number
  ms: number
  simulated: boolean
  historyId: string
}

export interface PrintDeps {
  fetchImage: (url: string) => Promise<Buffer>
}

const defaultDeps: PrintDeps = { fetchImage }

export interface PrintOptions {
  source: JobSource
  /** Solo genera los bytes y los guarda para la vista previa, sin tocar la impresora */
  previewOnly?: boolean
}

const SIMULATED_TARGET = 'vista previa (sin imprimir)'

export async function printJob(
  job: PrintJob,
  cfg: Config,
  deps: PrintDeps = defaultDeps,
  opts: PrintOptions = { source: 'web' }
): Promise<PrintResult> {
  const started = Date.now()
  const simulated = opts.previewOnly === true || isSimulating(cfg) || job.connection.type === 'preview'

  // El turno en la cola de la impresora se coge al llegar, para respetar el orden de llegada, pero
  // el render (que puede descargar imágenes) empieza ya en paralelo y no espera a los anteriores.
  const rendering = renderJob(job, {
    codepage: cfg.codepage,
    maxImageWidth: cfg.maxImageWidth,
    fetchImage: deps.fetchImage
  })
  rendering.catch(() => undefined) // el error se recoge más abajo

  let bytes: Buffer | null = null
  let target = simulated ? SIMULATED_TARGET : `${job.connection.type}: ${job.connection.params}`
  try {
    if (simulated) {
      bytes = await rendering
      if (opts.source !== 'vista-previa') log('warn', 'local', `Simulación: trabajo de ${opts.source} guardado sin imprimir`)
    } else {
      const key = `${job.connection.type}|${job.connection.params.toLowerCase()}`
      await runSerial(key, async () => {
        const t = await resolveTarget(job.connection)
        target = describeTarget(t)
        bytes = await rendering
        await send(t, bytes)
      })
    }
  } catch (e) {
    const msg = (e as Error).message
    jobHistory.add({ source: opts.source, target, ok: false, error: msg, ms: Date.now() - started, simulated, job, bytes })
    throw e instanceof JobError ? e : new JobError(msg)
  }
  const ms = Date.now() - started
  const rec = jobHistory.add({ source: opts.source, target, ok: true, error: null, ms, simulated, job, bytes })
  return { target, bytes: (bytes as Buffer | null)?.length ?? 0, ms, simulated, historyId: rec.id }
}
