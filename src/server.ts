// API local en https://127.0.0.1:<puerto>:
//   POST /         imprime un trabajo { connection, lines, action }: lo que llama hoy la web del TPV
//   GET  /health   estado y versión, para que el TPV sepa si el agente está instalado
//   GET  /admin    panel de configuración (solo desde este equipo)
//   /api/admin/*   API del panel (solo desde este equipo y desde el propio panel)
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import type { AgentStatus, QueueAgent } from './agent/queue-agent.js'
import { pairAgent } from './agent/queue-agent.js'
import { dataDir, sanitizeConfig, validPort, type Config } from './config.js'
import { isCodepage } from './escpos/encoder.js'
import { JobError, parseJob, type PrintJob } from './job.js'
import { log, recentActivity } from './log.js'
import type { PrintResult } from './printer.js'
import { tlsStatus, type TlsFiles } from './tls.js'
import type { Updater } from './updater.js'
import { PRODUCT, VERSION } from './version.js'
import { listWindowsPrinters } from './windows/printers.js'
import adminHtml from './admin/index.html?raw'

export interface AppContext {
  getConfig(): Config
  saveConfig(cfg: Config): void
  print(job: PrintJob): Promise<PrintResult>
  agent: Pick<QueueAgent, 'getStatus' | 'restart'>
  updater: Pick<Updater, 'getStatus' | 'check' | 'install'>
  tls: TlsFiles
  /** Reinicia el proceso (WinSW lo vuelve a arrancar), p. ej. tras cambiar el puerto */
  requestRestart(reason: string): void
  fetch?: typeof fetch
}

const MAX_BODY = 4 * 1024 * 1024

export function createServer(ctx: AppContext, tls: { key: Buffer; cert: Buffer } | null): http.Server {
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    handle(ctx, req, res, tls ? 'https' : 'http').catch((e: unknown) => {
      log('error', 'sistema', `Error no controlado en ${req.method} ${req.url}: ${(e as Error).stack ?? e}`)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Error interno del agente' })
      else res.end()
    })
  }
  const server = tls ? https.createServer({ key: tls.key, cert: tls.cert }, handler) : http.createServer(handler)
  // Las esperas de impresión pueden durar: que no corte Node antes que el TPV.
  server.requestTimeout = 120_000
  return server
}

async function handle(ctx: AppContext, req: http.IncomingMessage, res: http.ServerResponse, proto: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local')
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const cfg = ctx.getConfig()

  // --- API pública (la usa la web del TPV desde su propio dominio) ---
  if (path === '/' || path === '/health') {
    if (!applyCors(cfg, req, res)) return sendJson(res, 403, { ok: false, error: 'Origen no permitido' })
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }
    if (path === '/health' && req.method === 'GET') {
      return sendJson(res, 200, health(ctx))
    }
    if (path === '/' && req.method === 'POST') return printFromRequest(ctx, req, res)
    if (path === '/' && req.method === 'GET' && isLoopback(req)) {
      res.writeHead(302, { location: '/admin' }).end()
      return
    }
    return sendJson(res, 405, { ok: false, error: 'Método no permitido' })
  }

  // --- Panel: solo este equipo, y la API solo desde el propio panel ---
  if (path === '/admin' || path.startsWith('/api/admin/')) {
    if (!isLoopback(req) || !loopbackHost(req)) {
      return sendJson(res, 403, { ok: false, error: 'El panel solo se abre desde este equipo, en https://127.0.0.1' })
    }
    if (path === '/admin') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Método no permitido' })
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
      })
      res.end(adminHtml)
      return
    }
    if (!sameOrigin(req, proto)) return sendJson(res, 403, { ok: false, error: 'Origen no permitido' })
    return adminApi(ctx, req, res, path.slice('/api/admin/'.length))
  }

  sendJson(res, 404, { ok: false, error: 'No encontrado' })
}

function health(ctx: AppContext) {
  const st: AgentStatus = ctx.agent.getStatus()
  return {
    ok: true,
    name: PRODUCT,
    version: VERSION,
    queue: { state: st.state, tpv: st.tpvName }
  }
}

