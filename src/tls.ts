// Certificado HTTPS para la API local (la web del TPV llama a https://127.0.0.1:<puerto>).
//
// En cada equipo se genera una CA propia, se firma con ella el certificado de 127.0.0.1/localhost y
// la clave privada de la CA se descarta en el acto: la CA queda como raíz de confianza de Windows,
// pero nadie (ni quien lea el disco) puede usarla para firmar otros certificados.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import forge from 'node-forge'

export interface TlsFiles {
  dir: string
  caCert: string
  cert: string
  key: string
}

/** Dentro de private/: la clave del servidor no la deben leer los usuarios del equipo. */
export function tlsFiles(dataDir: string): TlsFiles {
  const dir = path.join(dataDir, 'private', 'tls')
  return {
    dir,
    caCert: path.join(dir, 'ca.crt'),
    cert: path.join(dir, 'server.crt'),
    key: path.join(dir, 'server.key')
  }
}

export interface TlsStatus {
  present: boolean
  notAfter: string | null
  caSerial: string | null
  caSubject: string | null
}

export function tlsStatus(files: TlsFiles): TlsStatus {
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(files.cert))
    const ca = new crypto.X509Certificate(fs.readFileSync(files.caCert))
    fs.accessSync(files.key)
    return { present: true, notAfter: cert.validTo, caSerial: ca.serialNumber, caSubject: ca.subject }
  } catch {
    return { present: false, notAfter: null, caSerial: null, caSubject: null }
  }
}

const RENEW_BEFORE_MS = 60 * 24 * 3600 * 1000

export function needsNewCertificate(files: TlsFiles): boolean {
  const st = tlsStatus(files)
  if (!st.present || !st.notAfter) return true
  return new Date(st.notAfter).getTime() - Date.now() < RENEW_BEFORE_MS
}

/** Genera CA + certificado de servidor. Devuelve el número de serie de la CA nueva. */
export function generateCertificates(files: TlsFiles): string {
  const host = os.hostname()
  const now = new Date()

  const caKeys = forgeKeyPair()
  const ca = forge.pki.createCertificate()
  ca.publicKey = caKeys.publicKey
  ca.serialNumber = randomSerial()
  ca.validity.notBefore = new Date(now.getTime() - 3600_000)
  ca.validity.notAfter = addYears(now, 10)
  const caAttrs = [
    { name: 'commonName', value: `TPV Print Service CA (${host})` },
    { name: 'organizationName', value: 'TPV Print Service' }
  ]
  ca.setSubject(caAttrs)
  ca.setIssuer(caAttrs)
  ca.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' }
  ])
  ca.sign(caKeys.privateKey, forge.md.sha256.create())

  const leafKeys = forgeKeyPair()
  const leaf = forge.pki.createCertificate()
  leaf.publicKey = leafKeys.publicKey
  leaf.serialNumber = randomSerial()
  leaf.validity.notBefore = new Date(now.getTime() - 3600_000)
  leaf.validity.notAfter = addYears(now, 5)
  leaf.setSubject([{ name: 'commonName', value: '127.0.0.1' }])
  leaf.setIssuer(caAttrs)
  leaf.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 7, ip: '127.0.0.1' },
        { type: 7, ip: '::1' },
        { type: 2, value: 'localhost' },
        { type: 2, value: host.toLowerCase() }
      ]
    },
    { name: 'authorityKeyIdentifier', keyIdentifier: ca.generateSubjectKeyIdentifier().getBytes() }
  ])
  leaf.sign(caKeys.privateKey, forge.md.sha256.create())

  fs.mkdirSync(files.dir, { recursive: true })
  fs.writeFileSync(files.caCert, forge.pki.certificateToPem(ca))
  fs.writeFileSync(files.cert, forge.pki.certificateToPem(leaf))
  fs.writeFileSync(files.key, forge.pki.privateKeyToPem(leafKeys.privateKey), { mode: 0o600 })
  // caKeys.privateKey no se guarda: sale de memoria al terminar la función.
  return new crypto.X509Certificate(fs.readFileSync(files.caCert)).serialNumber
}

/** Añade la CA a "Entidades de certificación raíz de confianza" del equipo (requiere administrador). */
export async function trustCa(files: TlsFiles): Promise<void> {
  if (process.platform !== 'win32') return
  await run('certutil.exe', ['-addstore', '-f', 'Root', files.caCert])
}

/** Quita del almacén raíz una CA anterior por su número de serie. */
export async function untrustCa(serial: string): Promise<void> {
  if (process.platform !== 'win32' || !/^[0-9A-Fa-f]+$/.test(serial)) return
  await run('certutil.exe', ['-delstore', 'Root', serial]).catch(() => undefined)
}

function forgeKeyPair(): forge.pki.rsa.KeyPair {
  // La generación de claves de node:crypto es nativa y mucho más rápida que la de node-forge.
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const priv = forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()) as forge.pki.rsa.PrivateKey
  const pub = forge.pki.setRsaPublicKey(priv.n, priv.e)
  return { privateKey: priv, publicKey: pub }
}

function randomSerial(): string {
  // Positivo (primer bit a 0) y de 16 bytes, como pide la RFC 5280.
  const b = crypto.randomBytes(16)
  b[0] = b[0]! & 0x7f
  return b.toString('hex')
}

function addYears(d: Date, years: number): Date {
  const r = new Date(d)
  r.setFullYear(r.getFullYear() + years)
  return r
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${cmd} ${args[0]}: ${(stderr || stdout).trim() || err.message}`)) : resolve(stdout)
    )
  })
}
