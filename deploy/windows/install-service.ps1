# Installs PB Portal as a Windows service that starts with the server and restarts if it stops.
# Run once, in an elevated PowerShell, after the steps in README.md. Needs NSSM (https://nssm.cc) on the PATH.
param(
  [string]$Root = 'D:\PBPortal',
  [string]$Service = 'PBPortal'
)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node).Source
$site = Join-Path $Root 'site'
$envFile = Join-Path $Root 'portal.env'
$logs = Join-Path $Root 'logs'
if (-not (Test-Path $envFile)) { throw "Missing $envFile. Copy deploy\windows\portal.env.example there and fill it in." }
New-Item -ItemType Directory -Force -Path $logs, (Join-Path $Root 'data') | Out-Null

nssm install $Service $node "--env-file=`"$envFile`"" 'app\server.js'
nssm set $Service AppDirectory $site
nssm set $Service DisplayName 'PB Portal'
nssm set $Service Description 'Pye-Barker employee portal'
nssm set $Service Start SERVICE_AUTO_START
nssm set $Service AppStdout (Join-Path $logs 'portal.log')
nssm set $Service AppStderr (Join-Path $logs 'portal.log')
nssm set $Service AppRotateFiles 1
nssm set $Service AppRotateBytes 10485760
# Ask the site to stop cleanly (it finishes what it is writing) before Windows ends it.
nssm set $Service AppStopMethodConsole 20000
nssm set $Service AppExit Default Restart
nssm start $Service
Start-Sleep -Seconds 5
(Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3000/healthz').Content
