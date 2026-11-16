import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, loadConfig, sanitizeConfig, saveConfig } from '../src/config.js'
import { tempDir } from './helpers.js'

let dir: string
beforeEach(() => {
  dir = tempDir()
  process.env.TPVPRINT_DATA = dir
})
afterEach(() => {
  delete process.env.TPVPRINT_DATA
})

describe('config', () => {
  it('sin fichero usa los valores por defecto', () => {
    expect(loadConfig()).toEqual(DEFAULT_CONFIG)
  })

  it('guarda el token aparte, en private/, y lo vuelve a juntar al leer', () => {
    const server = { url: 'https://tpv', agentId: 'ag', token: 'SECRETO', tpvId: 't', tpvName: 'Barra' }
    saveConfig({ ...DEFAULT_CONFIG, port: 3100, server })
    expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).not.toContain('SECRETO')
    expect(fs.readFileSync(path.join(dir, 'private', 'credentials.json'), 'utf8')).toContain('SECRETO')
    expect(loadConfig()).toMatchObject({ port: 3100, server })
  })

  it('al desvincular borra las credenciales', () => {
    saveConfig({ ...DEFAULT_CONFIG, server: { url: 'https://tpv', agentId: 'ag', token: 'x', tpvId: 't', tpvName: '' } })
    saveConfig({ ...DEFAULT_CONFIG, server: null })
    expect(fs.existsSync(path.join(dir, 'private', 'credentials.json'))).toBe(false)
    expect(loadConfig().server).toBeNull()
  })

  it('corrige valores no válidos', () => {
    const c = sanitizeConfig({ port: 0, codepage: 'utf8', maxImageWidth: 10, updates: { windowStart: 30 } })
    expect(c).toMatchObject({ port: 3000, codepage: 'cp858', maxImageWidth: 576, updates: { windowStart: 4 } })
  })
})
