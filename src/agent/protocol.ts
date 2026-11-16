// Protocolo entre el agente y Laravel (/api/print-agent/*). Ver docs/protocolo.md.

export interface PairRequest {
  code: string
  machine: string
  version: string
}

export interface PairResponse {
  agent_id: string
  token: string
  tpv_id: string
  tpv_name?: string
}

export interface ClaimRequest {
  /** Máximo de trabajos por respuesta */
  max: number
  /** Segundos que el servidor puede esperar antes de responder con una lista vacía */
  wait: number
}

export interface ClaimedJob {
  id: string
  claim_token: string
  printer_id: string | null
  created_at: string
  /** El mismo JSON que acepta la API local: { connection, lines, action } */
  payload: unknown
}

export interface ClaimResponse {
  jobs: ClaimedJob[]
}

export interface AckRequest {
  id: string
  claim_token: string
  result: 'printed' | 'error'
  error?: string
}

export interface HeartbeatRequest {
  version: string
  machine: string
  uptime: number
  in_flight: number
  printed: number
  failed: number
  last_error: string | null
}

export function parseClaimResponse(v: unknown): ClaimResponse {
  if (typeof v !== 'object' || v === null || !Array.isArray((v as { jobs?: unknown }).jobs)) {
    throw new Error('Respuesta de /claim no válida')
  }
  const jobs = (v as { jobs: unknown[] }).jobs.map((j) => {
    const o = j as Record<string, unknown>
    if (typeof o.id !== 'string' || typeof o.claim_token !== 'string') throw new Error('Trabajo sin id o claim_token')
    let payload = o.payload
    if (typeof payload === 'string') payload = JSON.parse(payload)
    return {
      id: o.id,
      claim_token: o.claim_token,
      printer_id: typeof o.printer_id === 'string' ? o.printer_id : null,
      created_at: typeof o.created_at === 'string' ? o.created_at : '',
      payload
    }
  })
  return { jobs }
}

export function parsePairResponse(v: unknown): PairResponse {
  const o = (v ?? {}) as Record<string, unknown>
  for (const k of ['agent_id', 'token', 'tpv_id'] as const) {
    if (typeof o[k] !== 'string' || !o[k]) throw new Error(`Respuesta de vinculación sin ${k}`)
  }
  return {
    agent_id: o.agent_id as string,
    token: o.token as string,
    tpv_id: o.tpv_id as string,
    tpv_name: typeof o.tpv_name === 'string' ? o.tpv_name : undefined
  }
}
