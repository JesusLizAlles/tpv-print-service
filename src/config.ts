// Configuración del agente en %ProgramData%\TPVPrint\config.json (en Linux/macOS, para desarrollo,
// ~/.local/share/tpv-print-service). TPVPRINT_DATA la sustituye en tests y en el servicio.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isCodepage, type CodepageName } from './escpos/encoder.js'

export interface ServerLink {
  /** URL base del TPV, p. ej. https://tpv.ejemplo.com */
  url: string
  agentId: string
  token: string
  tpvId: string
  tpvName: string
}

export interface Config {
  /** Puerto de la API local (la que llama hoy la web del TPV) */
  port: number
  /** 127.0.0.1: solo este equipo. 0.0.0.0 si otro equipo de la red tuviera que imprimir aquí. */
  listenHost: string
  https: boolean
  /** Orígenes que pueden llamar a la API local. ['*'] mantiene el comportamiento del servicio Python. */
  allowedOrigins: string[]
  codepage: CodepageName
  /** Ancho máximo de imagen en puntos: 576 en papel de 80 mm, 384 en 58 mm */
  maxImageWidth: number
  server: ServerLink | null
  updates: {
    auto: boolean
    /** Franja horaria local en la que se instalan las actualizaciones automáticas [inicio, fin) */
    windowStart: number
    windowEnd: number
  }
}

export const DEFAULT_CONFIG: Config = {
  port: 3000,
  listenHost: '127.0.0.1',
  https: true,
  allowedOrigins: ['*'],
  codepage: 'cp858',
  maxImageWidth: 576,
  server: null,
  updates: { auto: true, windowStart: 4, windowEnd: 6 }
}

export function dataDir(): string {
  if (process.env.TPVPRINT_DATA) return process.env.TPVPRINT_DATA
  if (process.platform === 'win32') return path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'TPVPrint')
  return path.join(os.homedir(), '.local', 'share', 'tpv-print-service')
}

export function configPath(): string {
  return path.join(dataDir(), 'config.json')
}

/** Carpeta solo para SYSTEM y Administradores (el instalador fija sus permisos): token y clave TLS. */
export function privateDir(): string {
  return path.join(dataDir(), 'private')
}

function credentialsPath(): string {
  return path.join(privateDir(), 'credentials.json')
}

/**
 * config.json la pueden leer todos los usuarios del equipo (el acceso directo del panel lee el
 * puerto); por eso el token del agente va aparte, en private/credentials.json.
 */
export function loadConfig(): Config {
  const raw = readJson(configPath()) ?? {}
  const creds = readJson(credentialsPath())
  if (isObject(raw) && isObject(raw.server) && isObject(creds)) {
    raw.server = { ...raw.server, agentId: creds.agentId, token: creds.token }
  }
  return sanitizeConfig(raw)
}

export function saveConfig(cfg: Config): void {
  if (cfg.server) {
    writeJsonAtomic(credentialsPath(), { agentId: cfg.server.agentId, token: cfg.server.token })
  } else {
    fs.rmSync(credentialsPath(), { force: true })
  }
  const { token: _t, agentId: _a, ...publicServer } = cfg.server ?? { token: '', agentId: '' }
  writeJsonAtomic(configPath(), { ...cfg, server: cfg.server ? publicServer : null })
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    // EACCES es normal en private/ cuando lee un usuario sin privilegios (acceso directo del panel)
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') {
      console.error(`${path.basename(file)} no se pudo leer: ${(e as Error).message}`)
    }
    return null
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function sanitizeConfig(input: unknown): Config {
  const r = isObject(input) ? input : {}
  const d = DEFAULT_CONFIG
  const updates = isObject(r.updates) ? r.updates : {}
  return {
    port: validPort(r.port) ? (r.port as number) : d.port,
    listenHost: typeof r.listenHost === 'string' && r.listenHost ? r.listenHost : d.listenHost,
    https: typeof r.https === 'boolean' ? r.https : d.https,
    allowedOrigins:
      Array.isArray(r.allowedOrigins) && r.allowedOrigins.every((o) => typeof o === 'string')
        ? (r.allowedOrigins as string[])
        : d.allowedOrigins,
    codepage: isCodepage(r.codepage) ? r.codepage : d.codepage,
    maxImageWidth:
      Number.isInteger(r.maxImageWidth) && (r.maxImageWidth as number) >= 128 && (r.maxImageWidth as number) <= 2048
        ? (r.maxImageWidth as number)
        : d.maxImageWidth,
    server: sanitizeServer(r.server),
    updates: {
      auto: typeof updates.auto === 'boolean' ? updates.auto : d.updates.auto,
      windowStart: validHour(updates.windowStart) ? (updates.windowStart as number) : d.updates.windowStart,
      windowEnd: validHour(updates.windowEnd) ? (updates.windowEnd as number) : d.updates.windowEnd
    }
  }
}

function sanitizeServer(v: unknown): ServerLink | null {
  if (!isObject(v)) return null
  const keys = ['url', 'agentId', 'token', 'tpvId'] as const
  if (!keys.every((k) => typeof v[k] === 'string' && v[k])) return null
  return {
    url: String(v.url).replace(/\/+$/, ''),
    agentId: String(v.agentId),
    token: String(v.token),
    tpvId: String(v.tpvId),
    tpvName: typeof v.tpvName === 'string' ? v.tpvName : ''
  }
}

export function validPort(v: unknown): boolean {
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535
}

function validHour(v: unknown): boolean {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 24
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
