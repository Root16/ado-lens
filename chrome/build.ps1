$ErrorActionPreference = "Stop"
$projectRoot = $PSScriptRoot
$repoRoot = Split-Path $projectRoot -Parent
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot "manifest.json") -Raw | ConvertFrom-Json
$distPath = Join-Path $projectRoot "dist"
$stagePath = Join-Path $distPath "package"
$zipPath = Join-Path $distPath ("ado-lens-chrome-{0}.zip" -f $manifest.version)
if (Test-Path -LiteralPath $stagePath) { Remove-Item -LiteralPath $stagePath -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $stagePath "src") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot "manifest.json") -Destination (Join-Path $stagePath "manifest.json")
Copy-Item -LiteralPath (Join-Path $repoRoot "shared\settings.html"), (Join-Path $repoRoot "shared\settings.js") -Destination $stagePath
Copy-Item -LiteralPath (Join-Path $repoRoot "shared\src\lib.js"), (Join-Path $repoRoot "shared\src\content.js") -Destination (Join-Path $stagePath "src")
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path (Join-Path $stagePath "*") -DestinationPath $zipPath -CompressionLevel Optimal
Remove-Item -LiteralPath $stagePath -Recurse -Force
Write-Host "Created $zipPath"
