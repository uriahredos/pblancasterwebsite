# Updates PB Portal to the newest version of the code and restarts it.
# Run in an elevated PowerShell. The site is down for under a minute. The site itself keeps a checked copy of the
# database "before an update" the first time the new version starts.
param(
  [string]$Root = 'D:\PBPortal',
  [string]$Service = 'PBPortal',
  [string]$Branch = 'main'
)
$ErrorActionPreference = 'Stop'
$site = Join-Path $Root 'site'
$envFile = Join-Path $Root 'portal.env'
Set-Location $site

git fetch origin $Branch
$new = (git rev-parse "origin/$Branch").Trim()
$old = (git rev-parse HEAD).Trim()
if ($new -eq $old) { Write-Host 'Already up to date.'; exit 0 }

nssm stop $Service
git checkout --force $new
npm ci --omit=dev
# Tell the site which version it now is, so it takes its "before an update" copy.
(Get-Content $envFile) -replace '^APP_VERSION=.*$', "APP_VERSION=$new" | Set-Content $envFile
nssm start $Service

Start-Sleep -Seconds 8
$ok = (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3000/healthz').Content
Write-Host "Now on $($new.Substring(0,7)) (was $($old.Substring(0,7))). Health check: $ok"
Write-Host "To go back: git checkout --force $old; npm ci --omit=dev; then restart the service."
