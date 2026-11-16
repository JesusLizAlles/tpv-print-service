// Ids de trabajos ya impresos (los últimos 1.000), en disco. Si se pierde una confirmación y el
// servidor vuelve a entregar el trabajo, el agente lo reconoce y no lo imprime dos veces.
import fs from 'node:fs'
import path from 'node:path'

const MAX = 1000

export class PrintedJournal {
  private ids: string[] = []
  private set = new Set<string>()

  constructor(private readonly file: string) {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (Array.isArray(data)) {
        this.ids = data.filter((x): x is string => typeof x === 'string').slice(-MAX)
        this.set = new Set(this.ids)
      }
    } catch {
      // sin fichero o corrupto: se empieza vacío
    }
  }

  has(id: string): boolean {
    return this.set.has(id)
  }

  /** Se anota justo después de imprimir y antes de confirmar. Escritura atómica. */
  add(id: string): void {
    if (this.set.has(id)) return
    this.ids.push(id)
    this.set.add(id)
    while (this.ids.length > MAX) this.set.delete(this.ids.shift()!)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.ids))
    fs.renameSync(tmp, this.file)
  }
}
