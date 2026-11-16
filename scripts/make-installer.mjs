// Prepara build/stage con lo que se instala y compila el instalador con Inno Setup (ISCC):
//   dist/tpv-print-service-<versión>-setup.exe
// Requiere Windows con Inno Setup 6 (ISCC en el PATH, en la variable ISCC o en su ruta por defecto).
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const stage = path.join(root, 'build', 'stage')
const deps = path.join(root, 'build', 'win-deps')

await fs.rm(stage, { recursive: true, force: true })
await fs.mkdir(path.join(stage, 'node'), { recursive: true })
await fs.mkdir(path.join(stage, 'app', 'node_modules', '@koromix'), { recursive: true })

await fs.copyFile(path.join(deps, 'node.exe'), path.join(stage, 'node', 'node.exe'))
await fs.copyFile(path.join(deps, 'WinSW-x64.exe'), path.join(stage, 'TPVPrintService.exe'))
await fs.copyFile(path.join(root, 'installer', 'TPVPrintService.xml'), path.join(stage, 'TPVPrintService.xml'))
await fs.copyFile(path.join(root, 'dist', 'app', 'agent.cjs'), path.join(stage, 'app', 'agent.cjs'))
await fs.copyFile(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE.txt'))
await fs.copyFile(path.join(root, 'installer', 'tray-task.ps1'), path.join(stage, 'tray-task.ps1'))
for (const extra of ['agent.cjs.LEGAL.txt']) {
  await fs.copyFile(path.join(root, 'dist', 'app', extra), path.join(stage, 'app', extra)).catch(() => undefined)
}

// koffi: el paquete (JS) y solo el binario de Windows x64.
const koffiNative = path.join(root, 'node_modules', '@koromix', 'koffi-win32-x64')
try {
  await fs.access(koffiNative)
} catch {
  throw new Error('Falta node_modules/@koromix/koffi-win32-x64: hay que ejecutar npm ci en Windows x64')
}
await fs.cp(path.join(root, 'node_modules', 'koffi'), path.join(stage, 'app', 'node_modules', 'koffi'), {
  recursive: true,
  // Solo se omite la documentación: index.cjs carga ./src/koffi/index.cjs en tiempo de ejecución.
  filter: (src) => !src.includes(`${path.sep}koffi${path.sep}doc`)
})
await fs.cp(koffiNative, path.join(stage, 'app', 'node_modules', '@koromix', 'koffi-win32-x64'), { recursive: true })

// Icono de la bandeja: C# 5 con el csc.exe del .NET Framework 4 que trae Windows.
{
  const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  const work = path.join(root, 'build', 'tray')
  await fs.mkdir(work, { recursive: true })
  await fs.mkdir(path.join(stage, 'tray'), { recursive: true })
  const [maj, min, pat] = pkg.version.split('-')[0].split('.')
  const info = path.join(work, 'AssemblyInfo.cs')
  await fs.writeFile(
    info,
    [
      'using System.Reflection;',
      '[assembly: AssemblyTitle("TPV Print Service")]',
      '[assembly: AssemblyProduct("TPV Print Service")]',
      '[assembly: AssemblyCompany("SET Hotels")]',
      `[assembly: AssemblyVersion("${maj}.${min}.${pat}.0")]`,
      `[assembly: AssemblyFileVersion("${maj}.${min}.${pat}.0")]`,
      `[assembly: AssemblyInformationalVersion("${pkg.version}")]`,
      ''
    ].join('\r\n')
  )
  execFileSync(
    csc,
    [
      '/nologo',
      '/codepage:65001',
      '/target:winexe',
      '/optimize+',
      '/platform:anycpu',
      `/out:${path.join(stage, 'tray', 'TPVPrintTray.exe')}`,
      '/r:System.Windows.Forms.dll',
      '/r:System.Drawing.dll',
      '/r:System.Web.Extensions.dll',
      path.join(root, 'tray', 'TPVPrintTray.cs'),
      info
    ],
    { stdio: 'inherit' }
  )
}

function findIscc() {
  if (process.env.ISCC) return process.env.ISCC
  for (const p of ['C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe', 'C:\\Program Files\\Inno Setup 6\\ISCC.exe']) {
    try {
      execFileSync(p, ['/?'], { stdio: 'ignore' })
      return p
    } catch (e) {
      if (e.status !== undefined) return p // existe aunque devuelva código distinto de 0
    }
  }
  return 'ISCC.exe'
}

execFileSync(
  findIscc(),
  [`/DAppVersion=${pkg.version}`, `/DStageDir=${stage}`, `/DOutputDir=${path.join(root, 'dist')}`, path.join(root, 'installer', 'tpvprint.iss')],
  { stdio: 'inherit' }
)
console.log(`Instalador: dist/tpv-print-service-${pkg.version}-setup.exe`)
