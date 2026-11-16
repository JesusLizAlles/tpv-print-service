import { describe, expect, it } from 'vitest'
import { decodeEscPos, type PreviewOp } from '../src/escpos/decoder.js'
import { EscPosEncoder } from '../src/escpos/encoder.js'
import { toRaster } from '../src/escpos/image.js'
import { parseJob, renderJob } from '../src/job.js'
import { jobHistory, jobTitle } from '../src/history.js'
import { printJob } from '../src/printer.js'
import { makePng, testConfig } from './helpers.js'

const kinds = (ops: PreviewOp[]) => ops.map((o) => o.op)

describe('decodeEscPos', () => {
  it('texto con acentos y € según la página de códigos, con su alineación', () => {
    const bytes = new EscPosEncoder('cp858').initialize().align('center').text('Señor Pérez\n').align('right').text('12,50 €\n').encode()
    const ops = decodeEscPos(bytes).filter((o) => o.op === 'text')
    expect(ops).toEqual([
      { op: 'text', text: 'Señor Pérez', align: 'center', bold: false, size: 1 },
      { op: 'text', text: '12,50 €', align: 'right', bold: false, size: 1 }
    ])
  })

  it('las líneas en blanco se conservan', () => {
    const ops = decodeEscPos(new EscPosEncoder().initialize().text('a\n\nb\n').encode())
    expect(ops.filter((o) => o.op === 'text').map((o) => (o as { text: string }).text)).toEqual(['a', '', 'b'])
  })

  it('imagen raster: junta las bandas en una sola imagen con los mismos bits', () => {
    const raster = toRaster({ width: 16, height: 600, data: new Float32Array(16 * 600).fill(0) }, false)
    const ops = decodeEscPos(new EscPosEncoder().initialize().align('center').image(raster).encode())
    const img = ops.find((o) => o.op === 'image') as Extract<PreviewOp, { op: 'image' }>
    expect(img).toMatchObject({ width: 16, height: 600, bytesPerRow: 2, align: 'center', source: 'raster' })
    expect(Buffer.from(img.bits, 'base64')).toEqual(Buffer.from(raster.bits))
    expect(kinds(ops).filter((k) => k === 'image')).toHaveLength(1)
  })

  it('QR: genera una imagen cuadrada con el tamaño de módulo indicado', () => {
    const ops = decodeEscPos(new EscPosEncoder().initialize().qr('https://ejemplo.com/ticket/1', 4).encode())
    const img = ops.find((o) => o.op === 'image') as Extract<PreviewOp, { op: 'image' }>
    expect(img.source).toBe('qr')
    expect(img.width).toBe(img.height)
    expect(img.width % 4).toBe(0)
  })

  it('corte y cajón', () => {
    expect(kinds(decodeEscPos(new EscPosEncoder().initialize().openCashDrawer().cut().encode()))).toEqual(['drawer', 'feed', 'cut'])
  })

  it('un ticket completo del TPV: imagen, texto y corte', async () => {
    const job = parseJob({
      connection: { type: 'file', params: 'x' },
      lines: [
        { type: 'url_image', content: 'https://tpv/ticket/1/image' },
        { type: 'setJustification', content: 'left' },
        { type: 'text', content: 'Mesa 12\n' }
      ]
    })
    const bytes = await renderJob(job, { codepage: 'cp858', maxImageWidth: 576, fetchImage: async () => makePng(540, 30) })
    expect(kinds(decodeEscPos(bytes))).toEqual(['image', 'text', 'feed', 'cut'])
  })

  it('lo desconocido no rompe el resto', () => {
    const ops = decodeEscPos(Buffer.concat([Buffer.from([0x1b, 0x7e]), Buffer.from('hola\n')]))
    expect(ops[0]).toEqual({ op: 'unknown', bytes: '1b7e' })
    expect(ops[1]).toMatchObject({ op: 'text', text: 'hola' })
  })
})

describe('historial y simulación', () => {
  const job = parseJob({ connection: { type: 'lan', params: '127.0.0.1:1' }, lines: [{ type: 'text', content: 'Mesa 7 · 1 café\n' }] })

  it('en modo simulación no toca la impresora y guarda los bytes', async () => {
    jobHistory.clear()
    const cfg = testConfig({ simulateUntil: new Date(Date.now() + 60_000).toISOString() })
    const r = await printJob(job, cfg, { fetchImage: async () => Buffer.alloc(0) }, { source: 'web' })
    expect(r.simulated).toBe(true)
    const [rec] = jobHistory.list()
    expect(rec).toMatchObject({ ok: true, simulated: true, source: 'web', title: 'Mesa 7 · 1 café' })
    expect(rec!.bytes).toBeGreaterThan(0)
  })

  it('la simulación caducada vuelve a imprimir (y aquí falla porque no hay impresora)', async () => {
    jobHistory.clear()
    const cfg = testConfig({ simulateUntil: new Date(Date.now() - 1000).toISOString() })
    await expect(printJob(job, cfg, { fetchImage: async () => Buffer.alloc(0) }, { source: 'cola' })).rejects.toThrow(/rechazada/)
    expect(jobHistory.list()[0]).toMatchObject({ ok: false, simulated: false, source: 'cola', target: '127.0.0.1:1' })
  })

  it('título del ticket: primera línea de texto con contenido', () => {
    expect(jobTitle(parseJob({ connection: { type: 'x', params: 'x' }, lines: [{ type: 'text', content: '------\n' }, { type: 'text', content: '  Ticket 7165 \n' }] }))).toBe('Ticket 7165')
    expect(jobTitle(parseJob({ connection: { type: 'x', params: 'x' }, action: 'open_cash' }))).toBe('Abrir cajón')
    expect(jobTitle(parseJob({ connection: { type: 'x', params: 'x' }, lines: [{ type: 'text', content: 'COCINA\nMesa 4\n' }] }))).toBe('COCINA')
  })
})
