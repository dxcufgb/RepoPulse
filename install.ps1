<#
  RepoPulse installer for Windows.

    .\install.ps1                  set up Python environment, config and admin account
    .\install.ps1 -Service         also start RepoPulse automatically when Windows starts
                                   (run PowerShell as administrator)
    .\install.ps1 -OpenFirewall    allow other computers on the network to reach the port
    .\install.ps1 -RemoveService   stop starting it automatically
    .\install.ps1 -Port 9000       use another port than 8080

  Double-clicking install.bat runs this script with the default options.
#>
param(
  [switch]$Service,
  [switch]$RemoveService,
  [switch]$OpenFirewall,
  [int]$Port = 0
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

if ($RemoveService) {
  if (-not (Test-Admin)) { throw "Run PowerShell as administrator to remove the startup task." }
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
  } catch { }
}
if (-not $Py) {
  Write-Host "Python 3.9 or newer is needed. Install it from https://www.python.org/downloads/ (tick 'Add python.exe to PATH') and run this again." -ForegroundColor Yellow
  exit 1
}
$PyExe = $Py[0]; $PyArgs = @($Py | Select-Object -Skip 1)
& $PyExe @PyArgs --version

Say "2/4  Creating the virtual environment in .venv"
$VenvPy = Join-Path $AppDir ".venv\Scripts\python.exe"
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
}

Say "Done"
if (-not $Service) {
  Write-Host "Start RepoPulse by double-clicking run.bat (or .\run.bat)."
  Write-Host "Start it automatically with Windows: .\install.ps1 -Service  (as administrator)"
}
Write-Host "Dashboard: http://localhost:$PortNow/    Admin: http://localhost:$PortNow/admin"
