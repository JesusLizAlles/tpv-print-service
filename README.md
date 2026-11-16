# TPV Print Service

Agente de impresión para el TPV de SET Hotels. Se instala en cada PC con TPV como **servicio de
Windows** y sustituye al antiguo `servicio_impresion.py`:

- **API local compatible**: escucha en `https://127.0.0.1:3000` y acepta el mismo JSON que el
  servicio Python (`{ connection, lines, action }`), así que la web del TPV sigue funcionando sin
  cambios. Ahora responde con el error real de la impresora en vez de 200 siempre.
- **Cola del servidor**: recoge él mismo las comandas que Laravel deja en la tabla `impresiones`,
  sin depender de que la web del TPV esté abierta. Confirma cada trabajo después de imprimirlo, así
  que no se pierden ni se imprimen dos veces. Ver [docs/protocolo.md](docs/protocolo.md).
- **Instalador** `.exe` que registra el servicio, genera el certificado HTTPS de `127.0.0.1` y lo
  hace de confianza en Windows. Sin pasos manuales.
- **Icono junto al reloj** en cada sesión de usuario: verde si todo va bien, ámbar si no llega al
  servidor de la cola, rojo si el servicio no responde. Avisa cuando falla una impresión y da acceso
  al panel, a los registros y a reiniciar el servicio.
- **Panel** en `https://127.0.0.1:3000/admin` (solo desde el propio equipo): puerto, vinculación con
  el TPV, prueba de impresora, cajón, actividad y actualizaciones. Se abre con doble clic en el
  icono o desde el menú Inicio → TPV Print Service → Configurar impresión.
- **Vista previa de los tickets**: el panel guarda los últimos 50 trabajos y dibuja cada uno a
  partir de los bytes ESC/POS enviados, tal como saldría de la térmica (imágenes en blanco y negro
  con su tramado, texto a 48 columnas con sus saltos, QR, cortes y cajón), con las líneas recibidas
  y el volcado de bytes. Se descarga como PNG. También previsualiza un JSON pegado a mano.
- **Modo simulación**: durante 30 minutos, 2 u 8 horas no se imprime nada; los trabajos se dan por
  impresos y solo se guardan para la vista previa. El panel y el icono lo avisan mientras dura.
- **Actualización automática** desde las Releases de este repositorio.

Los instaladores están en [Releases](https://github.com/JesusLizAlles/tpv-print-service/releases).

## Instalación

1. Si el equipo tiene el servicio Python, quítalo del arranque y ciérralo: usa el mismo puerto.
2. Ejecuta `tpv-print-service-X.Y.Z-setup.exe` como administrador. Pregunta el puerto (3000 por
   defecto) y al terminar abre el panel.
3. En el panel, **Vincular**: en el admin del TPV, abre el terminal y pulsa «Vincular agente»;
   introduce la dirección del servidor y el código de 6 dígitos.
4. Prueba la impresora desde el panel.

Instalación desatendida: `setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART [/PORT=3000]`.

## Impresoras

El agente acepta los tipos de conexión que ya hay en la base de datos del TPV, y dos nuevos:

| Tipo | Parámetros | Cómo imprime |
|---|---|---|
| `file`, `usb`, `serial` | `\\ESTE-PC\recurso` | Busca la impresora local compartida con ese nombre y le envía los bytes por la cola de Windows (funciona como servicio). Si no la encuentra, escribe en la ruta. |
| | `COM3` | Puerto serie |
| | otra ruta | Escribe en ella |
| `lan`, `ip`, `tcp` | `192.168.1.50` o `192.168.1.50:9100` | Directo a la impresora por TCP. No necesita driver ni recurso compartido. **Recomendado.** |
| `windows` (nuevo) | Nombre de la impresora en Windows | Cola de Windows, datos en bruto (RAW) |
| `preview` (nuevo) | Cualquiera | No imprime: solo guarda el trabajo para la vista previa |

Tipos de línea: `text`, `setJustification` (`left`, `center`, `right`), `url_image` / `image` (PNG o
JPEG por http/https; se reduce al ancho del papel), `qr` / `qr_code`, `feed`, `open_cash`.
`action: "open_cash"` solo abre el cajón.

## Datos en el equipo

`%ProgramData%\TPVPrint\`

| Ruta | Contenido | Permisos |
|---|---|---|
| `config.json` | Puerto, página de códigos, servidor vinculado (sin el token), actualizaciones | Usuarios: lectura |
| `printed.json` | Ids de los últimos 1.000 trabajos impresos de la cola | Usuarios: lectura |
| `logs\agent.log` | Registro del agente en UTF-8 (rota a los 5 MB, guarda 3) | Usuarios: lectura |
| `logs\TPVPrintService.*.log` | Registro de WinSW (arranques, paradas, errores graves) | Usuarios: lectura |
| `updates\` | Instaladores descargados | Usuarios: lectura |
| `private\credentials.json` | Token del agente | Solo SYSTEM y Administradores |
| `private\tls\` | Certificado HTTPS de `127.0.0.1` y su clave | Solo SYSTEM y Administradores |

La CA del certificado se genera en cada equipo y **su clave privada se descarta** tras firmar el
certificado del servidor: queda como raíz de confianza, pero nadie puede usarla para firmar otros.

## Desarrollo

Requiere Node 24.

```bash
npm ci
npm test            # tests (vitest)
npm run typecheck
npm run dev         # compila y arranca el agente en primer plano
```

En Linux/macOS los datos van a `~/.local/share/tpv-print-service` (o a `TPVPRINT_DATA`). Para
probar sin impresora, usa una conexión `file` a un fichero cualquiera.

| Carpeta | |
|---|---|
| `src/escpos/` | Comandos ESC/POS e imágenes a 1 bit |
| `src/job.ts` | Formato de los trabajos y render |
| `src/transports/` | TCP, fichero y cola de Windows |
| `src/windows/` | `winspool.drv` con koffi y lista de impresoras |
| `src/agent/` | Cliente de la cola del servidor |
| `src/server.ts` | API local y panel (`src/admin/index.html`) |
| `src/updater.ts` | Actualizaciones desde GitHub Releases |
| `tray/` | Icono de la bandeja (C# 5, se compila con el .NET Framework de Windows) |
| `installer/` | Inno Setup, configuración del servicio (WinSW) y arranque del icono |
| `scripts/` | Compilación, descarga verificada de Node y WinSW, prueba completa en Windows |

El instalador se compila en Windows (`npm run dist:win`, con Inno Setup 6). Lo hace el CI.

## Versiones

1. Sube `version` en `package.json`, commit y etiqueta `vX.Y.Z`; push con la etiqueta.
2. El CI pasa los tests, compila el instalador, lo prueba en Windows (instala el servicio, comprueba
   HTTPS e imprime por la cola de Windows) y deja una **Release en borrador** con el instalador y
   `SHA256SUMS.txt`.
3. Al publicarla, los agentes la detectan en menos de 6 horas y la instalan en su franja horaria
   (de 4:00 a 6:00 por defecto) cuando no tienen trabajos en curso. Antes de instalar comprueban la
   suma SHA-256.

## Licencia

[MIT](LICENSE)
