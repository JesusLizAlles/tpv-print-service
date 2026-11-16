# Prueba completa en Windows (runner de GitHub Actions, como administrador):
#   1. Instala el .exe en silencio y comprueba que el servicio arranca.
#   2. Llama a /health por HTTPS validando el certificado con el almacén de Windows.
#   3. Crea una impresora "Generic / Text Only" en pausa, la comparte como "tickets" e imprime por
#      nombre de Windows y por \\EQUIPO\tickets (lo que hay hoy en la base de datos). Comprueba en el
#      fichero .SPL de la cola que los bytes ESC/POS llegan en bruto.
#      El servicio corre como LocalSystem: así se prueba la cola de Windows con koffi.
#   4. Desinstala y comprueba que no queda el servicio.
param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'

function Wait-Health([int]$Port, [int]$Seconds = 60) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try { return Invoke-RestMethod -Uri "https://127.0.0.1:$Port/health" -TimeoutSec 5 } catch { Start-Sleep -Seconds 2 }
  }
  Get-Content "$env:ProgramData\TPVPrint\logs\*.log" -ErrorAction SilentlyContinue | Select-Object -Last 50
  throw "El agente no responde en https://127.0.0.1:$Port/health (¿certificado no confiable o servicio parado?)"
}

function Send-Job($Connection, [string]$Text) {
  $body = @{ connection = $Connection; action = 'print'; lines = @(@{ type = 'text'; content = "$Text`n" }) } | ConvertTo-Json -Depth 5
  Invoke-RestMethod -Method Post -Uri 'https://127.0.0.1:3000/' -ContentType 'application/json' -Body $body -TimeoutSec 60
}

Write-Host '== Instalación silenciosa'
$p = Start-Process -FilePath $Installer -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/LOG=install.log' -Wait -PassThru
if ($p.ExitCode -ne 0) { Get-Content install.log | Select-Object -Last 40; throw "El instalador devolvió $($p.ExitCode)" }
$svc = Get-Service TPVPrintService
# El instalador termina con el servicio en StartPending; se da hasta 30 s para que pase a Running.
try { $svc.WaitForStatus('Running', [TimeSpan]::FromSeconds(30)) } catch { throw "El servicio sigue en $((Get-Service TPVPrintService).Status)" }
Write-Host "Servicio: $($svc.Status) ($((Get-CimInstance Win32_Service -Filter "Name='TPVPrintService'").StartName))"

Write-Host '== HTTPS con certificado de confianza'
$health = Wait-Health 3000
Write-Host ($health | ConvertTo-Json -Compress)

Write-Host '== Icono de la bandeja'
$tray = "${env:ProgramFiles}\TPV Print Service\tray\TPVPrintTray.exe"
if (-not (Test-Path $tray)) { throw 'No se ha instalado TPVPrintTray.exe' }
$p = Start-Process -FilePath $tray -ArgumentList '--check' -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "TPVPrintTray --check devolvió $($p.ExitCode): el icono no puede leer el estado del agente (TLS, certificado o JSON)" }
if (-not (Get-ScheduledTask -TaskName 'TPVPrintServiceTray' -ErrorAction SilentlyContinue)) { throw 'No se registró la tarea que abre el icono en las sesiones' }
$run = Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run' -Name TPVPrintServiceTray -ErrorAction SilentlyContinue
if (-not $run) { throw 'No se registró el icono en el inicio de sesión (clave Run)' }
Write-Host "Icono: --check correcto; arranque en sesión registrado ($($run.TPVPrintServiceTray))"

Write-Host '== Permisos: credentials y clave TLS fuera del alcance de Usuarios'
$acl = (Get-Acl "$env:ProgramData\TPVPrint\private").Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
if ($acl -contains 'S-1-5-32-545') { throw 'private\ es legible por Usuarios' }

Write-Host '== Impresora de Windows (en pausa: los trabajos se quedan en la cola para leerlos)'
$out = 'C:\tpvprint-e2e\out.prn'
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
Get-Service Spooler | Where-Object Status -ne 'Running' | Start-Service
Add-PrinterDriver -Name 'Generic / Text Only'
Add-PrinterPort -Name $out
Add-Printer -Name 'TPV E2E' -DriverName 'Generic / Text Only' -PortName $out
Set-Printer -Name 'TPV E2E' -Shared $true -ShareName 'tickets'
Get-CimInstance Win32_Printer -Filter "Name='TPV E2E'" | Invoke-CimMethod -MethodName Pause | Out-Null
$spool = Join-Path $env:SystemRoot 'System32\spool\PRINTERS'

