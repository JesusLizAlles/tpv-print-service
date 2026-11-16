// Registro: cada línea va a la salida estándar (WinSW la guarda y rota en %ProgramData%\TPVPrint\logs)
// y las últimas 300 quedan en memoria para la pantalla de actividad del panel.
import iconv from 'iconv-lite'
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

export function log(level: Level, source: Source, message: string): void {
  const entry: ActivityEntry = { at: new Date().toISOString(), level, source, message }
  ring.push(entry)
  if (ring.length > MAX) ring.shift()
  const line = `${entry.at} ${level.toUpperCase().padEnd(5)} [${source}] ${message}`
  write(level === 'error' ? process.stderr : process.stdout, line)
}

/** WinSW interpreta la salida del proceso como Windows-1252 y la guarda en UTF-8: como servicio se
 *  escribe en 1252 para que «señal» no acabe como «seÃ±al». En una consola, UTF-8 normal. */
const ANSI_OUTPUT = process.platform === 'win32' && !process.stdout.isTTY

function write(stream: NodeJS.WriteStream, line: string): void {
  if (ANSI_OUTPUT) stream.write(iconv.encode(line + '\r\n', 'win1252'))
  else stream.write(line + '\n')
}

export function recentActivity(limit = 100): ActivityEntry[] {
  return ring.slice(-limit).reverse()
}
