// Actualizaciones desde las Releases publicadas del repositorio (los borradores no cuentan).
//
// 1. Cada 6 horas (y al pulsar "Buscar actualización") se consulta releases/latest.
// 2. Si hay una versión mayor, se descargan el instalador y SHA256SUMS.txt y se comprueba la suma.
// 3. El instalador se lanza en modo silencioso como tarea programada de SYSTEM: si fuera un proceso
//    hijo del agente, WinSW lo mataría al parar el servicio para sustituir los ficheros.
// Las automáticas solo se instalan dentro de la franja horaria configurada y sin trabajos en curso.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { dataDir, type Config } from './config.js'
import { log } from './log.js'
import { REPO, VERSION } from './version.js'

export interface UpdateInfo {
  version: string
  installer: { name: string; url: string }
  sums: { name: string; url: string }
  notesUrl: string
}

export interface UpdaterStatus {
  current: string
  checkedAt: string | null
  latest: string | null
  available: boolean
  state: 'inactivo' | 'buscando' | 'descargando' | 'instalando' | 'error'
  error: string | null
}

const CHECK_EVERY_MS = 6 * 3600 * 1000
const FIRST_CHECK_MS = 5 * 60 * 1000

export class Updater {
  private timer: NodeJS.Timeout | null = null
  private info: UpdateInfo | null = null
  private status: UpdaterStatus = {
    current: VERSION,
    checkedAt: null,
    latest: null,
    available: false,
    state: 'inactivo',
    error: null
  }

  constructor(
    private readonly getConfig: () => Config,
    private readonly isBusy: () => boolean,
    private readonly http: typeof fetch = fetch
  ) {}

  getStatus(): UpdaterStatus {
    return { ...this.status }
  }

  start(): void {
    const tick = async () => {
      try {
        await this.check()
        const cfg = this.getConfig()
        if (this.status.available && cfg.updates.auto && inWindow(new Date(), cfg) && !this.isBusy()) {
          await this.install()
        }
      } catch {
        // check() e install() ya dejan el error en el estado
      }
    }
    const first = setTimeout(() => void tick(), FIRST_CHECK_MS)
    first.unref()
    this.timer = setInterval(() => void tick(), CHECK_EVERY_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async check(): Promise<UpdaterStatus> {
    this.status.state = 'buscando'
    try {
      const res = await this.http(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `tpv-print-service/${VERSION}` },
        signal: AbortSignal.timeout(20_000)
      })
      if (res.status === 404) {
        this.setChecked(null)
        return this.getStatus()
      }
      if (!res.ok) throw new Error(`GitHub respondió ${res.status}`)
      this.info = parseRelease(await res.json())
      this.setChecked(this.info)
    } catch (e) {
      this.status.state = 'error'
      this.status.error = (e as Error).message
      log('warn', 'actualizacion', `No se pudo buscar actualizaciones: ${this.status.error}`)
    }
    return this.getStatus()
  }

  /** Descarga, verifica y lanza el instalador. El servicio se reinicia solo al terminar. */
  async install(): Promise<void> {
    if (process.platform !== 'win32') throw new Error('Solo se puede instalar en Windows')
    if (!this.info || !this.status.available) throw new Error('No hay ninguna versión nueva')
    const info = this.info
    try {
      this.status.state = 'descargando'
      const dir = path.join(dataDir(), 'updates')
      fs.mkdirSync(dir, { recursive: true })
      const sums = (await this.download(info.sums.url)).toString('utf8')
      const expected = findSum(sums, info.installer.name)
      if (!expected) throw new Error(`${info.installer.name} no aparece en SHA256SUMS.txt`)
      const exe = await this.download(info.installer.url)
      const actual = crypto.createHash('sha256').update(exe).digest('hex')
      if (actual !== expected) throw new Error('La suma SHA-256 del instalador no coincide: descarga descartada')
      const file = path.join(dir, info.installer.name)
      fs.writeFileSync(file, exe)

      this.status.state = 'instalando'
      log('info', 'actualizacion', `Instalando la versión ${info.version}`)
      await launchInstaller(file, path.join(dir, `install-${info.version}.log`))
    } catch (e) {
      this.status.state = 'error'
      this.status.error = (e as Error).message
      log('error', 'actualizacion', `Actualización a ${info.version} fallida: ${this.status.error}`)
      throw e
    }
  }

  private async download(url: string): Promise<Buffer> {
    const res = await this.http(url, {
      headers: { 'user-agent': `tpv-print-service/${VERSION}`, accept: 'application/octet-stream' },
      redirect: 'follow',
      signal: AbortSignal.timeout(300_000)
    })
    if (!res.ok) throw new Error(`Descarga de ${url}: ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  private setChecked(info: UpdateInfo | null): void {
    this.status.checkedAt = new Date().toISOString()
    this.status.latest = info?.version ?? null
    this.status.available = !!info && compareVersions(info.version, VERSION) > 0
    this.status.state = 'inactivo'
    this.status.error = null
    if (this.status.available) log('info', 'actualizacion', `Hay una versión nueva: ${info!.version}`)
  }
}

export function parseRelease(v: unknown): UpdateInfo {
  const r = v as { tag_name?: unknown; html_url?: unknown; assets?: unknown }
  if (typeof r.tag_name !== 'string' || !Array.isArray(r.assets)) throw new Error('Respuesta de GitHub no válida')
  const version = r.tag_name.replace(/^v/, '')
  const assets = r.assets as { name?: unknown; browser_download_url?: unknown }[]
  const pick = (name: string) => {
    const a = assets.find((x) => x.name === name)
    if (!a || typeof a.browser_download_url !== 'string') throw new Error(`La versión ${version} no incluye ${name}`)
    return { name, url: a.browser_download_url }
  }
  return {
    version,
    installer: pick(`tpv-print-service-${version}-setup.exe`),
    sums: pick('SHA256SUMS.txt'),
    notesUrl: typeof r.html_url === 'string' ? r.html_url : ''
  }
}

export function findSum(sums: string, file: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (m && m[2] === file) return m[1]!.toLowerCase()
  }
  return null
}

/** Compara x.y.z numéricamente. Una versión con sufijo (-beta) es menor que la misma sin él. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.split('-', 2)
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  if (x.pre === y.pre) return 0
  if (x.pre === null) return 1
  if (y.pre === null) return -1
  return x.pre < y.pre ? -1 : 1
}

export function inWindow(now: Date, cfg: Config): boolean {
  const h = now.getHours()
  const { windowStart: s, windowEnd: e } = cfg.updates
  return s <= e ? h >= s && h < e : h >= s || h < e
}

const TASK = 'TPVPrintServiceUpdate'

function launchInstaller(file: string, logFile: string): Promise<void> {
  const tr = `"${file}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG="${logFile}"`
  if (tr.length > 261) throw new Error('La ruta del instalador es demasiado larga para schtasks')
  return schtasks(['/Create', '/F', '/TN', TASK, '/SC', 'ONCE', '/ST', '00:00', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/TR', tr]).then(() =>
    schtasks(['/Run', '/TN', TASK])
  )
}

function schtasks(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('schtasks.exe', args, { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(`schtasks ${args[0]}: ${(stderr || stdout).trim() || err.message}`)) : resolve()
    )
  })
}
