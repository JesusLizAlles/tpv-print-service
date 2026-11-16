# Protocolo agente ↔ Laravel

El agente recoge los trabajos de la tabla `impresiones` del TPV. Todas las peticiones son `POST` con
JSON a `<servidor>/api/print-agent/*`. Salvo `pair`, llevan `Authorization: Bearer <token>`.

## Estados de un trabajo

| Estado | Significado |
|---|---|
| `pending` | Creado, esperando agente |
| `claimed` | Reservado por un agente hasta `claimed_until` (60 s) |
| `printed` | El agente confirmó la impresión |
| `failed` | Falló 3 veces |
| `expired` | Más de 15 minutos sin imprimirse; ya no se imprime |

- `pending → claimed`: `claim`, con `UPDATE … ORDER BY created_at LIMIT n` atómico.
- `claimed → printed`: `ack` con `result: printed`.
- `claimed → pending`: `ack` con error (reintento a los 5 s y a los 20 s) o reserva vencida.
- `claimed → failed`: tercer error.
- `pending → expired`: más de 15 minutos desde `created_at`.

## `POST /api/print-agent/pair`

Sin autenticación. El código lo genera el admin del TPV («Vincular agente»): 6 dígitos, 10 minutos,
un solo uso. Vincular un agente nuevo a un TPV revoca el anterior.

```json
{ "code": "482913", "machine": "TPV-BAR-01", "version": "0.1.0" }
```
→ `200`
```json
{ "agent_id": "uuid", "token": "…", "tpv_id": "uuid", "tpv_name": "Restaurante" }
```
→ `422` código no válido o caducado.

## `POST /api/print-agent/claim`

Espera hasta `wait` segundos (máximo 25) a que haya trabajos para el TPV del agente. Devuelve en
cuanto hay alguno, o una lista vacía al agotar el tiempo; el agente vuelve a llamar enseguida.

```json
{ "max": 10, "wait": 25 }
```
→ `200`
```json
{ "jobs": [ { "id": "uuid", "claim_token": "…", "printer_id": "uuid", "created_at": "2026-11-16T12:00:00Z",
              "payload": { "connection": { "type": "file", "params": "\\\\PC\\cocina" }, "lines": [], "action": "print" } } ] }
```
`payload` puede venir como objeto o como cadena JSON (la columna es `longtext`).

Un trabajo `claimed` cuya reserva vence vuelve a entregarse, con un `claim_token` nuevo. Si el agente
todavía lo tiene en curso, actualiza el token y no lo imprime otra vez.

## `POST /api/print-agent/ack`

```json
{ "id": "uuid", "claim_token": "…", "result": "printed" }
{ "id": "uuid", "claim_token": "…", "result": "error", "error": "192.168.1.50:9100: la impresora no responde" }
```
→ `200`. `409` si el `claim_token` ya no es el vigente: el agente no insiste.

## `POST /api/print-agent/heartbeat`

Cada 30 s. Sin latido en 90 s, el agente se considera desconectado.

```json
{ "version": "0.1.0", "machine": "TPV-BAR-01", "uptime": 86400, "in_flight": 0,
  "printed": 152, "failed": 1, "last_error": null }
```

## Errores de autenticación

`401` o `403` en cualquier llamada: el agente deja de reclamar y el panel pide volver a vincular.

## Garantías

- **No se pierden trabajos**: solo pasan a `printed` con `ack`. Si el agente cae, la reserva vence y
  el trabajo vuelve a la cola.
- **No se imprimen dos veces**: el agente anota el id en `printed.json` justo después de imprimir y
  antes de confirmar. Si vuelve a recibirlo, solo confirma.
- **Orden**: los trabajos se reservan por `created_at` y el agente imprime de uno en uno por impresora.
