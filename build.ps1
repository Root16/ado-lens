$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$manifestPath = Join-Path $repoRoot "manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($manifest.version)) {
    throw "manifest.json does not contain a version."
}

$distPath = Join-Path $repoRoot "dist"
$zipPath = Join-Path $distPath ("ado-lens-{0}.zip" -f $manifest.version)

New-Item -ItemType Directory -Path $distPath -Force | Out-Null
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

$packageFiles = @(
    (Join-Path $repoRoot "manifest.json"),
    (Join-Path $repoRoot "settings.html"),
    (Join-Path $repoRoot "settings.js"),
    (Join-Path $repoRoot "src")
)

Compress-Archive -LiteralPath $packageFiles -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host "Created $zipPath"
