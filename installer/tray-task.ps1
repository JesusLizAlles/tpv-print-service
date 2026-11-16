# Arranca el icono de la bandeja en las sesiones de usuario abiertas.
#
# El instalador (y la actualización automática, que corre como SYSTEM) no puede abrir programas en
# el escritorio de los usuarios. Una tarea programada con el grupo Usuarios como principal sí: al
# ejecutarla se lanza en la sesión de cada usuario conectado. El arranque en cada inicio de sesión
# lo hace la clave Run de HKLM que crea el instalador; el icono evita duplicados con un mutex.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$name = 'TPVPrintServiceTray'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  exit 0
}

$action = New-ScheduledTaskAction -Execute $Exe
$principal = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $name
