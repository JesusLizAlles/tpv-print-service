// Envío de bytes en bruto (datatype RAW) a una impresora de Windows por winspool.drv, con koffi.
// Es lo que hace el "Generic / Text Only" o un `copy /b` a la impresora: el driver no toca los bytes.
// Solo se carga en Windows.
import koffi from 'koffi'
import { JobError } from '../job.js'

const winspool = koffi.load('winspool.drv')
const kernel32 = koffi.load('kernel32.dll')

const DOC_INFO_1W = koffi.struct('DOC_INFO_1W', {
  pDocName: 'str16',
  pOutputFile: 'str16',
  pDatatype: 'str16'
})

const OpenPrinterW = winspool.func('int __stdcall OpenPrinterW(str16 pPrinterName, _Out_ void **phPrinter, void *pDefault)')
const ClosePrinter = winspool.func('int __stdcall ClosePrinter(void *hPrinter)')
const StartDocPrinterW = winspool.func('uint32 __stdcall StartDocPrinterW(void *hPrinter, uint32 Level, DOC_INFO_1W *pDocInfo)')
const EndDocPrinter = winspool.func('int __stdcall EndDocPrinter(void *hPrinter)')
const StartPagePrinter = winspool.func('int __stdcall StartPagePrinter(void *hPrinter)')
const EndPagePrinter = winspool.func('int __stdcall EndPagePrinter(void *hPrinter)')
const WritePrinter = winspool.func('int __stdcall WritePrinter(void *hPrinter, const void *pBuf, uint32 cbBuf, _Out_ uint32 *pcWritten)')
const GetLastError = kernel32.func('uint32 __stdcall GetLastError()')

export function printRaw(printer: string, data: Buffer, docName = 'TPV'): Promise<void> {
  // Las llamadas son síncronas y rápidas (solo encolan en el spooler); se envuelven en una promesa
  // para que el resto del código las trate igual que TCP o fichero.
  return new Promise((resolve, reject) => {
    try {
      printRawSync(printer, data, docName)
      resolve()
    } catch (e) {
      reject(e)
    }
  })
}

function printRawSync(printer: string, data: Buffer, docName: string): void {
  const handle: unknown[] = [null]
  if (!OpenPrinterW(printer, handle, null)) fail(`No se pudo abrir la impresora «${printer}»`)
  const h = handle[0]
  try {
    if (!StartDocPrinterW(h, 1, { pDocName: docName, pOutputFile: null, pDatatype: 'RAW' })) {
      fail(`La impresora «${printer}» no aceptó el trabajo`)
    }
    try {
      if (!StartPagePrinter(h)) fail(`La impresora «${printer}» no aceptó la página`)
      const written = [0]
      const ok = WritePrinter(h, data, data.length, written)
      if (!ok || written[0] !== data.length) fail(`Escritura incompleta en «${printer}» (${written[0]} de ${data.length} bytes)`)
      EndPagePrinter(h)
    } finally {
      EndDocPrinter(h)
    }
  } finally {
    ClosePrinter(h)
  }
}

function fail(message: string): never {
  const code = GetLastError() as number
  throw new JobError(code ? `${message} (error de Windows ${code})` : message)
}
