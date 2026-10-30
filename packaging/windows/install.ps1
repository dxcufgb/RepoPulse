<#
.SYNOPSIS
    Sets up, changes or removes the RepoPulse server on Windows. The installer (repopulse-X.Y.Z-setup.exe) runs it;
    you can run it yourself from an elevated PowerShell in C:\Program Files\RepoPulse.

.DESCRIPTION
    Layout (the same on every machine; updates keep the settings and the data):
      C:\Program Files\RepoPulse\             the program, with its own Python (python\) and packages (lib\)
      C:\ProgramData\RepoPulse\config.json    server settings (Administrators and SYSTEM change it; the service reads it)
      C:\ProgramData\RepoPulse\data\          database and session key (the service, LOCAL SERVICE, may write here)
      C:\ProgramData\RepoPulse\updater\       automatic updates: updater, log, backups (Administrators and SYSTEM only)
      Task Scheduler: RepoPulse               starts the server at boot as LOCAL SERVICE, restarts it if it stops

    .\install.ps1 [-Port 9000] [-OpenFirewall] [-AutoUpdate|-NoAutoUpdate] [-MigrateFrom DIR] [-NoMigrate]
                                       set up or repair (what the installer runs); keeps existing settings
    .\install.ps1 -EnableAutoUpdate    turn automatic updates on      .\install.ps1 -DisableAutoUpdate   off
    .\install.ps1 -CheckUpdate         exit 0 = up to date, 10 = a newer release exists, 1 = could not check
    .\install.ps1 -UpdateNow           install a newer release now (needs automatic updates on)
    .\install.ps1 -SetNotify           who gets the update e-mails, and the mail server
    .\install.ps1 -Stop                stop the server (the installer does this before replacing files)
    .\install.ps1 -Uninstall [-Purge]  remove the task and firewall rule (-Purge: also settings and data)
    -Unattended                        never ask anything (the installer passes it)
    -LogFile FILE                      also write the output to FILE (the installer: C:\ProgramData\RepoPulse\install.log)

    An earlier RepoPulse that was unzipped and started with run.bat or install.ps1 -Service (for example in
    Downloads) is found automatically when this install has no data yet: its database, session key and settings
    are copied, its startup task is replaced, and the old folder is left alone (data\MOVED.txt says where the data went).

    Unattended: REPOPULSE_ADMIN_USERNAME and REPOPULSE_ADMIN_PASSWORD create the admin account; REPOPULSE_NOTIFY_EMAILS
    and REPOPULSE_SMTP_* set the update e-mails; UPDATER_GITHUB_TOKEN gives the updater its own GitHub token (not
    needed: the repository is public). Secrets are never taken as arguments.
#>
# Write-Host on purpose: progress lines for the person (or the installer log) running it.
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Installer output')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'Installer functions run when asked for on the command line')]
[CmdletBinding()]
param(
    [int]$Port = 0,
    [switch]$OpenFirewall,
    [switch]$AutoUpdate,
    [switch]$NoAutoUpdate,
    [string]$MigrateFrom = '',
    [switch]$NoMigrate,
    [switch]$EnableAutoUpdate,
    [switch]$DisableAutoUpdate,
    [switch]$CheckUpdate,
    [switch]$UpdateNow,
    [switch]$SetNotify,
    [switch]$Stop,
    [switch]$Uninstall,
    [switch]$Purge,
    [switch]$Unattended,
    [string]$LogFile = ''
)
$ErrorActionPreference = 'Stop'
$AppDir = $PSScriptRoot
$Python = Join-Path $AppDir 'python\python.exe'
$Root = Join-Path $env:ProgramData 'RepoPulse'
$Config = Join-Path $Root 'config.json'
$DataDir = Join-Path $Root 'data'
$UpdDir = Join-Path $Root 'updater'
$UpdConf = Join-Path $UpdDir 'auto-update.conf'
$TaskName = 'RepoPulse'
$UpdateTasks = @('RepoPulse-Update', 'RepoPulse-UpdateNow')
$FirewallRule = 'RepoPulse'
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
# Well-known SIDs, so this works on Windows in any language.
$SidAdmins = '*S-1-5-32-544'; $SidSystem = '*S-1-5-18'; $SidLocalService = '*S-1-5-19'

