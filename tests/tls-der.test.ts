// Comprobación estricta de los certificados generados, con las reglas que aplica Chromium (Chrome,
// Edge, Brave) y que Windows y OpenSSL no aplican. Si se incumplen, el navegador rechaza el
// certificado con ERR_SSL_SERVER_CERT_BAD_FORMAT aunque Windows lo dé por bueno.
import fs from 'node:fs'
import forge from 'node-forge'
import { describe, expect, it } from 'vitest'
import { CERT_FORMAT, generateCertificates, needsNewCertificate, tlsFiles } from '../src/tls.js'
import { tempDir } from './helpers.js'

const T = forge.asn1.Type
const PRINTABLE = /^[A-Za-z0-9 '()+,\-./:=?]*$/

/** Devuelve las infracciones de DER estricto encontradas en el árbol ASN.1. */
function strictViolations(der: string, path = ''): string[] {
  const problems: string[] = []
  const walk = (node: forge.asn1.Asn1, where: string) => {
    if (node.tagClass === forge.asn1.Class.UNIVERSAL && typeof node.value === 'string') {
      const v = node.value
      switch (node.type) {
        case T.INTEGER:
          if (v.length > 1) {
            const b0 = v.charCodeAt(0)
            const b1 = v.charCodeAt(1)
            if ((b0 === 0x00 && b1 < 0x80) || (b0 === 0xff && b1 >= 0x80)) problems.push(`${where}: INTEGER no mínimo`)
          }
          break
        case T.PRINTABLESTRING:
          if (!PRINTABLE.test(v)) problems.push(`${where}: PrintableString con caracteres no válidos: ${JSON.stringify(v)}`)
          break
        case T.IA5STRING:
          if (/[^\x00-\x7f]/.test(v)) problems.push(`${where}: IA5String no ASCII`)
          break
        case T.UTF8: {
          const bytes = Buffer.from(v, 'binary')
          if (Buffer.from(bytes.toString('utf8'), 'utf8').compare(bytes) !== 0) problems.push(`${where}: UTF8String no válida`)
          break
        }
        case T.BITSTRING: {
          // node-forge deja el contenido original en bitStringContents si lo ha interpretado
          const raw = (node as { bitStringContents?: string }).bitStringContents ?? v
          const unused = raw.charCodeAt(0)
          if (unused > 7) problems.push(`${where}: BIT STRING con ${unused} bits sin usar`)
          else if (unused > 0 && raw.length > 1 && (raw.charCodeAt(raw.length - 1) & ((1 << unused) - 1)) !== 0) {
            problems.push(`${where}: BIT STRING con bits de relleno distintos de 0`)
          }
          break
        }
        case T.OCTETSTRING:
          // Las extensiones van como DER dentro de un OCTET STRING: se revisan también.
          try {
            const inner = forge.asn1.fromDer(v, true)
            walk(inner, `${where}>`)
          } catch {
            // no era DER (p. ej. un identificador de clave)
          }
          break
      }
    }
    if (Array.isArray(node.value)) node.value.forEach((c, i) => walk(c, `${where}/${i}`))
  }
  walk(forge.asn1.fromDer(der, true), path)
  return problems
}

function derOf(file: string): string {
  return forge.pem.decode(fs.readFileSync(file, 'utf8'))[0]!.body
}

describe('certificados válidos para Chromium', () => {
  it.each(['SHCENPC018', 'jesus_liz', 'pos_malibu', 'PC-JESÚS', 'TPV-PONENT'])('nombre de equipo %s', (host) => {
    const files = tlsFiles(tempDir())
    generateCertificates(files, host)
    expect(strictViolations(derOf(files.caCert))).toEqual([])
    expect(strictViolations(derOf(files.cert))).toEqual([])
    // El nombre del equipo se conserva, con acentos, en el nombre de la CA.
    const ca = forge.pki.certificateFromPem(fs.readFileSync(files.caCert, 'utf8'))
    expect(forge.util.decodeUtf8(ca.subject.getField('CN').value)).toBe(`TPV Print Service CA (${host})`)
  })

  it('el número de serie siempre tiene codificación mínima', () => {
    for (let i = 0; i < 20; i++) {
      const files = tlsFiles(tempDir())
      generateCertificates(files, 'x')
      for (const f of [files.caCert, files.cert]) {
        const serial = forge.pki.certificateFromPem(fs.readFileSync(f, 'utf8')).serialNumber
        expect(serial).toMatch(/^[4-7][0-9a-f]{31}$/)
      }
    }
  })

  it('el certificado de formato antiguo se regenera al actualizar', () => {
    const files = tlsFiles(tempDir())
    generateCertificates(files, 'x')
    expect(needsNewCertificate(files)).toBe(false)
    fs.rmSync(`${files.dir}/format`) // como los generados por 0.1.0 y 0.2.0
    expect(needsNewCertificate(files)).toBe(true)
    fs.writeFileSync(`${files.dir}/format`, String(CERT_FORMAT))
    expect(needsNewCertificate(files)).toBe(false)
  })

  it('el validador detecta el fallo de 0.2.0 (guion bajo en PrintableString)', () => {
    const cert = forge.pki.createCertificate()
    const keys = forge.pki.rsa.generateKeyPair(512)
    cert.publicKey = keys.publicKey
    cert.serialNumber = '01'
    cert.setSubject([{ name: 'commonName', value: 'TPV Print Service CA (jesus_liz)' }])
    cert.setIssuer([{ name: 'commonName', value: 'x' }])
    cert.sign(keys.privateKey, forge.md.sha256.create())
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
    expect(strictViolations(der).join()).toMatch(/PrintableString/)
  })
})
