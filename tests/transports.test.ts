import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseHostPort, parseUnc, resolveTarget, runSerial, send } from '../src/transports/index.js'
import { tempDir } from './helpers.js'

describe('resolveTarget', () => {
  it('lan/ip/tcp van por TCP, 9100 por defecto', async () => {
    expect(await resolveTarget({ type: 'lan', params: '192.168.1.50' })).toEqual({ kind: 'tcp', host: '192.168.1.50', port: 9100 })
    expect(await resolveTarget({ type: 'ip', params: '192.168.1.50:9101' })).toEqual({ kind: 'tcp', host: '192.168.1.50', port: 9101 })
  })

  it('COM3 es un puerto serie', async () => {
    expect(await resolveTarget({ type: 'file', params: 'com3' })).toEqual({ kind: 'file', path: '\\\\.\\COM3' })
  })

  it('una ruta compartida fuera de Windows se escribe tal cual', async () => {
    if (process.platform === 'win32') return
    expect(await resolveTarget({ type: 'file', params: '\\\\PC\\tickets' })).toEqual({ kind: 'file', path: '\\\\PC\\tickets' })
  })

  it('windows usa la cola de impresión', async () => {
    expect(await resolveTarget({ type: 'windows', params: 'EPSON TM-T20' })).toEqual({ kind: 'spooler', printer: 'EPSON TM-T20' })
  })

  it('rechaza parámetros vacíos y tipos desconocidos', async () => {
    await expect(resolveTarget({ type: 'lan', params: '' })).rejects.toThrow(/parámetros/)
    await expect(resolveTarget({ type: 'bluetooth', params: 'x' })).rejects.toThrow(/desconocido/)
  })
})

describe('parsers', () => {
  it('parseHostPort', () => {
    expect(parseHostPort('10.0.0.1', 9100)).toEqual({ host: '10.0.0.1', port: 9100 })
    expect(parseHostPort('[::1]:9200', 9100)).toEqual({ host: '::1', port: 9200 })
    expect(() => parseHostPort('10.0.0.1:99999', 9100)).toThrow(/Puerto/)
  })

  it('parseUnc', () => {
    expect(parseUnc('\\\\TPV-COCINA\\cocina2')).toEqual({ host: 'TPV-COCINA', share: 'cocina2' })
    expect(parseUnc('C:\\tmp\\x')).toBeNull()
  })
})

describe('send', () => {
  it('envía los bytes por TCP y espera al cierre', async () => {
    const received: Buffer[] = []
    const server = net.createServer((s) => s.on('data', (d) => received.push(d)))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port
    await send({ kind: 'tcp', host: '127.0.0.1', port }, Buffer.from('ticket'))
    await new Promise((r) => setTimeout(r, 50))
    server.close()
    expect(Buffer.concat(received).toString()).toBe('ticket')
  })

  it('explica una conexión rechazada', async () => {
    await expect(send({ kind: 'tcp', host: '127.0.0.1', port: 1 }, Buffer.from('x'))).rejects.toThrow(/rechazada/)
  })

  it('escribe en un fichero', async () => {
    const file = path.join(tempDir(), 'out.bin')
    await send({ kind: 'file', path: file }, Buffer.from([1, 2, 3]))
    expect([...fs.readFileSync(file)]).toEqual([1, 2, 3])
  })
})

describe('runSerial', () => {
  it('mantiene el orden por clave aunque el primero tarde más', async () => {
    const order: string[] = []
    const slow = runSerial('a', async () => {
      await new Promise((r) => setTimeout(r, 40))
      order.push('a1')
    })
    const fast = runSerial('a', async () => {
      order.push('a2')
    })
    const other = runSerial('b', async () => {
      order.push('b1')
    })
    await Promise.all([slow, fast, other])
    expect(order).toEqual(['b1', 'a1', 'a2'])
  })

  it('un fallo no bloquea la cola', async () => {
    await expect(runSerial('c', async () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    await expect(runSerial('c', async () => 'ok')).resolves.toBe('ok')
  })
})