async function printFromRequest(ctx: AppContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let job: PrintJob
  try {
    job = parseJob(await readJson(req))
  } catch (e) {
    const err = e instanceof JobError ? e : new JobError((e as Error).message, 400)
    log('warn', 'local', `Petición rechazada: ${err.message}`)
    return sendJson(res, err.status, { ok: false, error: err.message })
  }
  try {
    const r = await ctx.print(job)
    const what = job.action === 'open_cash' ? 'Cajón abierto' : 'Impreso'
    log('info', 'local', `${what} en ${r.target} (${r.ms} ms)`)
    sendJson(res, 200, { ok: true, ms: r.ms })
  } catch (e) {
    const err = e instanceof JobError ? e : new JobError((e as Error).message)
    log('error', 'local', `No se pudo imprimir: ${err.message}`)
    sendJson(res, err.status, { ok: false, error: err.message })
  }
}

async function adminApi(ctx: AppContext, req: http.IncomingMessage, res: http.ServerResponse, route: string): Promise<void> {
  const method = req.method ?? 'GET'
  try {
    if (method === 'GET' && route === 'state') return sendJson(res, 200, adminState(ctx))
    if (method === 'GET' && route === 'activity') return sendJson(res, 200, { entries: recentActivity(200) })
    if (method === 'GET' && route === 'printers') {
      return sendJson(res, 200, { printers: await listWindowsPrinters(true), supported: process.platform === 'win32' })
    }
    if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Método no permitido' })
    const body = (await readJson(req)) as Record<string, unknown>

    switch (route) {
      case 'config': {
        const cfg = ctx.getConfig()
        const next = sanitizeConfig({
          ...cfg,
          port: body.port ?? cfg.port,
          codepage: body.codepage ?? cfg.codepage,
          maxImageWidth: body.maxImageWidth ?? cfg.maxImageWidth,
          updates: {
            auto: body.autoUpdate ?? cfg.updates.auto,
            windowStart: body.windowStart ?? cfg.updates.windowStart,
            windowEnd: body.windowEnd ?? cfg.updates.windowEnd
          }
        })
        if (body.port !== undefined && !validPort(body.port)) throw new JobError('Puerto no válido (1-65535)', 400)
        if (body.codepage !== undefined && !isCodepage(body.codepage)) throw new JobError('Página de códigos no válida', 400)
        ctx.saveConfig(next)
        const restart = next.port !== cfg.port
        log('info', 'sistema', 'Configuración guardada' + (restart ? `; el agente se reinicia en el puerto ${next.port}` : ''))
        sendJson(res, 200, { ok: true, restart, port: next.port })
        if (restart) ctx.requestRestart(`nuevo puerto ${next.port}`)
        return
      }
      case 'pair': {
        if (typeof body.server !== 'string' || typeof body.code !== 'string') throw new JobError('Faltan el servidor o el código', 400)
        if (!/^\d{6}$/.test(body.code.trim())) throw new JobError('El código tiene 6 dígitos', 400)
        const link = await pairAgent(body.server, body.code, ctx.fetch)
        ctx.saveConfig({ ...ctx.getConfig(), server: link })
        log('info', 'agente', `Vinculado al TPV ${link.tpvName || link.tpvId} en ${link.url}`)
        await ctx.agent.restart()
        return sendJson(res, 200, { ok: true, tpv: link.tpvName || link.tpvId })
      }
      case 'unpair': {
        ctx.saveConfig({ ...ctx.getConfig(), server: null })
        log('info', 'agente', 'Agente desvinculado')
        await ctx.agent.restart()
        return sendJson(res, 200, { ok: true })
      }
      case 'test': {
        const job = parseJob({
          connection: body.connection,
          action: body.kind === 'drawer' ? 'open_cash' : 'print',
          lines: testLines()
        })
        const r = await ctx.print(job)
        log('info', 'local', `Prueba ${body.kind === 'drawer' ? 'de cajón' : 'de impresión'} en ${r.target}`)
        return sendJson(res, 200, { ok: true, target: r.target, ms: r.ms })
      }
      case 'update/check':
        return sendJson(res, 200, await ctx.updater.check())
      case 'update/install':
        await ctx.updater.install()
        return sendJson(res, 200, { ok: true })
      default:
        return sendJson(res, 404, { ok: false, error: 'No encontrado' })
    }
  } catch (e) {
    const status = e instanceof JobError ? e.status : 502
    sendJson(res, status, { ok: false, error: (e as Error).message })
  }
}

