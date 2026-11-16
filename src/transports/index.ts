// Decide cómo llega cada trabajo a la impresora y lo envía. Trabajos a la misma impresora salen de
// uno en uno y en orden; impresoras distintas trabajan en paralelo.
import net from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import type { Connection } from '../job.js'
import { JobError } from '../job.js'
import { findLocalPrinterByShare } from '../windows/printers.js'

export type Target =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'file'; path: string }
  | { kind: 'spooler'; printer: string }

const DEFAULT_RAW_PORT = 9100

/**
 * - `lan`, `tcp`, `ip`: "host" o "host:puerto" (9100 por defecto). Directo a la impresora, sin driver.
 * - `windows`: nombre de una impresora instalada en este Windows, por la cola de impresión.
 * - `file`, `usb`, `serial` (lo que hay hoy en la base de datos):
 *     · `\\ESTE-PC\recurso`: se busca la impresora local compartida con ese nombre y se usa su cola.
 *       Así funciona como servicio (LocalSystem), que no puede abrir recursos de red con las
 *       credenciales del usuario. Si no se encuentra, se escribe en la ruta como antes.
 *     · `COM3`: puerto serie.
 *     · cualquier otra ruta: se escribe tal cual.
 */
export async function resolveTarget(conn: Connection): Promise<Target> {
  const params = conn.params
  if (!params) throw new JobError('La conexión de la impresora no tiene parámetros', 400)

  switch (conn.type) {
    case 'lan':
    case 'tcp':
    case 'ip': {
      const { host, port } = parseHostPort(params, DEFAULT_RAW_PORT)
      return { kind: 'tcp', host, port }
    }
    case 'windows':
      return { kind: 'spooler', printer: params }
    case 'file':
    case 'usb':
    case 'serial': {
      if (/^com\d+$/i.test(params)) return { kind: 'file', path: `\\\\.\\${params.toUpperCase()}` }
      const unc = parseUnc(params)
      if (unc && process.platform === 'win32' && isThisMachine(unc.host)) {
        const printer = await findLocalPrinterByShare(unc.share)
        if (printer) return { kind: 'spooler', printer }
      }
      return { kind: 'file', path: params }
    }
    default:
      throw new JobError(`Tipo de conexión desconocido: ${conn.type}`, 400)
  }
}

export function targetKey(t: Target): string {
  switch (t.kind) {
    case 'tcp':
      return `tcp:${t.host.toLowerCase()}:${t.port}`
    case 'file':
      return `file:${t.path.toLowerCase()}`
    case 'spooler':
      return `spooler:${t.printer.toLowerCase()}`
  }
}

export function describeTarget(t: Target): string {
  switch (t.kind) {
    case 'tcp':
      return `${t.host}:${t.port}`
    case 'file':
      return t.path
    case 'spooler':
      return `impresora de Windows «${t.printer}»`
  }
}

const chains = new Map<string, Promise<unknown>>()

/** Ejecuta `fn` cuando haya terminado el trabajo anterior para la misma clave. */
export function runSerial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(fn)
  chains.set(key, next)
  void next
    .finally(() => {
      if (chains.get(key) === next) chains.delete(key)
    })
    .catch(() => undefined)
  return next
}

export async function send(target: Target, data: Buffer): Promise<void> {
  switch (target.kind) {
    case 'tcp':
      return sendTcp(target.host, target.port, data)
    case 'file':
      return sendFile(target.path, data)
    case 'spooler': {
      if (process.platform !== 'win32') throw new JobError('La cola de impresión de Windows solo existe en Windows', 400)
      const { printRaw } = await import('../windows/spooler.js')
      return printRaw(target.printer, data)
    }
  }
}

const TCP_TIMEOUT_MS = 10_000

function sendTcp(host: string, port: number, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    let settled = false
    const fail = (msg: string) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new JobError(`${host}:${port}: ${msg}`))
    }
    socket.setTimeout(TCP_TIMEOUT_MS, () => fail('la impresora no responde (tiempo agotado)'))
    socket.once('error', (e: NodeJS.ErrnoException) => fail(tcpErrorMessage(e)))
    socket.once('connect', () => {
      socket.end(data)
    })
    socket.once('close', (hadError) => {
      if (settled) return
      if (hadError) return fail('conexión cerrada con error')
      settled = true
      resolve()
    })
  })
}

function tcpErrorMessage(e: NodeJS.ErrnoException): string {
  switch (e.code) {
    case 'ECONNREFUSED':
      return 'conexión rechazada (¿puerto correcto?)'
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'no se llega a la impresora (¿encendida y en la red?)'
    case 'ENOTFOUND':
      return 'no se encuentra ese nombre de equipo'
    default:
      return e.message
  }
}

async function sendFile(path: string, data: Buffer): Promise<void> {
  let fh: fs.FileHandle | undefined
  try {
    fh = await fs.open(path, 'w')
    await fh.write(data)
  } catch (e) {
    throw new JobError(`No se pudo escribir en ${path}: ${(e as Error).message}`)
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

export function parseHostPort(value: string, defaultPort: number): { host: string; port: number } {
  const v = value.trim()
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(v) ?? /^([^:]+)(?::(\d+))?$/.exec(v)
  if (!m || !m[1]) throw new JobError(`Dirección de impresora no válida: ${value}`, 400)
  const port = m[2] ? Number(m[2]) : defaultPort
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new JobError(`Puerto no válido: ${value}`, 400)
  return { host: m[1], port }
}

export function parseUnc(value: string): { host: string; share: string } | null {
  const m = /^\\\\([^\\]+)\\([^\\]+)\\?$/.exec(value.trim())
  return m && m[1] && m[2] ? { host: m[1], share: m[2] } : null
}

function isThisMachine(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h === '127.0.0.1' || h === '.') return true
  const names = [os.hostname(), process.env.COMPUTERNAME ?? ''].map((n) => n.toLowerCase()).filter(Boolean)
  return names.some((n) => n === h || n.split('.')[0] === h)
}
