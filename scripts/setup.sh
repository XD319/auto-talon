#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

echo "[auto-talon] Checking Node.js..."
if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is not installed." >&2
  exit 2
fi

NODE_VERSION="$(node -p 'process.versions.node')"
echo "[auto-talon] Node version: ${NODE_VERSION}"
node -e 'const [maj,min]=process.versions.node.split(".").map(Number); if(maj<22||(maj===22&&min<5)){process.exit(1)}'

echo "[auto-talon] Enabling corepack..."
corepack enable

echo "[auto-talon] Installing dependencies..."
corepack pnpm install

echo "[auto-talon] Building..."
corepack pnpm build

echo "[auto-talon] Bootstrapping workspace config..."
corepack pnpm dev init --yes --cwd "${ROOT_DIR}"

echo "[auto-talon] Setup completed."
echo "Try: corepack pnpm dev run \"hello\" --cwd \"${ROOT_DIR}\""
