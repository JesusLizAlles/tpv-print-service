// La versión la inyecta esbuild desde package.json (scripts/build.mjs). En tests vale 0.0.0-dev.
declare const __APP_VERSION__: string | undefined

export const VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev'
export const PRODUCT = 'TPV Print Service'
/** Repositorio público del que se descargan las actualizaciones */
export const REPO = 'JesusLizAlles/tpv-print-service'
/** Nombre del servicio de Windows (WinSW) */
export const SERVICE_ID = 'TPVPrintService'
