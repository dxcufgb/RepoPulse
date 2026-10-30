<#
  RepoPulse installer for Windows.

    .\install.ps1                  set up Python environment, config and admin account
    .\install.ps1 -Service         also start RepoPulse automatically when Windows starts
                                   (run PowerShell as administrator)
    .\install.ps1 -OpenFirewall    allow other computers on the network to reach the port
    .\install.ps1 -RemoveService   stop starting it automatically
    .\install.ps1 -Port 9000       use another port than 8080

  Automatic updates (as administrator, with -Service; see README, Automatic updates):
    .\install.ps1 -Service -AutoUpdate   install and turn them on (-NoAutoUpdate: off)
    .\install.ps1 -EnableAutoUpdate      turn them on later     .\install.ps1 -DisableAutoUpdate   off
    .\install.ps1 -CheckUpdate           exit 0 = up to date, 10 = a newer release exists, 1 = could not check
    .\install.ps1 -UpdateNow             install a newer release now
    .\install.ps1 -SetNotify             who gets the update e-mails, and the mail server

  Double-clicking install.bat runs this script with the default options.
#>
# Write-Host on purpose: this is an interactive installer and its coloured progress lines are for the person running it.
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer output')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'Installer functions run when asked for on the command line')]
param(
  [switch]$Service,
  [switch]$RemoveService,
  [switch]$OpenFirewall,
  [int]$Port = 0,
  [switch]$AutoUpdate,
  [switch]$NoAutoUpdate,
  [switch]$EnableAutoUpdate,
  [switch]$DisableAutoUpdate,
  [switch]$CheckUpdate,
  [switch]$UpdateNow,
  [switch]$SetNotify
)
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
$AppDir = (Get-Location).Path
$TaskName = "RepoPulse"

function Say($text) { Write-Host ""; Write-Host $text -ForegroundColor Cyan }
function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ---------------------------------------------------------------- automatic updates
$StateDir = Join-Path $env:ProgramData "RepoPulse"
$UpdateConf = Join-Path $StateDir "auto-update.conf"
$UpdateTasks = @("RepoPulse-Update", "RepoPulse-UpdateNow")
$VenvPy = Join-Path $AppDir ".venv\Scripts\python.exe"

function Test-AutoUpdate { return (Test-Path $UpdateConf) }

function Enable-AutoUpdate {
  if (-not (Test-Admin)) { throw "Run PowerShell as administrator to turn automatic updates on." }
  if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { throw "Automatic updates need the startup task: .\install.ps1 -Service -AutoUpdate" }
  if (Test-Path (Join-Path $AppDir ".git")) { throw "This folder is a git checkout: update it with git pull. Automatic updates are for installs from a release archive." }
  # The state folder holds the updater, its log and an optional token: Administrators and SYSTEM only.
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  & icacls $StateDir /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not restrict access to $StateDir." }
  Copy-Item -Force (Join-Path $AppDir "auto-update.ps1") (Join-Path $StateDir "auto-update.ps1")
  Copy-Item -Force (Join-Path $AppDir "repopulse\updater.py") (Join-Path $StateDir "updater.py")
  Set-Content -Path $UpdateConf -Value "APP_DIR=$AppDir" -Encoding ASCII
  if ($env:UPDATER_GITHUB_TOKEN) {
    Set-Content -Path (Join-Path $StateDir "updater-token") -Value $env:UPDATER_GITHUB_TOKEN -Encoding ASCII
    Write-Host "Stored the updater's GitHub token in $StateDir (Administrators and SYSTEM only)."
  }
  $ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $action = New-ScheduledTaskAction -Execute $ps -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $StateDir "auto-update.ps1") + '"')
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  $daily = New-ScheduledTaskTrigger -Daily -At 3am -RandomDelay (New-TimeSpan -Hours 6)
  Register-ScheduledTask -TaskName "RepoPulse-Update" -Action $action -Trigger $daily -Settings $settings -Principal $principal -Description "Installs new RepoPulse releases" -Force | Out-Null
  # No schedule: RepoPulse (which runs as SYSTEM) starts it for Update now on the admin page.
  Register-ScheduledTask -TaskName "RepoPulse-UpdateNow" -Action $action -Settings $settings -Principal $principal -Description "Installs a new RepoPulse release when the admin page asks" -Force | Out-Null
  Write-Host "Automatic updates are on: a daily check, and Update now on Admin, Settings. Log: $StateDir\auto-update.log"
}

