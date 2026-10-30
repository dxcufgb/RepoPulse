<#
.SYNOPSIS
    Builds repopulse-<version>-setup.exe (and repopulse-setup.exe) with Inno Setup.

.DESCRIPTION
    Run on Windows (x64) with Python <PythonMinor> on PATH (or the py launcher) and Inno Setup 6 (choco install
    innosetup; installed when missing and Chocolatey is there):

        .\packaging\windows\build-setup.ps1 -Version 1.2.3 [-OutDir dist] [-PythonMinor 3.13]

    It stages the program files tracked by git (repopulse\, README.md, LICENSE, requirements.txt, config.example.json
    and install.ps1, auto-update.ps1, repopulse.cmd from this folder) with the version stamped in, like
    scripts/build-release.sh; adds the newest embeddable Python <PythonMinor>.x for Windows x64 from python.org, whose
    python.exe and DLL must carry a valid Authenticode signature of the Python Software Foundation; installs the
    packages of requirements.txt as Windows wheels into lib\; and compiles RepoPulse.iss into OutDir.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$OutDir = 'dist',
    [string]$PythonMinor = '3.13'
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Version = $Version -replace '^v', ''
if ($Version -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$') {
    throw "version '$Version' is not MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-PRERELEASE"
}
if ($PythonMinor -notmatch '^3\.\d+$') { throw "-PythonMinor must look like 3.13" }
$numeric = ($Version -replace '-.*$', '') + '.0'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$work = Join-Path ([IO.Path]::GetTempPath()) ('repopulse-setup-' + [Guid]::NewGuid().ToString('N'))
$stage = Join-Path $work 'RepoPulse'
New-Item -ItemType Directory -Path $stage | Out-Null

function Get-Python {
    foreach ($candidate in @(@('py', "-$PythonMinor"), @('python'))) {
        if (-not (Get-Command $candidate[0] -ErrorAction SilentlyContinue)) { continue }
        $extra = @($candidate | Select-Object -Skip 1)
        $v = & $candidate[0] @extra -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>$null
        if ("$v".Trim() -eq $PythonMinor) { return $candidate }
    }
    throw "Python $PythonMinor is needed to fetch the packages (the setup's Python is $PythonMinor)."
}

try {
    # 1. The program files, as committed, with the version stamped in.
    Push-Location $repo
    try {
        $files = @(& git ls-files -- README.md LICENSE requirements.txt config.example.json repopulse)
        if ($LASTEXITCODE -ne 0 -or $files.Count -eq 0) { throw 'git ls-files failed' }
    } finally { Pop-Location }
    foreach ($f in $files) {
        $target = Join-Path $stage $f
        New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
        Copy-Item -LiteralPath (Join-Path $repo $f) -Destination $target
    }
    foreach ($f in @('install.ps1', 'auto-update.ps1', 'repopulse.cmd')) { Copy-Item (Join-Path $PSScriptRoot $f) (Join-Path $stage $f) }
    $utf8 = New-Object Text.UTF8Encoding $false
    $init = Join-Path $stage 'repopulse\__init__.py'
    $text = [IO.File]::ReadAllText($init)
    $stamped = ([regex]'(?m)^__version__ = "[^"]*"').Replace($text, "__version__ = `"$Version`"", 1)
    if ($stamped -eq $text -and $text -notmatch "__version__ = `"$([regex]::Escape($Version))`"") { throw 'no __version__ line in repopulse\__init__.py' }
    [IO.File]::WriteAllText($init, $stamped, $utf8)
    $index = Join-Path $stage 'repopulse\static\index.html'
    [IO.File]::WriteAllText($index, ([regex]'\?v=[0-9A-Za-z.-]+').Replace([IO.File]::ReadAllText($index), "?v=$Version"), $utf8)

    # 2. The newest embeddable Python <PythonMinor>.x, signed by the Python Software Foundation.
    $ftp = 'https://www.python.org/ftp/python/'
    $listing = (Invoke-WebRequest -UseBasicParsing -Uri $ftp).Content
    $patches = [regex]::Matches($listing, 'href="' + [regex]::Escape($PythonMinor) + '\.(\d+)/"') |
        ForEach-Object { [int]$_.Groups[1].Value } | Sort-Object -Descending -Unique
    $zip = Join-Path $work 'python-embed.zip'
    $pyVersion = $null
    foreach ($patch in $patches) {
        $candidate = "$PythonMinor.$patch"
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$ftp$candidate/python-$candidate-embed-amd64.zip" -OutFile $zip
            $pyVersion = $candidate
            break
        } catch { Write-Verbose "no embeddable zip for $candidate yet" }
    }
    if (-not $pyVersion) { throw "python.org has no embeddable Python $PythonMinor.x for amd64" }
    $pyDir = Join-Path $stage 'python'
    Expand-Archive -LiteralPath $zip -DestinationPath $pyDir
    $tag = $PythonMinor -replace '\.', ''
    foreach ($binary in @('python.exe', "python$tag.dll")) {
        $sig = Get-AuthenticodeSignature -FilePath (Join-Path $pyDir $binary)
        if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O="?Python Software Foundation') {
            throw "$binary of Python $pyVersion is not validly signed by the Python Software Foundation ($($sig.Status))"
        }
    }
    # Where the bundled Python finds RepoPulse (..) and its packages (..\lib); it ignores PYTHONPATH and friends.
    [IO.File]::WriteAllText((Join-Path $pyDir "python$tag._pth"), "python$tag.zip`r`n.`r`n..`r`n..\lib`r`n", $utf8)
    Write-Information "Python $pyVersion (embeddable, signature verified)" -InformationAction Continue

    # 3. Flask and Waitress (and what they need) as Windows wheels for that Python.
    $py = Get-Python
    $pyExtra = @($py | Select-Object -Skip 1)
    & $py[0] @pyExtra -m pip install --disable-pip-version-check --no-compile --only-binary=:all: --platform win_amd64 `
        --python-version $PythonMinor --implementation cp --target (Join-Path $stage 'lib') -r (Join-Path $stage 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw "pip install failed (exit code $LASTEXITCODE)" }
    Remove-Item -Recurse -Force (Join-Path $stage 'lib\bin') -ErrorAction SilentlyContinue  # flask.exe launcher: not used

    # Smoke test: the staged program starts with the bundled Python.
    $out = & (Join-Path $pyDir 'python.exe') -c 'import repopulse, repopulse.app, waitress; print(repopulse.__version__)' 2>&1
    if ($LASTEXITCODE -ne 0 -or "$out".Trim() -ne $Version) { throw "the staged program does not load: $out" }

    # 4. The installer.
    $iscc = @(
        (Get-Command ISCC.exe -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    if (-not $iscc -and (Get-Command choco -ErrorAction SilentlyContinue)) {
        choco install innosetup -y --no-progress | Out-Host
        $iscc = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
    }
    if (-not $iscc -or -not (Test-Path -LiteralPath $iscc)) { throw 'ISCC.exe not found. Install Inno Setup 6 (choco install innosetup).' }
    & $iscc /Q "/DAppVersion=$Version" "/DNumericVersion=$numeric" "/DSourceDir=$stage" "/O$OutDir" (Join-Path $PSScriptRoot 'RepoPulse.iss')
    if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit code $LASTEXITCODE" }
    $exe = Join-Path $OutDir "repopulse-$Version-setup.exe"
    if (-not (Test-Path -LiteralPath $exe)) { throw "ISCC did not produce $exe" }
    Copy-Item -Force $exe (Join-Path $OutDir 'repopulse-setup.exe')
    Get-Item $exe, (Join-Path $OutDir 'repopulse-setup.exe')
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
