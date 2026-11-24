# get-node.ps1
# Downloads a portable Node.js runtime into .\runtime\node.exe so that the
# launcher bat (see README, "快速开始") can start the server on a machine
# without Node installed.
#
# Usage (double-click or from PowerShell):
#     powershell -NoProfile -ExecutionPolicy Bypass -File .\get-node.ps1
#
# Notes:
#   * Messages are kept ASCII on purpose: Windows PowerShell 5.1 may misread
#     UTF-8 source without BOM.
#   * runtime\ is NOT tracked by git anymore. After this runs, runtime\node.exe
#     exists locally and is ignored by .gitignore.
#   * Mirrors are tried in order: npmmirror (fast in CN) -> npmmirror legacy
#     -> nodejs.org official.

$ErrorActionPreference = "Stop"
$Version = "v22.23.2"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RuntimeDir = Join-Path $Root "runtime"
$Target = Join-Path $RuntimeDir "node.exe"

if (Test-Path -LiteralPath $Target) {
    Write-Host "[ok] Node runtime already present:" $Target
    & $Target --version
    exit 0
}

$Sources = @(
    "https://registry.npmmirror.com/-/binary/node/$Version/node-$Version-win-x64.zip",
    "https://npmmirror.com/mirrors/node/$Version/node-$Version-win-x64.zip",
    "https://nodejs.org/dist/$Version/node-$Version-win-x64.zip"
)

$tmpZip = Join-Path $env:TEMP "node-$Version-win-x64.zip"
$tmpDir = Join-Path $env:TEMP "node-$Version-extract"

Write-Host "[..] downloading Node.js $Version (about 34 MB), please wait..."

$downloaded = $false
foreach ($url in $Sources) {
    try {
        Write-Host "     trying $url"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11
        Invoke-WebRequest -Uri $url -OutFile $tmpZip -UseBasicParsing -TimeoutSec 600
        if ((Get-Item -LiteralPath $tmpZip).Length -gt 20MB) {
            $downloaded = $true
            break
        }
    } catch {
        Write-Host ("     failed: " + $_.Exception.Message)
        if (Test-Path -LiteralPath $tmpZip) { Remove-Item -LiteralPath $tmpZip -Force -ErrorAction SilentlyContinue }
    }
}

if (-not $downloaded) {
    Write-Host ""
    Write-Host "[x] Could not download Node.js from any mirror." -ForegroundColor Red
    Write-Host "    Fix options:"
    Write-Host "      1) Turn the accelerator/proxy off (or on) and run this script again."
    Write-Host "      2) Install Node.js manually: https://nodejs.org/en/download"
    Write-Host "         After installing, the launcher will use the 'node' in PATH."
    exit 1
}

Write-Host "[..] extracting..."
if (Test-Path -LiteralPath $tmpDir) { Remove-Item -LiteralPath $tmpDir -Recurse -Force }
Expand-Archive -LiteralPath $tmpZip -DestinationPath $tmpDir -Force

$found = Get-ChildItem -LiteralPath $tmpDir -Recurse -Filter "node.exe" -File | Select-Object -First 1
if (-not $found) {
    Write-Host "[x] node.exe not found inside the downloaded archive." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $RuntimeDir)) { New-Item -ItemType Directory -Path $RuntimeDir | Out-Null }
Copy-Item -LiteralPath $found.FullName -Destination $Target -Force

Remove-Item -LiteralPath $tmpZip -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "[ok] installed:" $Target
& $Target --version
Write-Host "Done. Now double-click the launcher bat (see README)."
exit 0
