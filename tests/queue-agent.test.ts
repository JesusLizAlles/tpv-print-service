import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PrintedJournal } from '../src/agent/journal.js'
import { normalizeServerUrl, pairAgent, QueueAgent } from '../src/agent/queue-agent.js'
import type { Config } from '../src/config.js'
import { printJob } from '../src/printer.js'
import { tempDir, testConfig } from './helpers.js'

interface MockJob {
  id: string
  payload: unknown
  status: 'pending' | 'claimed' | 'done'
  token?: string
}

/** Servidor Laravel de mentira con el protocolo de /api/print-agent. */
async function mockServer(opts: { status?: number } = {}) {
  const jobs: MockJob[] = []
  const acks: Record<string, unknown>[] = []
  const heartbeats: unknown[] = []
  let claims = 0
  let n = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      const data = body ? JSON.parse(body) : {}
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (req.url === '/api/print-agent/pair') {
        return data.code === '123456'
          ? send(200, { agent_id: 'ag-1', token: 'secreto', tpv_id: 'tpv-1', tpv_name: 'Barra piscina' })
          : send(422, { message: 'Código no válido' })
      }
      if (opts.status) return send(opts.status, {})
      if (req.headers.authorization !== 'Bearer secreto') return send(401, {})
      if (req.url === '/api/print-agent/claim') {
        claims++
        const ready = jobs.filter((j) => j.status === 'pending')
        if (!ready.length) await new Promise((r) => setTimeout(r, 20))
        for (const j of ready) {
          j.status = 'claimed'
          j.token = `tok-${++n}`
        }
        return send(200, { jobs: ready.map((j) => ({ id: j.id, claim_token: j.token, printer_id: null, created_at: '', payload: j.payload })) })
      }
      if (req.url === '/api/print-agent/ack') {
        acks.push(data)
        const j = jobs.find((x) => x.id === data.id)
        if (!j || j.token !== data.claim_token) return send(409, {})
        j.status = 'done'
        return send(200, { ok: true })
      }
      if (req.url === '/api/print-agent/heartbeat') {
        heartbeats.push(data)
        return send(200, { ok: true })
      }
      send(404, {})
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, jobs, acks, heartbeats, claims: () => claims, close: () => new Promise((r) => server.close(r)) }
}

const fast = { claimWait: 1, heartbeatMs: 50, unpairedPollMs: 20, backoffMs: [20], ackBackoffMs: [10, 10] }

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('tiempo agotado esperando la condición')
    await new Promise((r) => setTimeout(r, 10))
  }
}

let cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const c of cleanup.reverse()) await c()
  cleanup = []
})

function setup(url: string, dir = tempDir()) {
  const cfg: Config = testConfig({ server: { url, agentId: 'ag-1', token: 'secreto', tpvId: 'tpv-1', tpvName: 'Barra piscina' } })
  const journal = new PrintedJournal(path.join(dir, 'printed.json'))
  let printed = 0
  const agent = new QueueAgent({
    getConfig: () => cfg,
    print: async (job) => {
      printed++
      return printJob(job, cfg, { fetchImage: async () => Buffer.alloc(0) })
    },
    journal,
    timing: fast
  })
  cleanup.push(() => agent.stop())
  return { agent, journal, dir, printed: () => printed }
}

