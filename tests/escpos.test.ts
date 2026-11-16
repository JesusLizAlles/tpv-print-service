import { describe, expect, it } from 'vitest'
import { EscPosEncoder } from '../src/escpos/encoder.js'
import { decodeImage, fitWidth, imageToRaster, toRaster } from '../src/escpos/image.js'
import { makePng } from './helpers.js'

describe('EscPosEncoder', () => {
  it('inicializa y selecciona la página de códigos PC858', () => {
    expect([...new EscPosEncoder('cp858').initialize().encode()]).toEqual([0x1b, 0x40, 0x1b, 0x74, 19])
  })

  it('codifica acentos, ñ y € en PC858', () => {
    const bytes = new EscPosEncoder('cp858').text('ñÑáé€').encode()
    expect([...bytes]).toEqual([0xa4, 0xa5, 0xa0, 0x82, 0xd5])
  })

  it('quita caracteres de control que la impresora tomaría como comandos', () => {
    const bytes = new EscPosEncoder().text('a\u001bb\r\nc').encode()
    expect(bytes.toString('latin1')).toBe('ab\nc')
  })

  it('abre el cajón con el mismo pulso que python-escpos', () => {
    expect([...new EscPosEncoder().openCashDrawer().encode()]).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa])
  })

  it('avanza y corta', () => {
    expect([...new EscPosEncoder().cut().encode()]).toEqual([0x1b, 0x64, 6, 0x1d, 0x56, 0x00])
  })

  it('genera un QR nativo con la longitud correcta', () => {
    const data = 'https://example.com/ticket/123'
    const bytes = new EscPosEncoder().qr(data).encode()
    const store = bytes.indexOf(Buffer.from([0x1d, 0x28, 0x6b]), 20)
    const len = data.length + 3
    expect(bytes[store + 3]).toBe(len & 0xff)
    expect(bytes[store + 4]).toBe(len >> 8)
    expect(bytes.includes(Buffer.from(data))).toBe(true)
  })

  it('divide las imágenes altas en bandas', () => {
    const raster = toRaster({ width: 16, height: 600, data: new Float32Array(16 * 600).fill(0) }, false)
    const bytes = new EscPosEncoder().image(raster).encode()
    const header = Buffer.from([0x1d, 0x76, 0x30, 0x00])
    let count = 0
    for (let i = bytes.indexOf(header); i >= 0; i = bytes.indexOf(header, i + 1)) count++
    expect(count).toBe(3) // 256 + 256 + 88 filas
    expect(bytes.length).toBe(3 * 8 + 600 * 2)
  })
})

describe('imagen', () => {
  it('decodifica PNG y reduce al ancho del papel sin ampliar', () => {
    const big = decodeImage(makePng(1152, 20))
    expect(fitWidth(big, 576)).toMatchObject({ width: 576, height: 10 })
    const small = decodeImage(makePng(300, 20))
    expect(fitWidth(small, 576).width).toBe(300)
  })

  it('negro a la izquierda, blanco a la derecha, bit 7 = primer píxel', () => {
    const r = imageToRaster(makePng(16, 1), 576, false)
    expect(r.bytesPerRow).toBe(2)
    expect([...r.bits]).toEqual([0xff, 0x00])
  })

  it('rechaza formatos que no son PNG ni JPEG', () => {
    expect(() => decodeImage(Buffer.from('GIF89a......'))).toThrow(/Formato de imagen no admitido/)
  })
})
