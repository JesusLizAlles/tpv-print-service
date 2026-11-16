import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { log, recentActivity } from '../src/log.js'
import { tempDir } from './helpers.js'

beforeEach(() => {
  process.env.TPVPRINT_DATA = tempDir()
})
afterEach(() => {
  delete process.env.TPVPRINT_DATA
})

describe('log', () => {
  it('guarda la actividad reciente, la más nueva primero', () => {
    log('info', 'sistema', 'primera')
    log('warn', 'cola', 'señal de prueba')
    const [last] = recentActivity(1)
    expect(last).toMatchObject({ level: 'warn', source: 'cola', message: 'señal de prueba' })
  })

  it('fuera de Windows no crea agent.log', () => {
    log('info', 'sistema', 'x')
    expect(fs.existsSync(`${process.env.TPVPRINT_DATA}/logs/agent.log`)).toBe(process.platform === 'win32' && !process.stdout.isTTY)
  })
})
