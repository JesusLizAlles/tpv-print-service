// Cliente de la cola de impresión del servidor. Bucle de espera larga contra /claim, impresión en
// orden por impresora, confirmación (/ack) después de imprimir y latido (/heartbeat) cada 30 s.
//
// Garantías (ver docs/protocolo.md):
// - No se pierden trabajos: solo se confirma después de imprimir. Si el agente cae, la reserva
//   vence en el servidor y el trabajo vuelve a la cola.
// - No se imprimen dos veces: PrintedJournal recuerda los ids impresos; un trabajo que vuelve tras
//   perderse la confirmación solo se confirma.
import os from 'node:os'
import type { Config, ServerLink } from '../config.js'
import { parseJob, type PrintJob } from '../job.js'
import { log } from '../log.js'
import type { PrintResult } from '../printer.js'
import { VERSION } from '../version.js'
import type { PrintedJournal } from './journal.js'
import {
  parseClaimResponse,
  parsePairResponse,
  type AckRequest,
  type ClaimedJob,
  type HeartbeatRequest,
  type PairResponse
} from './protocol.js'

export type AgentState = 'sin-vincular' | 'conectando' | 'conectado' | 'sin-conexion' | 'revocado'

export interface AgentStatus {
  state: AgentState
  tpvName: string | null
  server: string | null
  lastContactAt: string | null
  lastError: string | null
  inFlight: number
  printed: number
  failed: number
}

export interface QueueAgentDeps {
  getConfig: () => Config
  print: (job: PrintJob) => Promise<PrintResult>
  journal: PrintedJournal
  fetch?: typeof fetch
  /** Para tests: acorta las esperas */
  timing?: Partial<Timing>
}

interface Timing {
  claimWait: number // s
  heartbeatMs: number
  unpairedPollMs: number
  backoffMs: number[]
  ackBackoffMs: number[]
}

