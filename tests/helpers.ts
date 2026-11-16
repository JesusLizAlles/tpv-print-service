import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import { DEFAULT_CONFIG, type Config } from '../src/config.js'

export function tempDir(prefix = 'tpvprint-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, https: false, ...overrides }
}

/** PNG de `width`×`height`: mitad izquierda negra, mitad derecha blanca. */
export function makePng(width: number, height: number): Buffer {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const v = x < width / 2 ? 0 : 255
      png.data[i] = v
      png.data[i + 1] = v
      png.data[i + 2] = v
      png.data[i + 3] = 255
    }
  }
  return PNG.sync.write(png)
}
