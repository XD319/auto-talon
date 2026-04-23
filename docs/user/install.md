# Install

## Requirements

- Node.js `>=22.13.0`
- Corepack enabled

Node 22.13.0 is the minimum because auto-talon uses the built-in `node:sqlite`
runtime storage module without an experimental flag. CI also runs a Node 20
compatibility-floor check to make sure older runtimes fail with a clear message.

## Quick Install

From npm:

```bash
npm install -g auto-talon
talon init --yes
```

From source:

```bash
corepack enable
corepack pnpm install
corepack pnpm build
corepack pnpm dev init --yes
```

Or use scripts:

- Linux/macOS: `bash scripts/setup.sh`
- Windows PowerShell: `./scripts/setup.ps1`

## Verify

```bash
talon version
talon doctor
```
