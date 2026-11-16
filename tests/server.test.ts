import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../src/config.js'
import { JobError, type PrintJob } from '../src/job.js'
import { createServer, type AppContext } from '../src/server.js'
import { tlsFiles } from '../src/tls.js'
import { tempDir, testConfig } from './helpers.js'

let servers: http.Server[] = []
afterEach(() => {
  servers.forEach((s) => s.close())
  servers = []
})

async function start(overrides: Partial<Config> = {}, print?: (job: PrintJob) => Promise<never | { target: string; bytes: number; ms: number; simulated: boolean; historyId: string }>) {
  let cfg = testConfig(overrides)
  const printed: PrintJob[] = []
  const ctx: AppContext = {
    getConfig: () => cfg,
    saveConfig: (c) => (cfg = c),
    print: print ?? (async (job) => (printed.push(job), { target: 'x', bytes: 1, ms: 1, simulated: false, historyId: 'h' })),
    agent: { getStatus: () => ({ state: 'sin-vincular', tpvName: null, server: null, lastContactAt: null, lastError: null, inFlight: 0, printed: 0, failed: 0 }), restart: async () => {} },
    updater: { getStatus: () => ({ current: '0', checkedAt: null, latest: null, available: false, state: 'inactivo', error: null }), check: async () => ({}) as never, install: async () => {} },
    tls: tlsFiles(tempDir()),
    requestRestart: () => {}
  }
  const server = createServer(ctx, null)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  servers.push(server)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, printed, cfg: () => cfg }
}

const job = { connection: { type: 'file', params: 'x' }, lines: [{ type: 'text', content: 'hola' }], action: 'print' }

describe('API local compatible con la web del TPV', () => {
  it('POST / imprime y responde ok con CORS abierto', async () => {
    const { base, printed } = await start()
    const res = await fetch(base + '/', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://tpv.example.com' }, body: JSON.stringify(job) })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(await res.json()).toMatchObject({ ok: true })
    expect(printed).toHaveLength(1)
  })

  it('devuelve el error real de la impresora (antes siempre 200)', async () => {
    const { base } = await start({}, async () => Promise.reject(new JobError('Sin papel')))
    const res = await fetch(base + '/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(job) })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, error: 'Sin papel' })
  })

  it('400 con JSON mal formado', async () => {
    const { base } = await start()
    const res = await fetch(base + '/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
    expect(res.status).toBe(400)
  })

  it('con orígenes restringidos, rechaza los demás', async () => {
    const { base } = await start({ allowedOrigins: ['https://tpv.example.com'] })
    const ok = await fetch(base + '/health', { headers: { origin: 'https://tpv.example.com' } })
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://tpv.example.com')
    const ko = await fetch(base + '/', { method: 'POST', headers: { origin: 'https://otro.example', 'content-type': 'application/json' }, body: JSON.stringify(job) })
    expect(ko.status).toBe(403)
  })

  it('responde la petición previa de red privada de Chrome', async () => {
    const { base } = await start()
    const res = await fetch(base + '/', {
      method: 'OPTIONS',
      headers: { origin: 'https://tpv.example.com', 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' }
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-private-network')).toBe('true')
  })

  it('GET /health', async () => {
    const { base } = await start()
    expect(await (await fetch(base + '/health')).json()).toMatchObject({ ok: true, name: 'TPV Print Service' })
  })
})

describe('panel', () => {
  it('sirve el panel y su estado sin el token', async () => {
    const { base } = await start({ server: { url: 'https://tpv', agentId: 'a', token: 'SECRETO', tpvId: 't', tpvName: 'Barra' } })
    expect(await (await fetch(base + '/admin')).text()).toContain('TPV Print Service')
    const state = await (await fetch(base + '/api/admin/state')).text()
    expect(state).toContain('Barra')
    expect(state).not.toContain('SECRETO')
  })

  it('rechaza llamadas a la API del panel desde otra web', async () => {
    const { base } = await start()
    const res = await fetch(base + '/api/admin/unpair', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(403)
  })

  it('guarda la configuración y valida el puerto', async () => {
    const { base, cfg } = await start()
    const origin = base
    const bad = await fetch(base + '/api/admin/config', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ port: 70000 }) })
    expect(bad.status).toBe(400)
    const ok = await fetch(base + '/api/admin/config', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ codepage: 'cp850', autoUpdate: false }) })
    expect(await ok.json()).toMatchObject({ ok: true, restart: false })
    expect(cfg()).toMatchObject({ codepage: 'cp850', updates: { auto: false } })
  })
})

describe('panel y DNS rebinding', () => {
  it('no sirve el panel si el Host no es 127.0.0.1 o localhost', async () => {
    const { base } = await start()
    const port = new URL(base).port
    const status = await new Promise<number>((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/admin', headers: { host: `evil.example:${port}` } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
    })
    expect(status).toBe(403)
  })
})
