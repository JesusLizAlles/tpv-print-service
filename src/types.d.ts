// Ficheros importados como texto (esbuild en scripts/build.mjs; Vite/Vitest de forma nativa).
declare module '*?raw' {
  const content: string
  export default content
}
