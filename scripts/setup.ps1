$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot
Set-Location $RootDir

Write-Host "[auto-talon] Checking Node.js..."
try {
  $nodeVersion = node -p "process.versions.node"
} catch {
  throw "node is not installed."
}
Write-Host "[auto-talon] Node version: $nodeVersion"
node -e "const [maj,min,patch]=process.versions.node.split('.').map(Number); if(maj<22||(maj===22&&(min<13||(min===13&&patch<0)))){process.exit(1)}"
if ($LASTEXITCODE -ne 0) {
  throw "Node.js >= 22.13.0 is required."
}

Write-Host "[auto-talon] Enabling corepack..."
corepack enable

Write-Host "[auto-talon] Installing dependencies..."
corepack pnpm install

Write-Host "[auto-talon] Building..."
corepack pnpm build

Write-Host "[auto-talon] Bootstrapping workspace config..."
corepack pnpm dev init --yes --cwd "$RootDir"

Write-Host "[auto-talon] Setup completed."
Write-Host "Try: corepack pnpm dev run `"hello`" --cwd `"$RootDir`""