const DEFAULT_TIMING: Timing = {
  claimWait: 25,
  heartbeatMs: 30_000,
  unpairedPollMs: 5_000,
  backoffMs: [1_000, 2_000, 5_000, 10_000, 30_000],
  ackBackoffMs: [1_000, 2_000, 5_000, 10_000, 20_000]
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export class QueueAgent {
  private running = false
  private abort = new AbortController()
  private loopDone: Promise<void> = Promise.resolve()
  private heartbeatTimer: NodeJS.Timeout | null = null
  private readonly inFlight = new Map<string, ClaimedJob>()
  private readonly timing: Timing
  private readonly http: typeof fetch
  private readonly startedAt = Date.now()
  private status: AgentStatus = {
    state: 'sin-vincular',
    tpvName: null,
    server: null,
    lastContactAt: null,
    lastError: null,
    inFlight: 0,
    printed: 0,
    failed: 0
  }

  constructor(private readonly deps: QueueAgentDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing }
    this.http = deps.fetch ?? fetch
  }

  getStatus(): AgentStatus {
    return { ...this.status, inFlight: this.inFlight.size }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.abort = new AbortController()
    this.loopDone = this.loop()
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.timing.heartbeatMs)
    this.heartbeatTimer.unref()
  }

  async stop(): Promise<void> {
    this.running = false
    this.abort.abort()
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    await this.loopDone
  }

  /** Tras vincular o desvincular: corta la espera en curso y vuelve a empezar con la config nueva. */
  async restart(): Promise<void> {
    await this.stop()
    this.status = { ...this.status, state: 'sin-vincular', lastError: null }
    this.start()
  }

  private async loop(): Promise<void> {
    let failures = 0
    while (this.running) {
      const link = this.deps.getConfig().server
      if (!link) {
        this.setState('sin-vincular', null)
        await this.sleep(this.timing.unpairedPollMs)
        continue
      }
      if (this.status.state === 'revocado') {
        await this.sleep(this.timing.unpairedPollMs)
        continue
      }
      try {
        if (this.status.state !== 'conectado') this.setState('conectando', link)
        const jobs = await this.claim(link)
        this.setState('conectado', link)
        this.status.lastContactAt = new Date().toISOString()
        failures = 0
        for (const job of jobs) this.accept(link, job)
      } catch (e) {
        if (!this.running) break
        if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
          this.status.lastError = 'El servidor ha rechazado el token del agente. Hay que volver a vincularlo.'
          this.setState('revocado', link)
          log('error', 'cola', this.status.lastError)
          continue
        }
        const msg = (e as Error).message
        if (this.status.lastError !== msg) log('warn', 'cola', `Sin conexión con el servidor: ${msg}`)
        this.status.lastError = msg
        this.setState('sin-conexion', link)
        const wait = this.timing.backoffMs[Math.min(failures, this.timing.backoffMs.length - 1)]!
        failures++
        await this.sleep(wait)
      }
    }
  }

  private accept(link: ServerLink, job: ClaimedJob): void {
    const current = this.inFlight.get(job.id)
    if (current) {
      // La reserva venció mientras esperaba su turno y el servidor la ha renovado: la confirmación
      // tiene que llevar el token nuevo.
      current.claim_token = job.claim_token
      return
    }
    this.inFlight.set(job.id, job)
    void this.process(link, job).finally(() => this.inFlight.delete(job.id))
  }

  private async process(link: ServerLink, job: ClaimedJob): Promise<void> {
    if (this.deps.journal.has(job.id)) {
      log('info', 'cola', `Trabajo ${short(job.id)} ya impreso antes; solo se confirma`)
      await this.ack(link, { id: job.id, claim_token: this.tokenOf(job), result: 'printed' })
      return
    }
    try {
      const parsed = parseJob(job.payload)
      const res = await this.deps.print(parsed)
      this.deps.journal.add(job.id)
      this.status.printed++
      log('info', 'cola', `Trabajo ${short(job.id)} impreso en ${res.target} (${res.ms} ms)`)
      await this.ack(link, { id: job.id, claim_token: this.tokenOf(job), result: 'printed' })
    } catch (e) {
      const error = (e as Error).message
      this.status.failed++
      this.status.lastError = error
      log('error', 'cola', `Trabajo ${short(job.id)}: ${error}`)
      await this.ack(link, { id: job.id, claim_token: this.tokenOf(job), result: 'error', error: error.slice(0, 1000) })
    }
  }

  private tokenOf(job: ClaimedJob): string {
    return this.inFlight.get(job.id)?.claim_token ?? job.claim_token
  }

  private async claim(link: ServerLink): Promise<ClaimedJob[]> {
    const wait = this.timing.claimWait
    const body = await this.post(link, '/api/print-agent/claim', { max: 10, wait }, (wait + 15) * 1000)
    return parseClaimResponse(body).jobs
  }

  private async ack(link: ServerLink, req: AckRequest): Promise<void> {
    for (let i = 0; ; i++) {
      try {
        await this.post(link, '/api/print-agent/ack', { ...req, claim_token: this.inFlight.get(req.id)?.claim_token ?? req.claim_token }, 15_000)
        return
      } catch (e) {
        // 409: la reserva ya no es nuestra (venció y la cogió otro intento). El registro local
        // evitará reimprimirlo si vuelve; no tiene sentido insistir.
        if (e instanceof HttpError && e.status === 409) return
        if (i >= this.timing.ackBackoffMs.length || !this.running) {
          log('warn', 'cola', `No se pudo confirmar ${short(req.id)}: ${(e as Error).message}. Se confirmará cuando el servidor lo reenvíe.`)
          return
        }
        await this.sleep(this.timing.ackBackoffMs[i]!)
      }
    }
  }

  private async heartbeat(): Promise<void> {
    const link = this.deps.getConfig().server
    if (!link || this.status.state === 'revocado') return
    const req: HeartbeatRequest = {
      version: VERSION,
      machine: os.hostname(),
      uptime: Math.round((Date.now() - this.startedAt) / 1000),
      in_flight: this.inFlight.size,
      printed: this.status.printed,
      failed: this.status.failed,
      last_error: this.status.lastError
    }
    try {
      await this.post(link, '/api/print-agent/heartbeat', req, 15_000)
    } catch {
      // el bucle de /claim ya refleja el estado de la conexión
    }
  }

  private async post(link: ServerLink, path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)])
    const res = await this.http(link.url + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${link.token}`,
        'x-agent-id': link.agentId,
        'user-agent': `tpv-print-service/${VERSION}`
      },
      body: JSON.stringify(body),
      signal
    })
    if (!res.ok) throw new HttpError(res.status, `${path} respondió ${res.status}`)
    const text = await res.text()
    return text ? JSON.parse(text) : {}
  }

  private setState(state: AgentState, link: ServerLink | null): void {
    if (this.status.state !== state) {
      if (state === 'conectado') log('info', 'cola', `Conectado a ${link?.url} (TPV ${link?.tpvName || link?.tpvId})`)
      this.status.state = state
    }
    this.status.server = link?.url ?? null
    this.status.tpvName = link ? link.tpvName || link.tpvId : null
  }

  /** Espera que se corta en cuanto se para el agente. */
  private sleep(ms: number): Promise<void> {
    const signal = this.abort.signal
    return new Promise((resolve) => {
      if (signal.aborted) return resolve()
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}

/** Intercambia el código de 6 dígitos del admin del TPV por las credenciales del agente. */
export async function pairAgent(serverUrl: string, code: string, http: typeof fetch = fetch): Promise<ServerLink> {
  const url = normalizeServerUrl(serverUrl)
  const res = await http(url + '/api/print-agent/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': `tpv-print-service/${VERSION}` },
    body: JSON.stringify({ code: code.trim(), machine: os.hostname(), version: VERSION }),
    signal: AbortSignal.timeout(15_000)
  })
  if (res.status === 404 || res.status === 422) throw new Error('Código no válido o caducado. Genera uno nuevo en el admin del TPV.')
  if (!res.ok) throw new Error(`El servidor respondió ${res.status}`)
  const data: PairResponse = parsePairResponse(await res.json())
  return { url, agentId: data.agent_id, token: data.token, tpvId: data.tpv_id, tpvName: data.tpv_name ?? '' }
}

export function normalizeServerUrl(value: string): string {
  let u: URL
  try {
    u = new URL(value.trim())
  } catch {
    throw new Error('La dirección del servidor no es una URL válida')
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) {
    throw new Error('El servidor tiene que ir por https://')
  }
  return u.origin + u.pathname.replace(/\/+$/, '')
}

function short(id: string): string {
  return id.slice(0, 8)
}
