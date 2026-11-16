// Impresoras instaladas en este Windows (nombre, recurso compartido, puerto), leídas con
// PowerShell Get-Printer.
import { execFile } from 'node:child_process'

export interface WindowsPrinter {
  name: string
  shareName: string | null
  shared: boolean
  portName: string
  driverName: string
}

let cache: { at: number; printers: WindowsPrinter[] } | null = null
let refreshing: Promise<WindowsPrinter[]> | null = null
const TTL_MS = 60_000

/**
 * Lista de impresoras. Lanzar PowerShell cuesta 2-4 s, así que ningún ticket lo espera salvo la
 * primera vez: con la lista caducada se devuelve la guardada y se refresca en segundo plano.
 * `force` espera a una lista recién leída (panel, o impresora que no aparece).
 */
export async function listWindowsPrinters(force = false): Promise<WindowsPrinter[]> {
  if (process.platform !== 'win32') return []
  if (!force && cache) {
    if (Date.now() - cache.at >= TTL_MS) void refresh().catch(() => undefined)
    return cache.printers
  }
  return refresh()
}

/** Carga la lista al arrancar el agente, para que el primer ticket no espere. */
export function warmPrinterCache(): void {
  if (process.platform === 'win32') void refresh().catch(() => undefined)
}

function refresh(): Promise<WindowsPrinter[]> {
  refreshing ??= readPrinters()
    .then((printers) => {
      cache = { at: Date.now(), printers }
      return printers
    })
    .finally(() => {
      refreshing = null
    })
  return refreshing
}

async function readPrinters(): Promise<WindowsPrinter[]> {
  const out = await powershell(
    'Get-Printer | Select-Object Name,ShareName,Shared,PortName,DriverName | ConvertTo-Json -Compress'
  )
  const parsed: unknown = out.trim() ? JSON.parse(out) : []
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[]
  return rows.map((r) => ({
    name: String(r.Name ?? ''),
    shareName: r.ShareName ? String(r.ShareName) : null,
    shared: Boolean(r.Shared),
    portName: String(r.PortName ?? ''),
    driverName: String(r.DriverName ?? '')
  }))
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