function Say([string]$Text) { Write-Host "==> $Text" }

function Get-AccountName([string]$Sid) {
    (New-Object Security.Principal.SecurityIdentifier $Sid.TrimStart('*')).Translate([Security.Principal.NTAccount]).Value
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Runs the bundled Python; returns @{ Code; Output }. Native stderr must not stop the script (Windows PowerShell 5.1).
function Invoke-Python([string[]]$Arguments, [string]$InputText = $null) {
    $ErrorActionPreference = 'Continue'
    Push-Location $AppDir
    try {
        if ($null -ne $InputText) { $out = $InputText | & $Python @Arguments 2>&1 } else { $out = & $Python @Arguments 2>&1 }
        return @{ Code = $LASTEXITCODE; Output = @($out | ForEach-Object { "$_" }) }
    } finally { Pop-Location }
}

# The RepoPulse command line with the installed settings, in this console.
function Invoke-RepoPulse([string[]]$Arguments) {
    Push-Location $AppDir
    try { & $Python -m repopulse --config $Config @Arguments; return $LASTEXITCODE } finally { Pop-Location }
}

function Set-FolderAccess([string]$Path, [string[]]$Grants, [switch]$Protect) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    $icaclsArgs = @($Path)
    if ($Protect) { $icaclsArgs += '/inheritance:r' }
    $icaclsArgs += '/grant:r'
    $icaclsArgs += $Grants
    $icaclsArgs += '/Q'
    & icacls @icaclsArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not set the permissions of $Path." }
}

function Read-Json([string]$Path) {
    try {
        # tolerate a byte-order mark (Windows PowerShell 5.1 and Notepad write one)
        $text = [IO.File]::ReadAllText($Path).TrimStart([char]0xFEFF)
        $obj = $text | ConvertFrom-Json
        $h = @{}
        foreach ($p in $obj.PSObject.Properties) { $h[$p.Name] = $p.Value }
        return $h
    } catch { return @{} }
}

function Write-Json([string]$Path, [hashtable]$Values) {
    $ordered = [ordered]@{}
    foreach ($k in @('host', 'port', 'data_dir', 'behind_proxy', 'trusted_proxies', 'secure_cookies', 'allow_remote_setup', 'github_api_url', 'threads')) {
        if ($Values.ContainsKey($k)) { $ordered[$k] = $Values[$k] }
    }
    foreach ($k in $Values.Keys) { if (-not $ordered.Contains($k)) { $ordered[$k] = $Values[$k] } }
    $json = New-Object PSObject -Property $ordered | ConvertTo-Json -Depth 5
    # UTF-8 without a byte-order mark
    [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding $false))
}

function Get-Setting([string]$Key, $Default) {
    $cfg = Read-Json $Config
    if ($cfg.ContainsKey($Key) -and "$($cfg[$Key])" -ne '') { return $cfg[$Key] } else { return $Default }
}

function Stop-RepoPulse {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    # the task's python.exe, and one an older install started from its own folder
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*repopulse*serve*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
}

