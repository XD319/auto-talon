# Windows troubleshooting

## Code search (`rg` / ripgrep)

`code_search` prefers **ripgrep** (`rg`) when it is on `PATH`. On Windows, if `rg` is missing, the tool falls back to a slower Node.js directory walk.

Install ripgrep and ensure `rg --version` works in the same shell you use for `talon`:

- [Ripgrep releases](https://github.com/BurntSushi/ripgrep/releases) — add the install directory to `PATH`
- Or via package manager: `winget install BurntSushi.ripgrep.MSVC` / `choco install ripgrep`

Run `talon doctor` (or `talon config doctor`) after installing; the report should no longer warn about missing `rg`.

## PowerShell execution policy

If `npm` scripts fail with execution policy errors, run setup from an elevated or current-user scope:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

See also `docs/user/install.md` for `./scripts/setup.ps1`.

## SQLite locking

If CLI commands fail with `database is locked` while another `talon` process is running, stop the other process or wait for the writer to finish. The runtime uses WAL mode with a busy timeout, but long-running tasks can still hold write locks.

## Gateway rate limits

Gateway token-bucket state is persisted in SQLite (`gateway_rate_limits`) with a one-hour TTL, so rate limits survive process restarts within that window. Tune burst/refill in `.auto-talon/gateway.config.json` under `rateLimit`.
