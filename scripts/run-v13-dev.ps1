param(
    [switch]$Optimized,
    [switch]$Build,
    [string]$TargetDirectory,
    [string]$ConfigDirectory,
    [ValidateRange(0, 65535)][int]$DebugPort = 0
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
if (-not $TargetDirectory) { $TargetDirectory = Join-Path (Split-Path $repo -Parent) 'cc-book-target-dev-0.12.13' }
if (-not $ConfigDirectory) { $ConfigDirectory = Join-Path $env:LOCALAPPDATA 'cc-panes-dev-v013' }
$env:CARGO_TARGET_DIR = [IO.Path]::GetFullPath($TargetDirectory)
$env:CCPANES_CONFIG_DIR = [IO.Path]::GetFullPath($ConfigDirectory)
$env:CCPANES_DAEMON_DATA_DIR = $env:CCPANES_CONFIG_DIR
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $env:CCPANES_CONFIG_DIR 'webview'
$env:CCPANES_TERMINAL_DAEMON = '1'
$env:CARGO_BUILD_JOBS = '4'
# An isolated DEV profile must not repeat migration cleanup in the user's CLI home.
$cleanupMarker = Join-Path $env:CCPANES_CONFIG_DIR 'skills\legacy-global-skill-cleanup-v1.json'
if (-not (Test-Path $cleanupMarker)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $cleanupMarker -Parent) | Out-Null
    [IO.File]::WriteAllText($cleanupMarker, '{"removed":[],"preserved":[],"failed":[],"scope":"isolated-dev"}')
}
# Orchestrator manifests and ports are independent of the installed application.
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$env:CC_PANES_ORCHESTRATOR_PORT = [string]$listener.LocalEndpoint.Port
$listener.Stop()
if ($DebugPort -gt 0) {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$DebugPort"
}
if ($Optimized) {
    if ($Build) {
        npm.cmd run tauri -- build --no-bundle --config src-tauri/tauri.v13.dev.conf.json
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    $binary = Join-Path $env:CARGO_TARGET_DIR 'release\cc-panes.exe'
    if (-not (Test-Path $binary)) { throw 'Build the isolated optimized app first, or pass -Build.' }
    & $binary
    exit $LASTEXITCODE
}
npm.cmd run tauri -- dev --config src-tauri/tauri.v13.dev.conf.json
exit $LASTEXITCODE
