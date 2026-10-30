; Inno Setup script for the Windows installer, repopulse-<version>-setup.exe.
;
; Build it with packaging\windows\build-setup.ps1 (it stages the program with its own Python and packages), which runs:
;   ISCC /DAppVersion=<version> /DNumericVersion=<a.b.c.0> /DSourceDir=<staged folder> /O<out dir> RepoPulse.iss
;
; The wizard copies the program to C:\Program Files\RepoPulse and runs install.ps1 there, which keeps the settings
; and data in C:\ProgramData\RepoPulse, finds and copies an older RepoPulse (unzipped and started with run.bat), and
; registers the scheduled task that runs the server at boot as LOCAL SERVICE. Running a newer installer updates the
; program and keeps the settings and the data; automatic updates do exactly that.
;
; Unattended (the password only through the environment, never on a command line):
;   set REPOPULSE_ADMIN_USERNAME=admin
;   set REPOPULSE_ADMIN_PASSWORD=...
;   repopulse-X.Y.Z-setup.exe /VERYSILENT /SUPPRESSMSGBOXES [/PORT=8080] [/TASKS="firewall,autoupdate"] [/MIGRATEFROM=C:\old\repopulse]
; Uninstall: "C:\Program Files\RepoPulse\unins000.exe" /VERYSILENT [/PURGE]   (/PURGE also deletes settings and data)

#ifndef AppVersion
  #error Pass /DAppVersion=<version>
#endif
#ifndef NumericVersion
  #define NumericVersion "0.0.0.0"
#endif
#ifndef SourceDir
  #error Pass /DSourceDir=<staged program folder>
#endif

