import { describe, expect, it } from 'vitest'
import { JobError, parseJob, renderJob } from '../src/job.js'
import { makePng } from './helpers.js'

const base = { connection: { type: 'FILE', params: ' \\\\PC\\tickets ' }, lines: [] }

describe('parseJob', () => {
  it('acepta el formato del TPV y normaliza la conexión', () => {
    const job = parseJob({ ...base, lines: [{ type: 'text', content: 'hola' }], action: 'print' })
    expect(job.connection).toEqual({ type: 'file', params: '\\\\PC\\tickets' })
    expect(job.action).toBe('print')
  })

  it('action es opcional (print) y content null pasa a cadena vacía', () => {
    const job = parseJob({ ...base, lines: [{ type: 'text', content: null }] })
    expect(job.action).toBe('print')
    expect(job.lines[0]!.content).toBe('')
  })

  it.each([
    [null, /objeto JSON/],
    [{ lines: [] }, /connection/],
    [{ ...base, action: 'borrar' }, /Acción desconocida/],
    [{ ...base, lines: 'x' }, /lista/]
  ])('rechaza %j', (input, msg) => {
    expect(() => parseJob(input)).toThrow(msg)
    try {
      parseJob(input)
    } catch (e) {
      expect((e as JobError).status).toBe(400)
    }
  })
})

describe('renderJob', () => {
  const opts = { codepage: 'cp858' as const, maxImageWidth: 576, fetchImage: async () => makePng(16, 2) }

  it('open_cash solo envía el pulso del cajón, sin cortar', async () => {
    const out = await renderJob(parseJob({ ...base, action: 'open_cash' }), opts)
    expect([...out]).toEqual([0x1b, 0x40, 0x1b, 0x74, 19, 0x1b, 0x70, 0x00, 0x19, 0xfa])
  })

  it('centra por defecto, aplica setJustification, imprime imágenes y corta al final', async () => {
    const out = await renderJob(
      parseJob({
        ...base,
        lines: [
          { type: 'url_image', content: 'https://tpv/ticket/1/image' },
          { type: 'setJustification', content: 'right' },
          { type: 'text', content: 'Total 3,00 €\n' },
          { type: 'tipo_desconocido', content: 'x' }
        ]
      }),
      opts
    )
    expect(out.subarray(5, 8)).toEqual(Buffer.from([0x1b, 0x61, 1]))
    expect(out.includes(Buffer.from([0x1d, 0x76, 0x30, 0x00, 2, 0, 2, 0]))).toBe(true)
    expect(out.includes(Buffer.from([0x1b, 0x61, 2]))).toBe(true)
    expect(out.subarray(-3)).toEqual(Buffer.from([0x1d, 0x56, 0x00]))
  })

  it('un fallo al descargar la imagen hace fallar el trabajo', async () => {
    const failing = { ...opts, fetchImage: async () => Promise.reject(new JobError('404')) }
    await expect(renderJob(parseJob({ ...base, lines: [{ type: 'url_image', content: 'https://x' }] }), failing)).rejects.toThrow('404')
  })
})
