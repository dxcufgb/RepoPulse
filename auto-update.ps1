<#
.SYNOPSIS
    Installs new RepoPulse releases (automatic updates on Windows).

.DESCRIPTION
    Set up by .\install.ps1 -Service -AutoUpdate, which copies this script to C:\ProgramData\RepoPulse\ (Administrators
    and SYSTEM only). Run as SYSTEM daily by the scheduled task 'RepoPulse-Update', and at once by 'RepoPulse-UpdateNow'
    (Update now on Admin, Settings). By hand, from an elevated PowerShell:
        powershell -ExecutionPolicy Bypass -File C:\ProgramData\RepoPulse\auto-update.ps1          update now
        powershell -ExecutionPolicy Bypass -File C:\ProgramData\RepoPulse\auto-update.ps1 -Check   exit 0 = up to date,
                                                                    10 = a newer release exists, 1 = error, 75 = busy

    It asks GitHub for the latest release of dxcufgb/RepoPulse (updater.py), downloads repopulse-X.Y.Z-windows.zip and
    checks it against SHA256SUMS.txt, backs the current files up to data\update-backup, stops RepoPulse, copies the
    release over the installation (never config.json, data or .venv), updates the Python packages, starts RepoPulse
    and checks that the new version answers. If anything fails, the previous files are put back and RepoPulse is
    started again; if that fails too, the log says "ROLLBACK FAILED". The result is recorded and e-mailed by
    "python -m repopulse update-event". Log: C:\ProgramData\RepoPulse\auto-update.log
#>
# Write-Host on purpose (the task's output is the log); the functions change this one installation, no -WhatIf.
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Log output')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'Unattended updater')]
[CmdletBinding()]
param(
    [switch]$Check
)
$ErrorActionPreference = 'Stop'
$StateDir = Join-Path $env:ProgramData 'RepoPulse'
$Conf = Join-Path $StateDir 'auto-update.conf'
$LogFile = Join-Path $StateDir 'auto-update.log'
$TokenFile = Join-Path $StateDir 'updater-token'
$TaskName = 'RepoPulse'
$Keep = @('data', 'config.json', '.venv', '.git')

function Write-UpdateLog([string]$Message) {
    $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $Message
    Write-Host $line  # not Write-Output: that would become part of a function's return value
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    $script:RunLog.Add($line)
}
$script:RunLog = New-Object System.Collections.Generic.List[string]

function Invoke-Py([string[]]$Arguments, [string]$InputText = $null) {
    # Windows PowerShell 5.1 turns a native program's stderr into error records; with 'Stop' those would abort.
    $ErrorActionPreference = 'Continue'
    Push-Location $AppDir
    try {
        if ($null -ne $InputText) { $out = $InputText | & $VenvPy @Arguments 2>&1 } else { $out = & $VenvPy @Arguments 2>&1 }
        return @{ Code = $LASTEXITCODE; Output = @($out | ForEach-Object { "$_" }) }
    } finally { Pop-Location }
}

function Save-Result([string]$Outcome, [string]$From = '', [string]$To = '') {
    try {
        $r = Invoke-Py @('-m', 'repopulse', 'update-event', '--outcome', $Outcome, '--from', $From, '--to', $To, '--message-stdin') `
            (($script:RunLog | Select-Object -Last 60) -join "`n")
        $r.Output | ForEach-Object { Write-UpdateLog $_ }
    } catch { Write-UpdateLog "Could not record the result: $($_.Exception.Message)" }
}

function Stop-RepoPulse {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*repopulse*serve*' -and $_.ExecutablePath -like "$AppDir*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
}

function Get-Address {
    $r = Invoke-Py @('-c', 'from repopulse.config import load_config; c = load_config(); print(c.port, c.host)')
    $parts = ("" + ($r.Output | Select-Object -Last 1)).Trim().Split(' ')
    $port = 8080; $hostName = '127.0.0.1'
    if ($parts[0] -match '^\d{1,5}$') { $port = [int]$parts[0] }
    if ($parts.Count -gt 1 -and $parts[1] -match '^[A-Za-z0-9.-]+$' -and $parts[1] -ne '0.0.0.0') { $hostName = $parts[1] }
    return "http://${hostName}:$port"
}

