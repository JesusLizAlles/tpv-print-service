// Últimos trabajos impresos (o simulados), con los bytes exactos enviados, para la vista previa del
// panel. Solo en memoria: los tickets llevan datos de clientes y no se guardan en disco; se pierden
// al reiniciar el servicio.
import crypto from 'node:crypto'
import type { PrintJob } from './job.js'

export type JobSource = 'web' | 'cola' | 'prueba' | 'vista-previa'

export interface JobRecord {
  id: string
  at: string
  source: JobSource
  target: string
  ok: boolean
  error: string | null
  ms: number
  /** No se envió a la impresora (modo simulación, conexión «preview» o vista previa) */
  simulated: boolean
  job: PrintJob
  bytes: Buffer | null
}

export interface JobSummary {
  id: string
  at: string
  source: JobSource
  target: string
  ok: boolean
  error: string | null
  ms: number
  simulated: boolean
  action: PrintJob['action']
  title: string
  lines: number
  bytes: number
}

const MAX_ITEMS = 50
const MAX_BYTES_PER_JOB = 4 * 1024 * 1024

export class JobHistory {
  private items: JobRecord[] = []

  add(rec: Omit<JobRecord, 'id' | 'at'>): JobRecord {
    const full: JobRecord = {
      ...rec,
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      bytes: rec.bytes && rec.bytes.length <= MAX_BYTES_PER_JOB ? rec.bytes : null
    }
    this.items.push(full)
    if (this.items.length > MAX_ITEMS) this.items.shift()
    return full
  }

  get(id: string): JobRecord | undefined {
    return this.items.find((r) => r.id === id)
  }

  list(): JobSummary[] {
    return this.items
      .slice()
      .reverse()
      .map((r) => summarize(r))
  }

  clear(): void {
    this.items = []
  }
}

export function summarize(r: JobRecord): JobSummary {
  return {
    id: r.id,
    at: r.at,
    source: r.source,
    target: r.target,
    ok: r.ok,
    error: r.error,
    ms: r.ms,
    simulated: r.simulated,
    action: r.job.action,
    title: jobTitle(r.job),
    lines: r.job.lines.length,
    bytes: r.bytes?.length ?? 0
  }
}

/** Primera línea de texto con contenido, para reconocer el ticket en la lista. */
export function jobTitle(job: PrintJob): string {
  if (job.action === 'open_cash') return 'Abrir cajón'
  for (const l of job.lines) {
    if (l.type === 'text') {
      for (const raw of l.content.split('\n')) {
        const t = raw.replace(/\s+/g, ' ').trim()
        if (t && !/^[-=_*.\s]+$/.test(t)) return t.slice(0, 80)
      }
    }
    if ((l.type === 'url_image' || l.type === 'image') && l.content) return 'Ticket en imagen'
  }
  return 'Sin texto'
}

export const jobHistory = new JobHistory()
