// Convierte un PNG o JPEG en una imagen de 1 bit lista para GS v 0: escala de grises sobre fondo
// blanco, reducción al ancho del papel y difuminado Floyd-Steinberg (lo mismo que hacía PIL en el
// servicio Python al convertir a modo '1').
import { PNG } from 'pngjs'
import jpeg from 'jpeg-js'

export interface RasterImage {
  width: number
  height: number
  bytesPerRow: number
  /** Filas empaquetadas, bit 7 = píxel más a la izquierda, 1 = negro. */
  bits: Uint8Array
}

interface Gray {
  width: number
  height: number
  /** 0 = negro, 255 = blanco */
  data: Float32Array
}

const MAX_PIXELS = 4096 * 8192

export function decodeImage(buf: Buffer): Gray {
  let width: number
  let height: number
  let rgba: Uint8Array
  if (isPng(buf)) {
    const png = PNG.sync.read(buf)
    ;({ width, height } = png)
    rgba = png.data
  } else if (isJpeg(buf)) {
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 })
    ;({ width, height } = img)
    rgba = img.data
  } else {
    throw new Error('Formato de imagen no admitido (solo PNG y JPEG)')
  }
  if (width * height > MAX_PIXELS) throw new Error(`Imagen demasiado grande (${width}×${height})`)

  const data = new Float32Array(width * height)
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    const a = rgba[p + 3]! / 255
    const lum = 0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]!
    data[i] = lum * a + 255 * (1 - a) // la transparencia se imprime como papel
  }
  return { width, height, data }
}

/** Reduce por promedio de área. Nunca amplía: una imagen estrecha se imprime a su tamaño. */
export function fitWidth(img: Gray, maxWidth: number): Gray {
  if (img.width <= maxWidth) return img
  const scale = maxWidth / img.width
  const width = maxWidth
  const height = Math.max(1, Math.round(img.height * scale))
  const out = new Float32Array(width * height)
  const sx = img.width / width
  const sy = img.height / height
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx))
      let sum = 0
      let n = 0
      for (let yy = y0; yy < y1 && yy < img.height; yy++) {
        for (let xx = x0; xx < x1 && xx < img.width; xx++) {
          sum += img.data[yy * img.width + xx]!
          n++
        }
      }
      out[y * width + x] = n ? sum / n : 255
    }
  }
  return { width, height, data: out }
}

export function toRaster(img: Gray, dither = true): RasterImage {
  const { width, height } = img
  const data = Float32Array.from(img.data)
  const bytesPerRow = Math.ceil(width / 8)
  const bits = new Uint8Array(bytesPerRow * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const old = data[i]!
      const black = old < 128
      if (black) bits[y * bytesPerRow + (x >> 3)]! |= 0x80 >> (x & 7)
      if (!dither) continue
      const err = old - (black ? 0 : 255)
      if (x + 1 < width) data[i + 1]! += (err * 7) / 16
      if (y + 1 < height) {
        if (x > 0) data[i + width - 1]! += (err * 3) / 16
        data[i + width]! += (err * 5) / 16
        if (x + 1 < width) data[i + width + 1]! += err / 16
      }
    }
  }
  return { width, height, bytesPerRow, bits }
}

export function imageToRaster(buf: Buffer, maxWidth: number, dither = true): RasterImage {
  return toRaster(fitWidth(decodeImage(buf), maxWidth), dither)
}

function isPng(b: Buffer): boolean {
  return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
}

function isJpeg(b: Buffer): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
}
