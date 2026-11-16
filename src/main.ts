// Punto de entrada. Comandos:
//   run                     arranca el agente (lo que ejecuta el servicio de Windows)
//   setup [--port N]        crea la configuración y el certificado HTTPS y confía en su CA (instalador)
//   teardown                quita la CA del almacén de Windows (desinstalador)
//   open-admin              abre el panel en el navegador (acceso directo del menú Inicio)
//   version
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { PrintedJournal } from './agent/journal.js'
import { QueueAgent } from './agent/queue-agent.js'
import { dataDir, loadConfig, saveConfig, validPort, type Config } from './config.js'
import { log } from './log.js'
import { printJob } from './printer.js'
import { createServer } from './server.js'
import { generateCertificates, needsNewCertificate, tlsFiles, tlsStatus, trustCa, untrustCa } from './tls.js'
import { Updater } from './updater.js'
import { PRODUCT, VERSION } from './version.js'
import { warmPrinterCache } from './windows/printers.js'

/** Código de salida con el que el agente pide a WinSW que lo vuelva a arrancar. */
const EXIT_RESTART = 3

async function main(argv: string[]): Promise<void> {
  const [cmd = 'run', ...rest] = argv
  switch (cmd) {
    case 'run':
      return run()
    case 'setup':
      return setup(rest)
    case 'teardown':
      return teardown()
    case 'open-admin':
      return openAdmin()
    case 'version':
    case '--version':
      console.log(VERSION)
      return
    default:
      console.error(`Comando desconocido: ${cmd}\nUso: agent.cjs [run | setup [--port N] | teardown | open-admin | version]`)
      process.exitCode = 2
  }
}

async function run(): Promise<void> {
  let cfg = loadConfig()
  const files = tlsFiles(dataDir())
  log('info', 'sistema', `${PRODUCT} ${VERSION} arrancando (datos en ${dataDir()})`)

  let tls: { key: Buffer; cert: Buffer } | null = null
  if (cfg.https) {
    if (needsNewCertificate(files)) await renewCertificate(files)
    tls = { key: fs.readFileSync(files.key), cert: fs.readFileSync(files.cert) }
  }

  const getConfig = () => cfg
  const journal = new PrintedJournal(path.join(dataDir(), 'printed.json'))
  const agent = new QueueAgent({ getConfig, print: (job) => printJob(job, cfg, undefined, { source: 'cola' }), journal })
  const updater = new Updater(getConfig, () => agent.getStatus().inFlight > 0)

  let stopping = false
  const shutdown = async (code: number, reason: string) => {
    if (stopping) return
    stopping = true
    log('info', 'sistema', `Parando: ${reason}`)
    updater.stop()
    server.close()
    await Promise.race([agent.stop(), new Promise((r) => setTimeout(r, 3000))])
    process.exit(code)
  }

  const server = createServer(
    {
      getConfig,
      saveConfig: (next: Config) => {
        saveConfig(next)
        cfg = next
      },
      print: (job, opts) => printJob(job, cfg, undefined, opts),
      agent,
      updater,
      tls: files,
      requestRestart: (reason) => setTimeout(() => void shutdown(EXIT_RESTART, reason), 300)
    },
    tls
  )

  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      log('error', 'sistema', `El puerto ${cfg.port} está ocupado. ¿Sigue arrancado el servicio de impresión anterior (Python)?`)
    } else {
      log('error', 'sistema', `Error del servidor local: ${e.message}`)
    }
    void shutdown(1, 'no se pudo abrir el puerto')
  })
  server.listen(cfg.port, cfg.listenHost, () => {
    log('info', 'sistema', `API local en ${tls ? 'https' : 'http'}://${cfg.listenHost}:${cfg.port}`)
  })

  warmPrinterCache()
  agent.start()
  updater.start()

  process.on('SIGINT', () => void shutdown(0, 'señal de parada'))
  process.on('SIGTERM', () => void shutdown(0, 'señal de parada'))
  process.on('unhandledRejection', (e) => log('error', 'sistema', `Promesa rechazada sin controlar: ${(e as Error)?.stack ?? e}`))
}

async function setup(args: string[]): Promise<void> {
  const cfg = loadConfig()
  const i = args.indexOf('--port')
  if (i >= 0) {
    const port = Number(args[i + 1])
    if (!validPort(port)) throw new Error(`Puerto no válido: ${args[i + 1]}`)
    cfg.port = port
  }
  saveConfig(cfg)
  const files = tlsFiles(dataDir())
  if (needsNewCertificate(files)) {
    await renewCertificate(files)
  } else {
    await trustCa(files) // idempotente: repara la confianza si alguien quitó la CA
  }
  console.log(`Configuración en ${dataDir()} (puerto ${cfg.port}). Certificado válido hasta ${tlsStatus(files).notAfter}.`)
}

async function teardown(): Promise<void> {
  const st = tlsStatus(tlsFiles(dataDir()))
  if (st.caSerial) await untrustCa(st.caSerial)
  console.log('CA local retirada del almacén de Windows.')
}

async function renewCertificate(files: ReturnType<typeof tlsFiles>): Promise<void> {
  const old = tlsStatus(files).caSerial
  const serial = generateCertificates(files)
  log('info', 'sistema', `Certificado HTTPS generado (CA ${serial})`)
  try {
    await trustCa(files)
    if (old && old !== serial) await untrustCa(old)
  } catch (e) {
    log('warn', 'sistema', `No se pudo registrar la CA en Windows: ${(e as Error).message}`)
  }
}

function openAdmin(): void {
  const cfg = loadConfig()
  const url = `${cfg.https ? 'https' : 'http'}://127.0.0.1:${cfg.port}/admin`
  // Sin `cmd /c start` con windowsHide: el navegador podía abrirse oculto. FileProtocolHandler abre
  // la URL con el navegador predeterminado, como un doble clic en un enlace.
  if (process.platform === 'win32') execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url])
  else if (process.platform === 'darwin') execFile('open', [url])
  else execFile('xdg-open', [url])
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error((e as Error).message ?? e)
  process.exit(1)
})
