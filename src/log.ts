// Registro: cada línea va a la salida estándar (WinSW la guarda y rota en %ProgramData%\TPVPrint\logs)
// y las últimas 300 quedan en memoria para la pantalla de actividad del panel.
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
  if (level === 'error') console.error(line)
  else console.log(line)
}

export function recentActivity(limit = 100): ActivityEntry[] {
  return ring.slice(-limit).reverse()
}
