; Instalador de TPV Print Service (Inno Setup 6).
; Lo compila scripts/make-installer.mjs, que define AppVersion, StageDir y OutputDir.
;
; Instalación silenciosa (la usa la actualización automática):
;   tpv-print-service-X.Y.Z-setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART [/PORT=3000]
; En una actualización se conserva la configuración (puerto, vinculación) y no se pregunta nada.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef StageDir
  #define StageDir "..\build\stage"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist"
#endif

#define AppName "TPV Print Service"
#define ServiceId "TPVPrintService"
#define ServiceExe "TPVPrintService.exe"
#define DataDir "{commonappdata}\TPVPrint"

[Setup]
AppId={{1102425C-EB60-45A7-8C15-41C3BC83FF7F}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=SET Hotels
AppPublisherURL=https://github.com/JesusLizAlles/tpv-print-service
AppSupportURL=https://github.com/JesusLizAlles/tpv-print-service/issues
DefaultDirName={autopf}\TPV Print Service
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=no
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=tpv-print-service-{#AppVersion}-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
SetupLogging=yes
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\node\node.exe
LicenseFile={#StageDir}\LICENSE.txt

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"

[Dirs]
Name: "{#DataDir}"
Name: "{#DataDir}\private"
Name: "{#DataDir}\logs"
Name: "{#DataDir}\updates"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\TPV Print Service\Configurar impresión"; Filename: "{app}\node\node.exe"; Parameters: """{app}\app\agent.cjs"" open-admin"; WorkingDir: "{app}\app"; IconFilename: "{sys}\shell32.dll"; IconIndex: 16; Flags: runminimized

[Run]
; Permisos de los datos (SID, para que funcione con Windows en cualquier idioma):
;   TPVPrint\          SYSTEM y Administradores: control total; Usuarios: solo lectura
;   TPVPrint\private\  solo SYSTEM y Administradores (token del agente y clave TLS)
Filename: "{sys}\icacls.exe"; Parameters: """{#DataDir}"" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-32-545:(OI)(CI)RX"; Flags: runhidden waituntilterminated; StatusMsg: "Ajustando permisos…"
Filename: "{sys}\icacls.exe"; Parameters: """{#DataDir}\private"" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F"; Flags: runhidden waituntilterminated
; Configuración, certificado HTTPS y confianza en su CA.
Filename: "{app}\node\node.exe"; Parameters: """{app}\app\agent.cjs"" setup {code:PortArg}"; WorkingDir: "{app}\app"; Flags: runhidden waituntilterminated; StatusMsg: "Generando la configuración y el certificado…"
; Registrar (solo la primera vez) y arrancar el servicio.
Filename: "{app}\{#ServiceExe}"; Parameters: "install"; Flags: runhidden waituntilterminated; Check: not ServiceInstalled; StatusMsg: "Registrando el servicio…"
Filename: "{app}\{#ServiceExe}"; Parameters: "start"; Flags: runhidden waituntilterminated; StatusMsg: "Arrancando el servicio…"
Filename: "{app}\node\node.exe"; Parameters: """{app}\app\agent.cjs"" open-admin"; WorkingDir: "{app}\app"; Description: "Abrir el panel de configuración"; Flags: postinstall nowait skipifsilent runhidden

[UninstallRun]
Filename: "{app}\{#ServiceExe}"; Parameters: "stopwait"; Flags: runhidden waituntilterminated; RunOnceId: "StopService"
Filename: "{app}\{#ServiceExe}"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "UninstallService"
Filename: "{app}\node\node.exe"; Parameters: """{app}\app\agent.cjs"" teardown"; Flags: runhidden waituntilterminated; RunOnceId: "Teardown"
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /TN TPVPrintServiceUpdate /F"; Flags: runhidden waituntilterminated; RunOnceId: "DeleteUpdateTask"

[UninstallDelete]
Type: filesandordirs; Name: "{#DataDir}"

[Code]
var
  PortPage: TInputQueryWizardPage;

function ConfigExists: Boolean;
begin
  Result := FileExists(ExpandConstant('{#DataDir}\config.json'));
end;

function ServiceInstalled: Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\sc.exe'), 'query {#ServiceId}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

procedure InitializeWizard;
begin
  PortPage := CreateInputQueryPage(wpLicense,
    'Puerto del servicio',
    'Puerto en el que escucha el agente en este equipo.',
    'La web del TPV imprime llamando a https://127.0.0.1:<puerto>. Déjalo en 3000 salvo que esté ocupado. ' +
    'Si lo cambias, pon el mismo valor en «Servicio IP» del terminal en el admin del TPV.');
  PortPage.Add('Puerto:', False);
  PortPage.Values[0] := ExpandConstant('{param:PORT|3000}');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  // En una actualización se conserva el puerto configurado.
  Result := (PageID = PortPage.ID) and ConfigExists;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Port: Integer;
begin
  Result := True;
  if CurPageID = PortPage.ID then
  begin
    Port := StrToIntDef(Trim(PortPage.Values[0]), 0);
    if (Port < 1) or (Port > 65535) then
    begin
      MsgBox('El puerto tiene que ser un número entre 1 y 65535.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function PortArg(Param: String): String;
begin
  if ConfigExists and (ExpandConstant('{param:PORT|}') = '') then
    Result := ''
  else
    Result := '--port ' + IntToStr(StrToIntDef(Trim(PortPage.Values[0]), 3000));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  // Actualización: parar el servicio para poder sustituir node.exe y el agente.
  if ServiceInstalled then
  begin
    if FileExists(ExpandConstant('{app}\{#ServiceExe}')) then
      Exec(ExpandConstant('{app}\{#ServiceExe}'), 'stopwait', '', SW_HIDE, ewWaitUntilTerminated, ResultCode)
    else
      Exec(ExpandConstant('{sys}\sc.exe'), 'stop {#ServiceId}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(1000);
  end;
end;
