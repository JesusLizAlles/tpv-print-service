// Empaqueta el agente en un único fichero CommonJS: dist/app/agent.cjs.
// koffi queda fuera del bundle porque carga un binario nativo; el instalador copia su carpeta.
import { build } from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))

/** `import x from './fichero?raw'` → el contenido del fichero como texto (igual que en Vite). */
const rawPlugin = {
  name: 'raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (a) => ({
      path: path.resolve(a.resolveDir, a.path.replace(/\?raw$/, '')),
      namespace: 'raw'
    }))
    b.onLoad({ filter: /.*/, namespace: 'raw' }, async (a) => ({
      contents: await fs.readFile(a.path, 'utf8'),
      loader: 'text'
    }))
  }
}

await build({
  entryPoints: [path.join(root, 'src/main.ts')],
  outfile: path.join(root, 'dist/app/agent.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['koffi'],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [rawPlugin],
  sourcemap: false,
  legalComments: 'external',
  logLevel: 'info'
})
