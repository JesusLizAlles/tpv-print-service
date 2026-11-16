// Impresoras instaladas en este Windows (nombre, recurso compartido, puerto), leídas con
// PowerShell Get-Printer y guardadas un minuto para no lanzar PowerShell en cada ticket.
import { execFile } from 'node:child_process'

export interface WindowsPrinter {
  name: string
  shareName: string | null
  shared: boolean
  portName: string
  driverName: string
}

let cache: { at: number; printers: WindowsPrinter[] } | null = null
const TTL_MS = 60_000

export async function listWindowsPrinters(force = false): Promise<WindowsPrinter[]> {
  if (process.platform !== 'win32') return []
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.printers
  const out = await powershell(
    'Get-Printer | Select-Object Name,ShareName,Shared,PortName,DriverName | ConvertTo-Json -Compress'
  )
  const parsed: unknown = out.trim() ? JSON.parse(out) : []
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[]
  const printers = rows.map((r) => ({
    name: String(r.Name ?? ''),
    shareName: r.ShareName ? String(r.ShareName) : null,
    shared: Boolean(r.Shared),
    portName: String(r.PortName ?? ''),
    driverName: String(r.DriverName ?? '')
  }))
  cache = { at: Date.now(), printers }
  return printers
}

export async function findLocalPrinterByShare(share: string): Promise<string | null> {
  const s = share.toLowerCase()
  const find = (list: WindowsPrinter[]) =>
    list.find((p) => p.shareName?.toLowerCase() === s) ?? list.find((p) => p.name.toLowerCase() === s)
  let hit = find(await listWindowsPrinters())
  if (!hit) hit = find(await listWindowsPrinters(true)) // recién instalada o renombrada
  return hit?.name ?? null
}

function powershell(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout))
    )
  })
}
