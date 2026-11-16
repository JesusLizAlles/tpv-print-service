// Descarga lo que el instalador lleva además del agente, con la suma SHA-256 fijada aquí:
//   - Node.js para Windows x64 (solo node.exe), desde nodejs.org
//   - WinSW, el envoltorio que registra node.exe como servicio de Windows
// Para subir de versión: cambiar la versión y la suma (la de Node está en SHASUMS256.txt de su
// carpeta de descargas; la de WinSW, con sha256sum del .exe descargado).
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const NODE_VERSION = '24.22.1'
const NODE_ZIP_SHA256 = 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5'
export const WINSW_VERSION = '2.12.0'
const WINSW_SHA256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(root, 'build', 'win-deps')

async function download(url, sha256) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const actual = crypto.createHash('sha256').update(buf).digest('hex')
  if (actual !== sha256) throw new Error(`Suma SHA-256 distinta para ${url}\n  esperada ${sha256}\n  obtenida ${actual}`)
  return buf
}

async function exists(p) {
  return fs.access(p).then(() => true, () => false)
}

await fs.mkdir(out, { recursive: true })

const nodeExe = path.join(out, 'node.exe')
if (!(await exists(nodeExe))) {
  const name = `node-v${NODE_VERSION}-win-x64`
  console.log(`Descargando Node.js ${NODE_VERSION}…`)
  const zip = await download(`https://nodejs.org/dist/v${NODE_VERSION}/${name}.zip`, NODE_ZIP_SHA256)
  const tmp = path.join(out, 'tmp')
  await fs.rm(tmp, { recursive: true, force: true })
  await fs.mkdir(tmp, { recursive: true })
  const zipFile = path.join(tmp, `${name}.zip`)
  await fs.writeFile(zipFile, zip)
  // tar (bsdtar) de Windows 10+ abre zip; en Linux se usa unzip.
  if (process.platform === 'win32') execFileSync('tar', ['-xf', zipFile, '-C', tmp, `${name}/node.exe`])
  else execFileSync('unzip', ['-q', zipFile, `${name}/node.exe`, '-d', tmp])
  await fs.rename(path.join(tmp, name, 'node.exe'), nodeExe)
  await fs.rm(tmp, { recursive: true, force: true })
}

const winsw = path.join(out, 'WinSW-x64.exe')
if (!(await exists(winsw))) {
  console.log(`Descargando WinSW ${WINSW_VERSION}…`)
  const exe = await download(`https://github.com/winsw/winsw/releases/download/v${WINSW_VERSION}/WinSW-x64.exe`, WINSW_SHA256)
  await fs.writeFile(winsw, exe)
}

console.log(`Dependencias de Windows listas en ${path.relative(root, out)}`)
