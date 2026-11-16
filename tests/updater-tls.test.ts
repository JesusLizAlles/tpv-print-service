import crypto from 'node:crypto'
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { generateCertificates, needsNewCertificate, tlsFiles, tlsStatus } from '../src/tls.js'
import { compareVersions, findSum, inWindow, parseRelease } from '../src/updater.js'
import { tempDir, testConfig } from './helpers.js'

describe('updater', () => {
  it('compara versiones', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1)
  })

  it('lee la suma del instalador en SHA256SUMS.txt', () => {
    const h = 'a'.repeat(64)
    expect(findSum(`${'b'.repeat(64)}  otro.exe\n${h}  tpv-print-service-0.2.0-setup.exe\n`, 'tpv-print-service-0.2.0-setup.exe')).toBe(h)
    expect(findSum('', 'x')).toBeNull()
  })

  it('exige el instalador y SHA256SUMS.txt en la Release', () => {
    const assets = [
      { name: 'tpv-print-service-0.2.0-setup.exe', browser_download_url: 'https://x/setup.exe' },
      { name: 'SHA256SUMS.txt', browser_download_url: 'https://x/sums' }
    ]
    expect(parseRelease({ tag_name: 'v0.2.0', assets }).installer.url).toBe('https://x/setup.exe')
    expect(() => parseRelease({ tag_name: 'v0.2.0', assets: assets.slice(1) })).toThrow(/no incluye/)
  })

  it('franja horaria, también cruzando la medianoche', () => {
    const at = (h: number) => new Date(2026, 0, 1, h)
    const cfg = testConfig({ updates: { auto: true, windowStart: 4, windowEnd: 6 } })
    expect([3, 4, 5, 6].map((h) => inWindow(at(h), cfg))).toEqual([false, true, true, false])
    const night = testConfig({ updates: { auto: true, windowStart: 23, windowEnd: 2 } })
    expect([22, 23, 0, 1, 2].map((h) => inWindow(at(h), night))).toEqual([false, true, true, true, false])
  })
})

describe('certificado local', () => {
  it('firma el certificado de 127.0.0.1 con una CA propia y no guarda la clave de la CA', () => {
    const files = tlsFiles(tempDir())
    expect(needsNewCertificate(files)).toBe(true)
    generateCertificates(files)
    expect(needsNewCertificate(files)).toBe(false)

    const ca = new crypto.X509Certificate(fs.readFileSync(files.caCert))
    const leaf = new crypto.X509Certificate(fs.readFileSync(files.cert))
    expect(ca.ca).toBe(true)
    expect(leaf.verify(ca.publicKey)).toBe(true)
    expect(leaf.checkIP('127.0.0.1')).toBe('127.0.0.1')
    expect(leaf.checkHost('localhost')).toBe('localhost')
    expect(leaf.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(files.key)))).toBe(true)
    // En la carpeta solo hay una clave privada: la del servidor.
    const keys = fs.readdirSync(files.dir).filter((f) => fs.readFileSync(`${files.dir}/${f}`, 'utf8').includes('PRIVATE KEY'))
    expect(keys).toEqual(['server.key'])
    expect(tlsStatus(files).present).toBe(true)
  })
})