[Setup]
AppId={{0AA2860F-5CA0-4799-B0B0-3EC88F449BCA}
AppName=RepoPulse
AppVersion={#AppVersion}
AppVerName=RepoPulse {#AppVersion}
VersionInfoVersion={#NumericVersion}
AppPublisher=dxcufgb
AppPublisherURL=https://github.com/dxcufgb/RepoPulse
AppSupportURL=https://github.com/dxcufgb/RepoPulse/issues
AppUpdatesURL=https://github.com/dxcufgb/RepoPulse/releases
; install.ps1 and the updater expect C:\Program Files\RepoPulse, so the folder is fixed.
DefaultDirName={commonpf}\RepoPulse
DisableDirPage=yes
UsePreviousAppDir=no
DefaultGroupName=RepoPulse
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputBaseFilename=repopulse-{#AppVersion}-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
LicenseFile={#SourceDir}\LICENSE
UninstallDisplayName=RepoPulse
UninstallDisplayIcon={app}\python\python.exe
; RepoPulse is stopped by PrepareToInstall; there is no window for the Restart Manager to close.
CloseApplications=no
RestartApplications=no

[Tasks]
Name: "firewall"; Description: "Let other computers on the network open RepoPulse (opens the port in Windows Firewall)"; \
  Check: IsFirstInstall; Flags: unchecked
Name: "autoupdate"; Description: "Install new RepoPulse releases automatically (checked daily)"; \
  Check: IsFirstInstall; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[INI]
Filename: "{group}\RepoPulse dashboard.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://localhost:{code:PortNow}/"
Filename: "{group}\RepoPulse admin.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://localhost:{code:PortNow}/admin"

[Icons]
Name: "{group}\Uninstall RepoPulse"; Filename: "{uninstallexe}"

[Run]
Filename: "http://localhost:{code:PortNow}/admin"; Description: "Open RepoPulse in the browser"; \
  Flags: postinstall shellexec nowait skipifsilent

[UninstallDelete]
; Compiled Python files and the shortcuts written after Inno Setup recorded its own files.
Type: filesandordirs; Name: "{app}"
Type: files; Name: "{group}\RepoPulse dashboard.url"
Type: files; Name: "{group}\RepoPulse admin.url"

[Code]
var
  PortPage: TInputQueryWizardPage;
  AdminPage: TInputQueryWizardPage;
  MigratePage: TInputQueryWizardPage;
  PurgeData: Boolean;

function SetEnvironmentVariable(lpName, lpValue: String): Boolean;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';

function DataRoot(): String;
begin
  Result := ExpandConstant('{commonappdata}\RepoPulse');
end;

{ Settings exist: an update. The wizard then asks nothing and install.ps1 keeps every setting. }
function IsFirstInstall(): Boolean;
begin
  Result := not FileExists(DataRoot() + '\config.json');
end;

function HasData(): Boolean;
begin
  Result := FileExists(DataRoot() + '\data\repopulse.db');
end;

function IsDigits(S: String): Boolean;
var
  I: Integer;
begin
  Result := S <> '';
  for I := 1 to Length(S) do
    if (S[I] < '0') or (S[I] > '9') then
      Result := False;
end;

{ The port in config.json ("port": 8080), else the one asked for, else 8080. }
function PortNow(Param: String): String;
var
  Text: AnsiString;
  S: String;
  P, I: Integer;
begin
  Result := '';
  if LoadStringFromFile(DataRoot() + '\config.json', Text) then
  begin
    S := String(Text);
    P := Pos('"port"', S);
    if P > 0 then
    begin
      I := P + 6;
      while (I <= Length(S)) and ((S[I] = ' ') or (S[I] = ':') or (S[I] = #9)) do
        I := I + 1;
      while (I <= Length(S)) and (S[I] >= '0') and (S[I] <= '9') do
      begin
        Result := Result + S[I];
        I := I + 1;
      end;
    end;
  end;
  if (Result = '') and (PortPage <> nil) then
    Result := Trim(PortPage.Values[0]);
  if Result = '' then
    Result := ExpandConstant('{param:PORT|8080}');
end;

function PowerShell(Params: String; Show: Integer; var Code: Integer): Boolean;
begin
  Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass ' + Params, ExpandConstant('{tmp}'), Show, ewWaitUntilTerminated, Code);
end;

procedure InitializeWizard();
begin
  PortPage := CreateInputQueryPage(wpSelectTasks, 'Port',
    'Which port should RepoPulse use?',
    'The dashboard will be at http://localhost:<port>/ on this computer. Keep 8080 unless another program uses it.');
  PortPage.Add('Port:', False);
  PortPage.Values[0] := ExpandConstant('{param:PORT|8080}');

  { A text field, not a folder page: a folder page does not accept an empty value. }
  MigratePage := CreateInputQueryPage(PortPage.ID, 'Earlier RepoPulse (optional)',
    'Bring the data of a RepoPulse you started from an unzipped folder?',
    'If you ran RepoPulse before from an unzipped folder (with run.bat or install.ps1), its database, settings and ' +
    'admin account are copied. Leave this empty to let the installer look for one by itself (in Downloads, Desktop, ' +
    'Documents and the old startup task). The old folder is not changed.');
  MigratePage.Add('Folder of the earlier RepoPulse (for example C:\Users\you\Downloads\repopulse-1.1.0):', False);
  MigratePage.Values[0] := ExpandConstant('{param:MIGRATEFROM|}');

  AdminPage := CreateInputQueryPage(MigratePage.ID, 'Admin account',
    'Create the account that signs in to the admin pages.',
    'Leave these empty to create it later in the browser (on this computer: http://localhost:<port>/admin). ' +
    'When the data of an earlier RepoPulse is copied, its accounts are kept and these fields are ignored.');
  AdminPage.Add('User name:', False);
  AdminPage.Add('Password (at least 8 characters):', True);
  AdminPage.Add('Password again:', True);
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if PageID = PortPage.ID then
    Result := not IsFirstInstall();
  if PageID = MigratePage.ID then
    Result := not IsFirstInstall() or HasData();
  if PageID = AdminPage.ID then
    Result := HasData();
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Port: Integer;
begin
  Result := True;
  if CurPageID = PortPage.ID then
  begin
    Port := StrToIntDef(Trim(PortPage.Values[0]), 0);
    if not IsDigits(Trim(PortPage.Values[0])) or (Port < 1) or (Port > 65535) then
    begin
      MsgBox('The port must be a number from 1 to 65535.', mbError, MB_OK);
      Result := False;
    end;
  end;
  if (CurPageID = MigratePage.ID) and (Trim(MigratePage.Values[0]) <> '') and
     not FileExists(AddBackslash(Trim(MigratePage.Values[0])) + 'repopulse\__main__.py') then
  begin
    MsgBox('That folder does not contain RepoPulse (no repopulse\__main__.py). Choose the folder you unzipped, or leave it empty.', mbError, MB_OK);
    Result := False;
  end;
  if (CurPageID = AdminPage.ID) and (Trim(AdminPage.Values[0]) <> '') then
  begin
    if Length(AdminPage.Values[1]) < 8 then
    begin
      MsgBox('The password must have at least 8 characters.', mbError, MB_OK);
      Result := False;
    end
    else if AdminPage.Values[1] <> AdminPage.Values[2] then
    begin
      MsgBox('The passwords do not match.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Result := '';
  { Stop a running RepoPulse before its files are replaced. }
  if FileExists(ExpandConstant('{app}\install.ps1')) and FileExists(ExpandConstant('{app}\python\python.exe')) then
    PowerShell('-File "' + ExpandConstant('{app}\install.ps1') + '" -Stop', SW_HIDE, Code);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Params, LogFile, MigrateFrom: String;
  Code: Integer;
begin
  if CurStep <> ssPostInstall then
    exit;
  LogFile := DataRoot() + '\install.log';
  Params := '-File "' + ExpandConstant('{app}\install.ps1') + '" -Unattended -LogFile "' + LogFile + '"';
  if IsFirstInstall() then
    Params := Params + ' -Port ' + PortNow('');
  if WizardIsTaskSelected('firewall') then
    Params := Params + ' -OpenFirewall';
  if WizardIsTaskSelected('autoupdate') then
    Params := Params + ' -AutoUpdate';
  MigrateFrom := Trim(MigratePage.Values[0]);
  if MigrateFrom <> '' then
    Params := Params + ' -MigrateFrom "' + RemoveBackslashUnlessRoot(MigrateFrom) + '"';
  { The admin account reaches install.ps1 through the environment, never on a command line. }
  if Trim(AdminPage.Values[0]) <> '' then
  begin
    SetEnvironmentVariable('REPOPULSE_ADMIN_USERNAME', Trim(AdminPage.Values[0]));
    SetEnvironmentVariable('REPOPULSE_ADMIN_PASSWORD', AdminPage.Values[1]);
  end;
  WizardForm.StatusLabel.Caption := 'Setting up and starting RepoPulse...';
  Log('Running install.ps1 with: ' + Params);
  if not PowerShell(Params, SW_HIDE, Code) then
    Code := -1;
  SetEnvironmentVariable('REPOPULSE_ADMIN_USERNAME', '');
  SetEnvironmentVariable('REPOPULSE_ADMIN_PASSWORD', '');
  Log(Format('install.ps1 exit code: %d (see %s)', [Code, LogFile]));
  if Code <> 0 then
    SuppressibleMsgBox('RepoPulse was installed, but it could not be set up or did not start.' + #13#10#13#10 +
      'Details are in ' + LogFile + '. Another program may be using the port; you can run' + #13#10 +
      '  install.ps1 -Port 9000' + #13#10 + 'in an administrator PowerShell in ' + ExpandConstant('{app}') + '.',
      mbError, MB_OK, IDOK);
end;

function InitializeUninstall(): Boolean;
begin
  Result := True;
  if UninstallSilent() then
    PurgeData := Pos('/PURGE', Uppercase(GetCmdTail())) > 0
  else
    PurgeData := MsgBox('Also delete the RepoPulse settings, database and admin accounts in ' + DataRoot() + '?' + #13#10#13#10 +
      'Choose No to keep them for a later reinstall.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Params: String;
  Code: Integer;
begin
  { install.ps1 stops RepoPulse and removes its tasks and firewall rule (and with -Purge the settings and data). }
  if CurUninstallStep = usUninstall then
  begin
    Params := '-File "' + ExpandConstant('{app}\install.ps1') + '" -Uninstall -Unattended';
    if PurgeData then
      Params := Params + ' -Purge';
    PowerShell(Params, SW_HIDE, Code);
  end;
end;