describe('QueueAgent', () => {
  it('reclama, imprime y confirma con el token de la reserva', async () => {
    const srv = await mockServer()
    cleanup.push(srv.close)
    const { agent, dir } = setup(srv.url)
    const out = path.join(dir, 'cocina.bin')
    srv.jobs.push({ id: 'job-1', status: 'pending', payload: { connection: { type: 'file', params: out }, lines: [{ type: 'text', content: '2 cañas\n' }] } })
    agent.start()
    await until(() => srv.acks.length === 1)
    expect(srv.acks[0]).toMatchObject({ id: 'job-1', claim_token: 'tok-1', result: 'printed' })
    expect(fs.readFileSync(out).includes(Buffer.from([0x63, 0x61, 0xa4, 0x61, 0x73]))).toBe(true) // "cañas" en PC858
    expect(agent.getStatus()).toMatchObject({ state: 'conectado', printed: 1, tpvName: 'Barra piscina' })
  })

  it('el payload puede venir como cadena JSON (columna longtext)', async () => {
    const srv = await mockServer()
    cleanup.push(srv.close)
    const { agent, dir } = setup(srv.url)
    const out = path.join(dir, 'barra.bin')
    srv.jobs.push({ id: 'job-s', status: 'pending', payload: JSON.stringify({ connection: { type: 'file', params: out }, lines: [] }) })
    agent.start()
    await until(() => srv.acks.length === 1)
    expect(srv.acks[0]).toMatchObject({ result: 'printed' })
  })

  it('no reimprime un trabajo que ya está en el registro local; solo lo confirma', async () => {
    const srv = await mockServer()
    cleanup.push(srv.close)
    const { agent, journal, printed } = setup(srv.url)
    journal.add('job-2')
    srv.jobs.push({ id: 'job-2', status: 'pending', payload: { connection: { type: 'lan', params: '127.0.0.1:1' }, lines: [] } })
    agent.start()
    await until(() => srv.acks.length === 1)
    expect(srv.acks[0]).toMatchObject({ id: 'job-2', result: 'printed' })
    expect(printed()).toBe(0)
  })

  it('informa del error de la impresora', async () => {
    const srv = await mockServer()
    cleanup.push(srv.close)
    const { agent } = setup(srv.url)
    srv.jobs.push({ id: 'job-3', status: 'pending', payload: { connection: { type: 'lan', params: '127.0.0.1:1' }, lines: [] } })
    agent.start()
    await until(() => srv.acks.length === 1)
    expect(srv.acks[0]).toMatchObject({ id: 'job-3', result: 'error' })
    expect(String(srv.acks[0]!.error)).toMatch(/rechazada/)
    expect(agent.getStatus().failed).toBe(1)
  })

  it('un payload inválido se confirma como error y no bloquea la cola', async () => {
    const srv = await mockServer()
    cleanup.push(srv.close)
    const { agent } = setup(srv.url)
    srv.jobs.push({ id: 'job-bad', status: 'pending', payload: { lines: [] } })
    agent.start()
    await until(() => srv.acks.length === 1)
    expect(srv.acks[0]).toMatchObject({ id: 'job-bad', result: 'error' })
  })

  it('el registro de impresos sobrevive a un reinicio', () => {
    const dir = tempDir()
    new PrintedJournal(path.join(dir, 'printed.json')).add('job-x')
    expect(new PrintedJournal(path.join(dir, 'printed.json')).has('job-x')).toBe(true)
  })

  it('envía latidos', async () => {
    const srv = await mockServer()
    cleanup.push(srv.close)
    const { agent } = setup(srv.url)
    agent.start()
    await until(() => srv.heartbeats.length > 0)
    expect(srv.heartbeats[0]).toMatchObject({ version: '0.0.0-dev', printed: 0 })
  })

  it('si el servidor rechaza el token, pasa a revocado y deja de reclamar', async () => {
    const srv = await mockServer({ status: 401 })
    cleanup.push(srv.close)
    const { agent } = setup(srv.url)
    agent.start()
    await until(() => agent.getStatus().state === 'revocado')
    expect(agent.getStatus().lastError).toMatch(/volver a vincular/)
  })

  it('sin conexión reintenta con espera creciente', async () => {
    const { agent } = setup('http://127.0.0.1:1')
    agent.start()
    await until(() => agent.getStatus().state === 'sin-conexion')
  })
})

describe('vinculación', () => {
  it('intercambia el código por las credenciales', async () => {
    const srv = await mockServer()
    cleanup.push(srv.close)
    const link = await pairAgent(srv.url + '/', '123456')
    expect(link).toEqual({ url: srv.url, agentId: 'ag-1', token: 'secreto', tpvId: 'tpv-1', tpvName: 'Barra piscina' })
  })

  it('un código caducado da un mensaje claro', async () => {
    const srv = await mockServer()
    cleanup.push(srv.close)
    await expect(pairAgent(srv.url, '000000')).rejects.toThrow(/caducado/)
  })

  it('exige https salvo en localhost', () => {
    expect(() => normalizeServerUrl('http://tpv.example.com')).toThrow(/https/)
    expect(normalizeServerUrl('https://tpv.example.com/')).toBe('https://tpv.example.com')
  })
})
