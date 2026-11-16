# Prueba completa en Windows (runner de GitHub Actions, como administrador):
#   1. Instala el .exe en silencio y comprueba que el servicio arranca.
#   2. Llama a /health por HTTPS validando el certificado con el almacén de Windows.
#   3. Crea una impresora "Generic / Text Only" con puerto a fichero, la comparte como "tickets"
#      e imprime por nombre de Windows y por \\EQUIPO\tickets (lo que hay hoy en la base de datos).
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
if ($svc.Status -ne 'Running') { throw "El servicio está $($svc.Status)" }
Write-Host "Servicio: $($svc.Status) ($((Get-CimInstance Win32_Service -Filter "Name='TPVPrintService'").StartName))"

Write-Host '== HTTPS con certificado de confianza'
$health = Wait-Health 3000
Write-Host ($health | ConvertTo-Json -Compress)

Write-Host '== Permisos: credentials y clave TLS fuera del alcance de Usuarios'
$acl = (Get-Acl "$env:ProgramData\TPVPrint\private").Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
if ($acl -contains 'S-1-5-32-545') { throw 'private\ es legible por Usuarios' }

Write-Host '== Impresora de Windows con puerto a fichero'
$out = 'C:\tpvprint-e2e\out.prn'
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
Get-Service Spooler | Where-Object Status -ne 'Running' | Start-Service
Add-PrinterDriver -Name 'Generic / Text Only'
Add-PrinterPort -Name $out
Add-Printer -Name 'TPV E2E' -DriverName 'Generic / Text Only' -PortName $out
Set-Printer -Name 'TPV E2E' -Shared $true -ShareName 'tickets'

$r = Send-Job @{ type = 'windows'; params = 'TPV E2E' } 'POR-NOMBRE'
Write-Host ($r | ConvertTo-Json -Compress)
Start-Sleep -Seconds 3
$r = Send-Job @{ type = 'file'; params = "\\$env:COMPUTERNAME\tickets" } 'POR-RECURSO-COMPARTIDO'
Write-Host ($r | ConvertTo-Json -Compress)

$deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Seconds 2
  $content = if (Test-Path $out) { [IO.File]::ReadAllText($out, [Text.Encoding]::GetEncoding(28591)) } else { '' }
} while ((-not ($content.Contains('POR-NOMBRE') -and $content.Contains('POR-RECURSO-COMPARTIDO'))) -and (Get-Date) -lt $deadline)
if (-not $content.Contains('POR-NOMBRE')) { throw 'La impresión por nombre de Windows no llegó al puerto' }
if (-not $content.Contains('POR-RECURSO-COMPARTIDO')) { throw 'La impresión por \\EQUIPO\recurso no llegó al puerto' }
if (-not $content.StartsWith([string][char]0x1b + '@')) { throw 'Los bytes no llegan en bruto (falta ESC @ al principio)' }
Write-Host "Recibidos $($content.Length) bytes en $out"

Write-Host '== Desinstalación'
$uninstaller = Get-ChildItem "${env:ProgramFiles}\TPV Print Service\unins*.exe" | Select-Object -First 1
$p = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait -PassThru
if (Get-Service TPVPrintService -ErrorAction SilentlyContinue) { throw 'El servicio sigue registrado tras desinstalar' }
Write-Host 'OK'
