<#
.SYNOPSIS
    Installs new RepoPulse releases (automatic updates on Windows).

.DESCRIPTION
    Set up by install.ps1 -AutoUpdate (the installer's "Install new releases automatically"), which copies this script
    to C:\ProgramData\RepoPulse\updater\ (Administrators and SYSTEM only). Run as SYSTEM daily by the scheduled task
    'RepoPulse-Update', and at once by 'RepoPulse-UpdateNow' (Update now on Admin, Settings). By hand, from an elevated
    PowerShell:
        powershell -ExecutionPolicy Bypass -File C:\ProgramData\RepoPulse\updater\auto-update.ps1          update now
        powershell -ExecutionPolicy Bypass -File C:\ProgramData\RepoPulse\updater\auto-update.ps1 -Check   exit 0 = up
                                         to date, 10 = a newer release exists, 1 = error, 75 = another run is busy

    It asks GitHub for the latest release of dxcufgb/RepoPulse (updater.py: only strictly newer final releases),
    downloads repopulse-X.Y.Z-setup.exe and checks it against SHA256SUMS.txt, backs up C:\Program Files\RepoPulse,
    runs the installer silently (it keeps the settings and the data) and checks that the new version answers. If it
    does not, the backup is put back and RepoPulse is started again; if that fails too, the log says "ROLLBACK
    FAILED". The result is recorded and e-mailed by "repopulse update-event". Log: ...\updater\auto-update.log
#>
# Write-Host on purpose (the task's output is the log); the functions change this one installation, no -WhatIf.
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Log output')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'Unattended updater')]
[CmdletBinding()]
param(
    [switch]$Check
)
$ErrorActionPreference = 'Stop'
$Root = Join-Path $env:ProgramData 'RepoPulse'
$StateDir = Join-Path $Root 'updater'
$Config = Join-Path $Root 'config.json'
$Conf = Join-Path $StateDir 'auto-update.conf'
$LogFile = Join-Path $StateDir 'auto-update.log'
$TokenFile = Join-Path $StateDir 'updater-token'
$Backup = Join-Path $StateDir 'backup'
$TaskName = 'RepoPulse'

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
        if ($null -ne $InputText) { $out = $InputText | & $Python @Arguments 2>&1 } else { $out = & $Python @Arguments 2>&1 }
        return @{ Code = $LASTEXITCODE; Output = @($out | ForEach-Object { "$_" }) }
    } finally { Pop-Location }
}

function Save-Result([string]$Outcome, [string]$From = '', [string]$To = '') {
    try {
        $r = Invoke-Py @('-m', 'repopulse', '--config', $Config, 'update-event', '--outcome', $Outcome, '--from', $From, '--to', $To, '--message-stdin') `
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
    $port = 8080; $hostName = '127.0.0.1'
    try {
        $cfg = [IO.File]::ReadAllText($Config).TrimStart([char]0xFEFF) | ConvertFrom-Json
        if ("$($cfg.port)" -match '^\d{1,5}$') { $port = [int]$cfg.port }
        if ("$($cfg.host)" -match '^[A-Za-z0-9.-]+$' -and "$($cfg.host)" -ne '0.0.0.0') { $hostName = "$($cfg.host)" }
    } catch { Write-Verbose "default address: $_" }
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

function Copy-Folder([string]$From, [string]$To) {
    # robocopy exit codes below 8 mean success
    & robocopy $From $To /MIR /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy $From -> $To failed (exit code $LASTEXITCODE)" }
}

function Update-RepoPulse([bool]$CheckOnly) {
    $init = Get-Content -Raw -LiteralPath (Join-Path $AppDir 'repopulse\__init__.py')
    if ($init -notmatch '(?m)^__version__ = "([0-9A-Za-z.+-]+)"') { Write-UpdateLog 'Cannot tell which version is installed.'; return 1 }
    $current = $Matches[1]
    $base = @('-I', (Join-Path $StateDir 'updater.py'), '--installed', $current, '--platform', 'windows')
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
        if ($r.Code -eq 3) { [void](Invoke-Py @('-m', 'repopulse', '--config', $Config, 'update-event', '--outcome', 'current', '--from', $current) ''); return 0 }
        $setup = [string]($r.Output | Select-Object -Last 1)
        $expected = Join-Path $work 'dl\release\repopulse-'
        if ($r.Code -ne 0 -or -not $setup.StartsWith($expected, [StringComparison]::OrdinalIgnoreCase) -or -not $setup.EndsWith('-setup.exe') -or -not (Test-Path -LiteralPath $setup)) {
            Write-UpdateLog 'The update check or download failed; nothing was changed.'
            Save-Result 'failed' $current
            return 1
        }
        $new = (Split-Path -Leaf $setup) -replace '^repopulse-', '' -replace '-setup\.exe$', ''
        Write-UpdateLog "Installing RepoPulse $new"

        Copy-Folder $AppDir $Backup
        Write-UpdateLog "Backed up $AppDir to $Backup"

        $installed = $false
        try {
            $setupLog = Join-Path $work 'setup.log'
            $p = Start-Process -FilePath $setup -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$setupLog`"") -Wait -PassThru
            if (Test-Path $setupLog) { Get-Content $setupLog -Tail 15 | ForEach-Object { Add-Content -Path $LogFile -Value "    $_" -Encoding UTF8 } }
            if ($p.ExitCode -ne 0) { Write-UpdateLog "The installer of $new ended with exit code $($p.ExitCode)." }
            $installed = ($p.ExitCode -eq 0) -and (Test-Answer $new)
            if ($p.ExitCode -eq 0 -and -not $installed) { Write-UpdateLog "RepoPulse $new did not answer after the update." }
        } catch { Write-UpdateLog "Installing $new failed: $($_.Exception.Message)" }

        if ($installed) {
            Write-UpdateLog "RepoPulse $new is installed and running (was $current)."
            Save-Result 'updated' $current $new
            return 0
        }

        Write-UpdateLog "Putting $current back"
        try {
            Stop-RepoPulse
            Copy-Folder $Backup $AppDir
            Start-ScheduledTask -TaskName $TaskName
        } catch { Write-UpdateLog "Rollback step failed: $($_.Exception.Message)" }
        if (Test-Answer $current) {
            Write-UpdateLog "RepoPulse $current is running again."
            Save-Result 'rolled-back' $current $new
        } else {
            Write-UpdateLog "ROLLBACK FAILED: RepoPulse does not answer. The previous program is in $Backup; copy it back into $AppDir (robocopy /MIR) and run Start-ScheduledTask $TaskName"
            Save-Result 'failed' $current $new
        }
        return 1
    } finally {
        Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    }
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host 'Error: run as administrator.'; exit 1 }
if (-not (Test-Path $Conf)) { Write-Host "Automatic updates are not set up ($Conf is missing). Run install.ps1 -EnableAutoUpdate in C:\Program Files\RepoPulse."; exit 1 }
$AppDir = $null
foreach ($line in Get-Content $Conf) { if ($line -match '^APP_DIR=(.+)$') { $AppDir = $Matches[1].Trim().TrimEnd('\') } }
$Python = if ($AppDir) { Join-Path $AppDir 'python\python.exe' } else { $null }
if (-not $AppDir -or -not (Test-Path $Python)) { Write-Host "Error: RepoPulse is not installed in '$AppDir'."; exit 1 }

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