function Test-Answer([string]$Want = '') {
    $port = Get-Setting 'port' 8080
    $hostName = "$(Get-Setting 'host' '127.0.0.1')"
    if ($hostName -in @('0.0.0.0', '::', '')) { $hostName = '127.0.0.1' }
    if ($hostName -like '*:*') { $hostName = "[$hostName]" }
    for ($i = 0; $i -lt 45; $i++) {
        try {
            $site = Invoke-RestMethod -Uri "http://${hostName}:$port/api/site" -UseBasicParsing -TimeoutSec 5
            if (-not $Want -or $site.version -eq $Want) { return $true }
        } catch { Write-Verbose "not answering yet: $_" }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Get-AdminCount {
    $r = Invoke-Python @('-m', 'repopulse', '--config', $Config, 'status')
    foreach ($line in $r.Output) { if ($line -match '^Admin accounts: (\d+)') { return [int]$Matches[1] } }
    return -1
}

# ------------------------------------------------------------------------------------------ older installs

function Test-RepoPulseFolder([string]$Dir) {
    return (Test-Path -LiteralPath (Join-Path $Dir 'repopulse\__main__.py')) -and (Test-Path -LiteralPath (Join-Path $Dir 'repopulse\__init__.py'))
}

function Get-OldDataDir([string]$Dir) {
    $value = 'data'
    $cfgFile = Join-Path $Dir 'config.json'
    if (Test-Path -LiteralPath $cfgFile) {
        $cfg = Read-Json $cfgFile
        if ($cfg.ContainsKey('data_dir') -and "$($cfg['data_dir'])") { $value = "$($cfg['data_dir'])" }
    }
    if ([IO.Path]::IsPathRooted($value)) { return $value } else { return (Join-Path $Dir $value) }
}

# The older RepoPulse folders with a database, the most recently used first.
function Find-OldInstall {
    $dirs = New-Object System.Collections.Generic.List[string]
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task -and $task.Actions.Count -gt 0) {
        if ($task.Actions[0].WorkingDirectory) { $dirs.Add($task.Actions[0].WorkingDirectory) }
        $exe = $task.Actions[0].Execute
        if ($exe -like '*\.venv\Scripts\python.exe') { $dirs.Add((Split-Path (Split-Path (Split-Path $exe)))) }
    }
    $places = @("$env:SystemDrive\RepoPulse", "$env:SystemDrive\repopulse")
    foreach ($profileDir in Get-ChildItem "$env:SystemDrive\Users" -Directory -ErrorAction SilentlyContinue) {
        foreach ($sub in @('Downloads', 'Desktop', 'Documents', '')) {
            $base = Join-Path $profileDir.FullName $sub
            if (-not (Test-Path -LiteralPath $base)) { continue }
            foreach ($d in Get-ChildItem -LiteralPath $base -Directory -Filter '*epo*ulse*' -ErrorAction SilentlyContinue) {
                $places += $d.FullName
                # a zip unpacked into a folder of its own name: Downloads\repopulse-1.1.0\repopulse-1.1.0
                foreach ($inner in Get-ChildItem -LiteralPath $d.FullName -Directory -Filter '*epo*ulse*' -ErrorAction SilentlyContinue) { $places += $inner.FullName }
            }
        }
    }
    foreach ($p in $places) { $dirs.Add($p) }
    $found = @{}
    foreach ($dir in $dirs) {
        if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
        $full = (Resolve-Path -LiteralPath $dir).Path.TrimEnd('\')
        if ($found.ContainsKey($full) -or $full -eq $AppDir.TrimEnd('\') -or -not (Test-RepoPulseFolder $full)) { continue }
        $db = Join-Path (Get-OldDataDir $full) 'repopulse.db'
        if ((Test-Path -LiteralPath $db) -and (Get-Item -LiteralPath $db).Length -gt 0) { $found[$full] = (Get-Item -LiteralPath $db).LastWriteTimeUtc }
    }
    return @($found.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { $_.Key })
}

# Copies the database (a consistent copy, even while the old RepoPulse runs), the session key and the settings.
function Copy-OldInstall([string]$Dir) {
    $oldData = Get-OldDataDir $Dir
    Say "Copying the database, session key and settings of $Dir"
    $tmp = Join-Path $DataDir ('.migrate-' + [Guid]::NewGuid().ToString('N') + '.db')
    $r = Invoke-Python @('-I', '-c', 'import sqlite3, sys; s = sqlite3.connect(sys.argv[1], timeout=30); d = sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()', (Join-Path $oldData 'repopulse.db'), $tmp)
    if ($r.Code -ne 0) { Remove-Item -Force $tmp -ErrorAction SilentlyContinue; throw "Could not copy the database of ${Dir}: $($r.Output -join ' ')" }
    Move-Item -Force -LiteralPath $tmp -Destination (Join-Path $DataDir 'repopulse.db')
    $key = Join-Path $oldData 'secret.key'
    if (Test-Path -LiteralPath $key) { Copy-Item -Force -LiteralPath $key -Destination (Join-Path $DataDir 'secret.key') }
    $note = "This RepoPulse data was copied to $DataDir on $(Get-Date -Format 'yyyy-MM-dd HH:mm') and is no longer used. RepoPulse now runs from C:\Program Files\RepoPulse. You can delete $Dir."
    try { [IO.File]::WriteAllText((Join-Path $oldData 'MOVED.txt'), $note) } catch { Write-Verbose "no MOVED.txt: $_" }
    $script:Migrated = $Dir
    $oldCfg = Join-Path $Dir 'config.json'
    if (Test-Path -LiteralPath $oldCfg) { return (Read-Json $oldCfg) } else { return @{} }
}

# ------------------------------------------------------------------------------------------ automatic updates

function Test-AutoUpdate { return (Test-Path $UpdConf) }

function Enable-AutoUpdate {
    Set-FolderAccess $UpdDir @("${SidAdmins}:(OI)(CI)F", "${SidSystem}:(OI)(CI)F") -Protect
    Copy-Item -Force (Join-Path $AppDir 'auto-update.ps1') (Join-Path $UpdDir 'auto-update.ps1')
    Copy-Item -Force (Join-Path $AppDir 'repopulse\updater.py') (Join-Path $UpdDir 'updater.py')
    [IO.File]::WriteAllText($UpdConf, "APP_DIR=$AppDir`r`n")
    if ($env:UPDATER_GITHUB_TOKEN) {
        [IO.File]::WriteAllText((Join-Path $UpdDir 'updater-token'), $env:UPDATER_GITHUB_TOKEN)
        Write-Host "    stored the updater's GitHub token in $UpdDir (Administrators and SYSTEM only)"
    }
    $action = New-ScheduledTaskAction -Execute $PowerShellExe -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $UpdDir 'auto-update.ps1') + '"')
    $principal = New-ScheduledTaskPrincipal -UserId (Get-AccountName $SidSystem) -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    $daily = New-ScheduledTaskTrigger -Daily -At 3am -RandomDelay (New-TimeSpan -Hours 6)
    Register-ScheduledTask -TaskName 'RepoPulse-Update' -Action $action -Trigger $daily -Settings $settings -Principal $principal -Description 'Installs new RepoPulse releases' -Force | Out-Null
    Register-ScheduledTask -TaskName 'RepoPulse-UpdateNow' -Action $action -Settings $settings -Principal $principal -Description 'Installs a new RepoPulse release when the admin page asks' -Force | Out-Null
    # "Update now" on the admin page: the server (LOCAL SERVICE) may start this one task, nothing else. The task
    # runs a fixed script from a folder only Administrators and SYSTEM can change.
    $svc = New-Object -ComObject 'Schedule.Service'
    $svc.Connect()
    # (the server also reads whether the daily task exists, for Admin, Settings)
    $svc.GetFolder('\').GetTask('RepoPulse-UpdateNow').SetSecurityDescriptor('D:(A;;FA;;;BA)(A;;FA;;;SY)(A;;GRGX;;;LS)', 0)
    $svc.GetFolder('\').GetTask('RepoPulse-Update').SetSecurityDescriptor('D:(A;;FA;;;BA)(A;;FA;;;SY)(A;;GR;;;LS)', 0)
}

function Disable-AutoUpdate {
    foreach ($t in $UpdateTasks) { Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue }
    foreach ($f in @('auto-update.conf', 'auto-update.ps1', 'updater.py', 'updater-token')) { Remove-Item -Force (Join-Path $UpdDir $f) -ErrorAction SilentlyContinue }
}

function Set-Notify {
    if ($env:REPOPULSE_NOTIFY_EMAILS) { [void](Invoke-RepoPulse @('set-notify', '--from-env')) }
    elseif (-not $Unattended -and -not [Console]::IsInputRedirected -and [Environment]::UserInteractive) {
        Write-Host 'RepoPulse can e-mail you when it installs an update or an update fails (empty = no e-mails).'
        [void](Invoke-RepoPulse @('set-notify'))
    } else { Write-Host 'Set who gets the update e-mails on Admin, Settings, or with: .\install.ps1 -SetNotify' }
}

# ------------------------------------------------------------------------------------------ actions

if ($LogFile) { New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null; Start-Transcript -Path $LogFile -Force | Out-Null }
if (-not (Test-Admin)) { Write-Host 'Error: run PowerShell as administrator.'; exit 1 }
if (-not (Test-Path $Python)) { Write-Host "Error: $Python is missing. Run the RepoPulse installer (repopulse-setup.exe)."; exit 1 }

if ($Stop) { Stop-RepoPulse; exit 0 }

if ($Uninstall) {
    Say 'Removing the RepoPulse tasks'
    Disable-AutoUpdate
    Stop-RepoPulse
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue
    if ($Purge) {
        Say "Deleting the settings and data in $Root"
        Remove-Item -Recurse -Force -LiteralPath $Root -ErrorAction SilentlyContinue
    } else {
        Write-Host "Kept the settings and data in $Root."
    }
    exit 0
}

if ($EnableAutoUpdate) {
    $first = -not (Test-AutoUpdate)
    Enable-AutoUpdate
    Say "Automatic updates are on: a daily check, and Update now on Admin, Settings. Log: $UpdDir\auto-update.log"
    if ($first) { Set-Notify }
    exit 0
}
if ($DisableAutoUpdate) { Disable-AutoUpdate; Say 'Automatic updates are off.'; exit 0 }
if ($SetNotify) { Set-Notify; exit 0 }
if ($CheckUpdate) {
    if (Test-AutoUpdate) {
        & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $UpdDir 'auto-update.ps1') -Check
        $rc = $LASTEXITCODE
    } else { $rc = Invoke-RepoPulse @('check-update') }
    switch ($rc) { 0 { Write-Host 'Up to date.' } 10 { Write-Host 'A newer release is available: .\install.ps1 -UpdateNow' } 75 { Write-Host 'Another update run is busy.' } default { Write-Host 'Could not check.' } }
    exit $rc
}
if ($UpdateNow) {
    if (-not (Test-AutoUpdate)) { Write-Host 'The updater is not set up. Turn it on with .\install.ps1 -EnableAutoUpdate'; exit 1 }
    & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $UpdDir 'auto-update.ps1')
    exit $LASTEXITCODE
}

# ------------------------------------------------------------------------------------------ set up / repair

if ($Port -lt 0 -or $Port -gt 65535) { Write-Host 'Error: -Port must be 1-65535.'; exit 1 }
Stop-RepoPulse

Say "Settings and data in $Root"
# Administrators and SYSTEM change everything; the service reads the settings and writes only the data folder.
Set-FolderAccess $Root @("${SidAdmins}:(OI)(CI)F", "${SidSystem}:(OI)(CI)F", "${SidLocalService}:(OI)(CI)RX") -Protect
Set-FolderAccess $DataDir @("${SidLocalService}:(OI)(CI)M")

$oldSettings = @{}
$script:Migrated = ''
if (-not (Test-Path (Join-Path $DataDir 'repopulse.db'))) {
    $source = ''
    if ($MigrateFrom) {
        if (-not (Test-RepoPulseFolder $MigrateFrom)) { Write-Host "Error: -MigrateFrom: $MigrateFrom is not a RepoPulse folder."; exit 1 }
        $source = (Resolve-Path -LiteralPath $MigrateFrom).Path
    } elseif (-not $NoMigrate) {
        $found = @(Find-OldInstall)
        if ($found.Count -gt 0) {
            $source = $found[0]
            if ($found.Count -gt 1) { Write-Host "    also found: $(($found | Select-Object -Skip 1) -join ', '); this one was used most recently (pick another with -MigrateFrom)" }
        }
    }
    if ($source) { $oldSettings = Copy-OldInstall $source }
} elseif ($MigrateFrom) {
    Write-Host "    $DataDir already has a database; nothing copied from $MigrateFrom"
}

if (Test-Path $Config) {
    $cfg = Read-Json $Config
} else {
    $cfg = Read-Json (Join-Path $AppDir 'config.example.json')
    foreach ($k in @('host', 'port', 'behind_proxy', 'trusted_proxies', 'secure_cookies', 'allow_remote_setup', 'github_api_url', 'threads')) {
        if ($oldSettings.ContainsKey($k)) { $cfg[$k] = $oldSettings[$k] }
    }
}
$cfg['data_dir'] = $DataDir
if ($Port -gt 0) { $cfg['port'] = $Port }
Write-Json $Config $cfg
$PortNow = [int](Get-Setting 'port' 8080)

Say 'Preparing the program'
# The service cannot write into Program Files: compile once now instead of on every start.
[void](Invoke-Python @('-m', 'compileall', '-q', (Join-Path $AppDir 'repopulse'), (Join-Path $AppDir 'lib')))

if ($OpenFirewall -or (Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue)) {
    Remove-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $FirewallRule -Description 'RepoPulse dashboard' -Direction Inbound -Protocol TCP -LocalPort $PortNow -Action Allow | Out-Null
    Write-Host "    Windows Firewall lets other computers reach TCP port $PortNow"
}

Say 'Registering the RepoPulse task (starts with Windows, runs as LOCAL SERVICE)'
$action = New-ScheduledTaskAction -Execute $Python -Argument ('-m repopulse --config "' + $Config + '" serve') -WorkingDirectory $AppDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId (Get-AccountName $SidLocalService) -LogonType ServiceAccount -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'RepoPulse GitHub release download statistics' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
if (-not (Test-Answer)) { Write-Host "Error: RepoPulse did not answer on port $PortNow. Is another program using it? Try: .\install.ps1 -Port 9000"; exit 2 }

$first = $false
if ($AutoUpdate -or (-not $NoAutoUpdate -and (Test-AutoUpdate))) {
    $first = -not (Test-AutoUpdate)
    Say 'Automatic updates'
    Enable-AutoUpdate
} elseif ($NoAutoUpdate) { Disable-AutoUpdate }

if ((Get-AdminCount) -eq 0) {
    if ($env:REPOPULSE_ADMIN_USERNAME -and $env:REPOPULSE_ADMIN_PASSWORD) {
        Say 'Creating the admin account'
        $r = Invoke-Python @('-m', 'repopulse', '--config', $Config, 'create-admin') ''
        $r.Output | ForEach-Object { Write-Host "    $_" }
        if ($r.Code -ne 0) { exit 3 }
    } else {
        Write-Host "No admin account yet: open http://localhost:$PortNow/admin on this computer to create it."
    }
}
if ($first) { Set-Notify }

Say "RepoPulse $((Invoke-Python @('-c', 'import repopulse; print(repopulse.__version__)')).Output -join '') is running"
Write-Host "    Dashboard: http://localhost:$PortNow/    Admin: http://localhost:$PortNow/admin"
Write-Host "    Settings:  $Config (then restart the RepoPulse task)    Data: $DataDir"
if ($script:Migrated) { Write-Host "    The data of $($script:Migrated) was copied; that folder is no longer used." }
exit 0
