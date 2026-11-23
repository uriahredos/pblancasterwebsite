# Copies the site's nightly backups off the server. Schedule it (Task Scheduler) for after the backup hour, e.g. 3 am.
# The copies are already encrypted with the database key; whoever holds the key can open them.
param(
  [string]$Root = 'D:\PBPortal',
  [Parameter(Mandatory = $true)][string]$To     # e.g. \\fileserver\backups\pbportal
)
$ErrorActionPreference = 'Stop'
robocopy (Join-Path $Root 'data\backups') $To *.db /R:2 /W:5 /NP /NFL /NDL | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Backup copy failed (robocopy code $LASTEXITCODE)." }
exit 0