function Test-Answer([string]$Version) {
    $base = Get-Address
    for ($i = 0; $i -lt 45; $i++) {
        try {
            $site = Invoke-RestMethod -Uri "$base/api/site" -UseBasicParsing -TimeoutSec 5
            if ($site.version -eq $Version) { return $true }
        } catch { Write-Verbose "not answering yet: $_" }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Copy-Entry([string]$From, [string[]]$Names) {
    foreach ($name in $Names) {
        $target = Join-Path $AppDir $name
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
        $source = Join-Path $From $name
        if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $target -Recurse -Force }
    }
}

function Install-Requirement {
    $r = Invoke-Py @('-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', '-q', '-r', (Join-Path $AppDir 'requirements.txt'))
    $r.Output | Select-Object -Last 10 | ForEach-Object { Write-UpdateLog $_ }
    if ($r.Code -ne 0) { throw "pip install failed (exit code $($r.Code))" }
    $r = Invoke-Py @('-c', 'import repopulse.app')
    if ($r.Code -ne 0) { throw "the new version does not load: $($r.Output -join ' ')" }
}

function Update-RepoPulse([bool]$CheckOnly) {
    if (Test-Path (Join-Path $AppDir '.git')) {
        Write-UpdateLog "$AppDir is a git checkout; update it with git pull. Nothing changed."
        if ($CheckOnly) { return 1 } else { return 0 }
    }
    $init = Get-Content -Raw -LiteralPath (Join-Path $AppDir 'repopulse\__init__.py')
    if ($init -notmatch '(?m)^__version__ = "([0-9A-Za-z.+-]+)"') { Write-UpdateLog 'Cannot tell which version is installed.'; return 1 }
    $current = $Matches[1]
    $updater = Join-Path $StateDir 'updater.py'
    $base = @('-I', $updater, '--installed', $current, '--platform', 'windows')
    if (Test-Path $TokenFile) { $base += @('--token-file', $TokenFile) }

    if ($CheckOnly) {
        $r = Invoke-Py ($base + @('check'))
        $r.Output | ForEach-Object { Write-Host $_ }
        switch ($r.Code) { 0 { return 10 } 3 { return 0 } default { return 1 } }
    }

    Write-UpdateLog "Installed: RepoPulse $current in $AppDir"
    $work = Join-Path $StateDir ('work-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        $r = Invoke-Py ($base + @('download', '--dest', (Join-Path $work 'dl')))
        $r.Output | Where-Object { $_ -notlike "$work*" } | ForEach-Object { Write-UpdateLog $_ }
        if ($r.Code -eq 3) { [void](Invoke-Py @('-m', 'repopulse', 'update-event', '--outcome', 'current', '--from', $current) ''); return 0 }
        $rel = [string]($r.Output | Select-Object -Last 1)
        if ($r.Code -ne 0 -or -not $rel.StartsWith((Join-Path $work 'dl\release\repopulse-'), [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $rel)) {
            Write-UpdateLog 'The update check or download failed; nothing was changed.'
            Save-Result 'failed' $current
            return 1
        }
        $new = (Split-Path -Leaf $rel).Substring('repopulse-'.Length)
        Write-UpdateLog "Installing RepoPulse $new"
        $names = @(Get-ChildItem -Force -LiteralPath $rel | Where-Object { $Keep -notcontains $_.Name } | ForEach-Object { $_.Name })

        $backup = Join-Path $AppDir 'data\update-backup'
        if (Test-Path $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
        New-Item -ItemType Directory -Path $backup | Out-Null
        foreach ($name in $names) {
            $p = Join-Path $AppDir $name
            if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination (Join-Path $backup $name) -Recurse -Force }
        }
        Write-UpdateLog "Backed up the current files to $backup"

        $installed = $false
        try {
            Stop-RepoPulse
            Copy-Entry $rel $names
            Install-Requirement
            Start-ScheduledTask -TaskName $TaskName
            $installed = Test-Answer $new
            if (-not $installed) { Write-UpdateLog "RepoPulse $new did not answer after the restart." }
        } catch { Write-UpdateLog "Installing $new failed: $($_.Exception.Message)" }

        if ($installed) {
            # the next run uses the new release's updater
            foreach ($f in @('auto-update.ps1', 'repopulse\updater.py')) {
                $src = Join-Path $rel $f
                if (Test-Path $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $StateDir (Split-Path -Leaf $f)) -Force }
            }
            Write-UpdateLog "RepoPulse $new is installed and running (was $current)."
            Save-Result 'updated' $current $new
            return 0
        }

        Write-UpdateLog "Putting $current back"
        try {
            Stop-RepoPulse
            Copy-Entry $backup $names
            try { Install-Requirement } catch { Write-UpdateLog "pip after the rollback: $($_.Exception.Message)" }
            Start-ScheduledTask -TaskName $TaskName
        } catch { Write-UpdateLog "Rollback step failed: $($_.Exception.Message)" }
        if (Test-Answer $current) {
            Write-UpdateLog "RepoPulse $current is running again."
            Save-Result 'rolled-back' $current $new
        } else {
            Write-UpdateLog "ROLLBACK FAILED: RepoPulse does not answer. The previous files are in $backup; copy them back into $AppDir and run Start-ScheduledTask $TaskName"
            Save-Result 'failed' $current $new
        }
        return 1
    } finally {
        Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    }
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host 'Error: run as administrator.'; exit 1 }
if (-not (Test-Path $Conf)) { Write-Host "Automatic updates are not set up ($Conf is missing). Run .\install.ps1 -Service -AutoUpdate."; exit 1 }
$AppDir = $null
foreach ($line in Get-Content $Conf) { if ($line -match '^APP_DIR=(.+)$') { $AppDir = $Matches[1].Trim().TrimEnd('\') } }
$VenvPy = if ($AppDir) { Join-Path $AppDir '.venv\Scripts\python.exe' } else { $null }
if (-not $AppDir -or -not (Test-Path $VenvPy)) { Write-Host "Error: RepoPulse is not installed in '$AppDir'."; exit 1 }

# One run at a time: the lock file stays open (and exclusive) until this script ends.
try {
    $lock = [IO.File]::Open((Join-Path $StateDir 'update.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
    Write-Host 'Another update run is busy; not starting a second one.'
    if ($Check) { exit 75 } else { exit 0 }
}
try {
    $code = Update-RepoPulse -CheckOnly $Check.IsPresent
} catch {
    Write-UpdateLog "Update failed: $($_.Exception.Message)"
    if (-not $Check) { Save-Result 'failed' }
    $code = 1
} finally {
    $lock.Dispose()
}
exit $code
