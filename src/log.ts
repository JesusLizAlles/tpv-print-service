// Registro del agente. Las últimas 300 líneas quedan en memoria para la pantalla de actividad del
// panel, y cada línea se escribe:
// - como servicio de Windows: en %ProgramData%\TPVPrint\logs\agent.log, en UTF-8, rotando a los
//   5 MB (agent.1.log … agent.3.log). No se usa la salida estándar porque WinSW la decodifica con
//   una página de códigos que cambia de un Windows a otro y estropea los acentos.
// - en una consola o en Linux/macOS: en la salida estándar.
import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from './config.js'

export type Level = 'info' | 'warn' | 'error'
export type Source = 'local' | 'cola' | 'agente' | 'actualizacion' | 'sistema'

export interface ActivityEntry {
  at: string
  level: Level
  source: Source
  message: string
}

const MAX = 300
const ring: ActivityEntry[] = []

const MAX_FILE_BYTES = 5 * 1024 * 1024
const KEEP_FILES = 3
const TO_FILE = process.platform === 'win32' && !process.stdout.isTTY

export function logFile(): string {
  return path.join(dataDir(), 'logs', 'agent.log')
}

export function log(level: Level, source: Source, message: string): void {
  const entry: ActivityEntry = { at: new Date().toISOString(), level, source, message }
  ring.push(entry)
  if (ring.length > MAX) ring.shift()
  const line = `${entry.at} ${level.toUpperCase().padEnd(5)} [${source}] ${message}`
  if (TO_FILE) writeFile(line)
  else (level === 'error' ? process.stderr : process.stdout).write(line + '\n')
}

export function recentActivity(limit = 100): ActivityEntry[] {
  return ring.slice(-limit).reverse()
}

function writeFile(line: string): void {
  const file = logFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch {
      // aún no existe
    }
    if (size > MAX_FILE_BYTES) rotate(file)
    fs.appendFileSync(file, line + '\r\n', 'utf8')
  } catch (e) {
    // Sin registro en disco el agente sigue funcionando; el error queda en el registro de WinSW.
    process.stderr.write(`No se pudo escribir en ${file}: ${(e as Error).message}\n`)
  }
}

function rotate(file: string): void {
  const base = file.replace(/\.log$/, '')
  fs.rmSync(`${base}.${KEEP_FILES}.log`, { force: true })
  for (let i = KEEP_FILES - 1; i >= 1; i--) {
    if (fs.existsSync(`${base}.${i}.log`)) fs.renameSync(`${base}.${i}.log`, `${base}.${i + 1}.log`)
  }
  fs.renameSync(file, `${base}.1.log`)
}