function Disable-AutoUpdate {
  if (-not (Test-Admin)) { throw "Run PowerShell as administrator to turn automatic updates off." }
  foreach ($t in $UpdateTasks) { Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue }
  foreach ($f in @("auto-update.conf", "auto-update.ps1", "updater.py", "updater-token")) { Remove-Item -Force (Join-Path $StateDir $f) -ErrorAction SilentlyContinue }
  Write-Host "Automatic updates are off. (The log stays in $StateDir.)"
}

function Set-Notify {
  if (-not (Test-Path $VenvPy)) { return }
  if ($env:REPOPULSE_NOTIFY_EMAILS) { & $VenvPy -m repopulse set-notify --from-env }
  elseif (-not [Console]::IsInputRedirected) {
    Write-Host "Update e-mails: RepoPulse can e-mail you when it installs an update or an update fails."
    & $VenvPy -m repopulse set-notify
  } else { Write-Host "Set who gets the update e-mails on Admin, Settings, Notifications, or with .\install.ps1 -SetNotify" }
}

if ($EnableAutoUpdate) { Say "Turning automatic updates on"; Enable-AutoUpdate; Set-Notify; exit 0 }
if ($DisableAutoUpdate) { Say "Turning automatic updates off"; Disable-AutoUpdate; exit 0 }
if ($SetNotify) { Set-Notify; exit 0 }
if ($CheckUpdate) {
  if ((Test-AutoUpdate) -and (Test-Admin)) {
    & (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe") -NoProfile -ExecutionPolicy Bypass -File (Join-Path $StateDir "auto-update.ps1") -Check
  } else { & $VenvPy -m repopulse check-update }
  $rc = $LASTEXITCODE
  switch ($rc) { 0 { Write-Host "Up to date." } 10 { Write-Host "A newer release is available: .\install.ps1 -UpdateNow" } 75 { Write-Host "Another update run is busy." } default { Write-Host "Could not check." } }
  exit $rc
}
if ($UpdateNow) {
  if (-not (Test-Admin)) { throw "Run PowerShell as administrator to update." }
  if (-not (Test-AutoUpdate)) { throw "The updater is not set up. Turn it on with .\install.ps1 -EnableAutoUpdate (needs -Service)." }
  & (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe") -NoProfile -ExecutionPolicy Bypass -File (Join-Path $StateDir "auto-update.ps1")
  exit $LASTEXITCODE
}

if ($RemoveService) {
  if (-not (Test-Admin)) { throw "Run PowerShell as administrator to remove the startup task." }
  if (Test-AutoUpdate) { Disable-AutoUpdate }
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-NetFirewallRule -DisplayName "RepoPulse" -ErrorAction SilentlyContinue
  Write-Host "RepoPulse no longer starts with Windows. Your data in $AppDir\data is untouched."
  exit 0
}

Say "1/4  Checking Python"
$Py = $null
foreach ($candidate in @("py -3", "python", "python3")) {
  $parts = $candidate.Split(" ")
  if (-not (Get-Command $parts[0] -ErrorAction SilentlyContinue)) { continue }
  try {
    $extra = @($parts | Select-Object -Skip 1)
    $ok = & $parts[0] @extra -c "import sys; print(1 if sys.version_info >= (3, 9) else 0)" 2>$null
    if ("$ok".Trim() -eq "1") { $Py = $parts; break }
  } catch { Write-Verbose "$candidate did not run: $_" }
}
if (-not $Py) {
  Write-Host "Python 3.9 or newer is needed. Install it from https://www.python.org/downloads/ (tick 'Add python.exe to PATH') and run this again." -ForegroundColor Yellow
  exit 1
}
$PyExe = $Py[0]; $PyArgs = @($Py | Select-Object -Skip 1)
& $PyExe @PyArgs --version

Say "2/4  Creating the virtual environment in .venv"
if (-not (Test-Path $VenvPy)) { & $PyExe @PyArgs -m venv .venv; if ($LASTEXITCODE -ne 0) { throw "Could not create the virtual environment." } }
& $VenvPy -m pip install --upgrade pip | Out-Null
& $VenvPy -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw "Installing the Python packages failed." }

Say "3/4  Configuration"
if (-not (Test-Path "config.json")) { Copy-Item "config.example.json" "config.json"; Write-Host "Created config.json" }
if ($Port -gt 0) {
  $cfg = Get-Content "config.json" -Raw | ConvertFrom-Json
  $cfg.port = $Port
  $cfg | ConvertTo-Json | Set-Content "config.json" -Encoding UTF8
  Write-Host "Port set to $Port"
}
New-Item -ItemType Directory -Force -Path "data" | Out-Null

Say "4/4  Admin account"
$hasAdmin = & $VenvPy -c "from repopulse.config import load_config; from repopulse.db import Database; from repopulse.auth import user_count; print(user_count(Database(load_config().db_path)))"
if ("$hasAdmin".Trim() -ne "0") {
  Write-Host "An admin account already exists. Change its password with: .venv\Scripts\python -m repopulse set-password"
} elseif ([Console]::IsInputRedirected) {
  Write-Host "Skipped (no console to type in). Create it later with: .venv\Scripts\python -m repopulse create-admin"
} else {
  & $VenvPy -m repopulse create-admin
}

$PortNow = ("" + (& $VenvPy -c "from repopulse.config import load_config; print(load_config().port)")).Trim()

if ($OpenFirewall) {
  if (-not (Test-Admin)) { Write-Host "Skipping the firewall rule: run PowerShell as administrator for -OpenFirewall." -ForegroundColor Yellow }
  else {
    Remove-NetFirewallRule -DisplayName "RepoPulse" -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName "RepoPulse" -Direction Inbound -Protocol TCP -LocalPort $PortNow -Action Allow | Out-Null
    Write-Host "Firewall opened for TCP port $PortNow."
  }
}

if ($Service) {
  Say "Starting RepoPulse with Windows"
  if (-not (Test-Admin)) { throw "Run PowerShell as administrator to use -Service." }
  $action = New-ScheduledTaskAction -Execute $VenvPy -Argument "-m repopulse serve" -WorkingDirectory $AppDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "RepoPulse GitHub download statistics" -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "RepoPulse now runs in the background and starts with Windows (Task Scheduler, task '$TaskName')."

  # automatic updates: keep the earlier choice unless told otherwise; a first interactive install asks
  $auto = $null
  if ($AutoUpdate) { $auto = $true } elseif ($NoAutoUpdate) { $auto = $false }
  elseif (Test-AutoUpdate) { $auto = $true }
  elseif (-not [Console]::IsInputRedirected -and -not (Test-Path (Join-Path $AppDir ".git"))) {
    $answer = Read-Host "Install new RepoPulse releases automatically (checked daily)? [y/N]"
    $auto = $answer -match '^[yY]'
  }
  if ($auto -eq $true) {
    Say "Automatic updates"
    $first = -not (Test-AutoUpdate)
    Enable-AutoUpdate
    if ($first) { Set-Notify }
  } elseif ($auto -eq $false -and (Test-AutoUpdate)) { Disable-AutoUpdate }
}

Say "Done"
if (-not $Service) {
  Write-Host "Start RepoPulse by double-clicking run.bat (or .\run.bat)."
  Write-Host "Start it automatically with Windows: .\install.ps1 -Service  (as administrator)"
}
Write-Host "Dashboard: http://localhost:$PortNow/    Admin: http://localhost:$PortNow/admin"