function Show-SpoolerState {
  Write-Host '-- Diagnóstico de la cola'
  Get-Printer -Name 'TPV E2E' | Format-List Name, ShareName, PortName, DriverName, PrinterStatus, Datatype | Out-String | Write-Host
  Get-PrintJob -PrinterName 'TPV E2E' -ErrorAction SilentlyContinue | Format-Table Id, DocumentName, Datatype, Size, JobStatus | Out-String | Write-Host
  Get-ChildItem $spool -ErrorAction SilentlyContinue | Format-Table Name, Length, LastWriteTime | Out-String | Write-Host
  Get-WinEvent -LogName 'Microsoft-Windows-PrintService/Admin' -MaxEvents 10 -ErrorAction SilentlyContinue | Format-List TimeCreated, Id, Message | Out-String | Write-Host
}

# El trabajo debe aparecer en la cola de "TPV E2E" con los bytes ESC/POS tal cual (RAW) en su .SPL.
function Assert-Spooled([string]$Marker, [string]$What) {
  $deadline = (Get-Date).AddSeconds(20)
  $found = $false
  do {
    Start-Sleep -Seconds 1
    foreach ($f in Get-ChildItem $spool -Filter '*.SPL' -ErrorAction SilentlyContinue) {
      $bytes = [IO.File]::ReadAllBytes($f.FullName)
      $text = [Text.Encoding]::GetEncoding(28591).GetString($bytes)
      if ($text.Contains($Marker)) {
        if (-not $text.StartsWith([string][char]0x1b + '@')) { Show-SpoolerState; throw "Impresión $What`: los bytes no llegan en bruto (falta ESC @ al principio)" }
        Write-Host "Impresión $What`: $($bytes.Length) bytes en bruto en la cola ($($f.Name))"
        $found = $true
        break
      }
    }
  } while (-not $found -and (Get-Date) -lt $deadline)
  if (-not $found) { Show-SpoolerState; throw "La impresión $What no llegó a la cola de Windows" }
  Get-PrintJob -PrinterName 'TPV E2E' | Remove-PrintJob
  Start-Sleep -Seconds 1
}

$r = Send-Job @{ type = 'windows'; params = 'TPV E2E' } 'POR-NOMBRE'
Write-Host ($r | ConvertTo-Json -Compress)
Assert-Spooled 'POR-NOMBRE' 'por nombre de Windows'

$r = Send-Job @{ type = 'file'; params = "\\$env:COMPUTERNAME\tickets" } 'POR-RECURSO-COMPARTIDO'
Write-Host ($r | ConvertTo-Json -Compress)
Assert-Spooled 'POR-RECURSO-COMPARTIDO' 'por \\EQUIPO\recurso'

Write-Host '== Reinicio del servicio y acentos en el registro'
Restart-Service TPVPrintService
(Get-Service TPVPrintService).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
Wait-Health 3000 | Out-Null
$log = Get-Content "$env:ProgramData\TPVPrint\logs\TPVPrintService.out.log" -Raw -Encoding UTF8
if ($log -notmatch 'señal de parada') { Write-Host $log; throw 'El registro no muestra bien los acentos (se esperaba «señal de parada»)' }
Write-Host 'Registro en UTF-8 correcto tras reiniciar'

Write-Host '== Desinstalación'
$uninstaller = Get-ChildItem "${env:ProgramFiles}\TPV Print Service\unins*.exe" | Select-Object -First 1
$p = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait -PassThru
if (Get-Service TPVPrintService -ErrorAction SilentlyContinue) { throw 'El servicio sigue registrado tras desinstalar' }
if (Get-ScheduledTask -TaskName 'TPVPrintServiceTray' -ErrorAction SilentlyContinue) { throw 'La tarea del icono sigue registrada tras desinstalar' }
if (Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run' -Name TPVPrintServiceTray -ErrorAction SilentlyContinue) { throw 'El icono sigue en el inicio de sesión tras desinstalar' }
Write-Host 'OK'
