# Contributing to AutoTalon

Thanks for your interest in AutoTalon. This guide covers developing from a
source checkout and validating a release. For usage, start with the
[README](README.md) and the [docs](docs/).

## Develop from source

Requirements:

- Node.js `>=22.13.0`
- Corepack (bundled with Node.js) to pin the pinned pnpm version

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm dev init --yes
corepack pnpm dev provider setup mock
corepack pnpm dev provider test
corepack pnpm dev tui
```

Use `corepack pnpm dev <command>` to run the CLI directly from TypeScript
sources without a global install.

## Quality checks

Run the full local suite before opening a pull request:

```bash
corepack pnpm check
```

`check` runs the architecture/gateway guards, lint, tests with coverage, and the
build. Keep it green.

## Maintainer diagnostics

These commands are for source checkouts, not installed-package users:

- `talon release check` — end-to-end release gate
- `talon eval run`, `talon eval acceptance` — blind real-model capability evals
- `talon smoke run` — deterministic scripted smoke suite

Installed-package users should instead start with `talon doctor` and
`talon provider test`.

## Release validation

Run these checks before tagging or publishing a release:

```bash
corepack pnpm check
npm run release:check
npm pack --dry-run --json
```

The full suite can take several minutes. `release check` prints its current
stage and gives each child command a ten-minute timeout. If `corepack pnpm
check` has already passed in the same clean checkout, skip repeating lint,
tests, and build:

```bash
npm run release:check -- --skip-quality-checks
```

Before publishing, confirm the npm identity, publish, then validate the exact
version from the registry:

```bash
npm whoami
npm publish --access public
npm install -g auto-talon@<version>
talon --version
talon doctor
```

After installing or updating a local project:

```bash
talon doctor
talon provider test
```

The release checklist covers lint, tests, build, smoke/eval threshold, beta
readiness, schema baseline, Node version policy, npm metadata, lockfile policy,
setup scripts, and package contents.