function adminState(ctx: AppContext) {
  const cfg = ctx.getConfig()
  return {
    product: PRODUCT,
    version: VERSION,
    machine: os.hostname(),
    platform: process.platform,
    dataDir: dataDir(),
    config: {
      port: cfg.port,
      https: cfg.https,
      listenHost: cfg.listenHost,
      codepage: cfg.codepage,
      maxImageWidth: cfg.maxImageWidth,
      allowedOrigins: cfg.allowedOrigins,
      updates: cfg.updates,
      server: cfg.server ? { url: cfg.server.url, tpvId: cfg.server.tpvId, tpvName: cfg.server.tpvName } : null
    },
    agent: ctx.agent.getStatus(),
    updater: ctx.updater.getStatus(),
    tls: tlsStatus(ctx.tls)
  }
}

function testLines() {
  const now = new Date().toLocaleString('es-ES')
  return [
    { type: 'text', content: `${PRODUCT}\n` },
    { type: 'text', content: 'Prueba de impresión\n\n' },
    { type: 'setJustification', content: 'left' },
    { type: 'text', content: `Equipo:  ${os.hostname()}\n` },
    { type: 'text', content: `Fecha:   ${now}\n` },
    { type: 'text', content: `Versión: ${VERSION}\n\n` },
    { type: 'text', content: 'Acentos: áéíóú ÁÉÍÓÚ ñÑ ü ç\n' },
    { type: 'text', content: 'Símbolos: 12,50 € ¿? ¡! º ª\n' },
    { type: 'text', content: '-'.repeat(42) + '\n' }
  ]
}

/** CORS de la API pública. Incluye la cabecera de acceso a la red privada que pide Chrome. */
function applyCors(cfg: Config, req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const origin = req.headers.origin
  const any = cfg.allowedOrigins.includes('*')
  if (origin) {
    if (!any && !cfg.allowedOrigins.includes(origin)) return false
    res.setHeader('access-control-allow-origin', any ? '*' : origin)
    if (!any) res.setHeader('vary', 'Origin')
  }
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers'] ?? 'content-type')
  res.setHeader('access-control-max-age', '600')
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('access-control-allow-private-network', 'true')
  }
  res.setHeader('cache-control', 'no-store')
  return true
}

function isLoopback(req: http.IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

/** El panel solo se sirve con Host 127.0.0.1/localhost: una web que apunte su dominio a 127.0.0.1
 *  (DNS rebinding) no puede leerlo ni usarlo. */
function loopbackHost(req: http.IncomingMessage): boolean {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.headers.host ?? '')
}

/** Las llamadas a /api/admin solo valen desde el propio panel: así ninguna web abierta en el
 *  navegador puede cambiar la configuración aunque la API pública admita cualquier origen. */
function sameOrigin(req: http.IncomingMessage, proto: string): boolean {
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (!origin) return req.method === 'GET'
  return origin.toLowerCase() === `${proto}://${req.headers.host ?? ''}`.toLowerCase()
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const type = req.headers['content-type'] ?? ''
    // La web del TPV manda application/json (axios). Se acepta también text/plain por si algún
    // cliente evita así la petición previa de CORS.
    if (type && !/^(application\/json|text\/plain)/i.test(type)) {
      reject(new JobError('Se esperaba JSON', 400))
      req.resume()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new JobError('Petición demasiado grande', 400))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new JobError('JSON no válido', 400))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
