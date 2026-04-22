# Sandbox Troubleshooting

- Path denied: ensure path is inside workspace/read/write roots.
- Shell command denied: check allowlist or command chaining restrictions.
- Docker mode failure: verify Docker daemon and image availability.
- Web fetch blocked: confirm `allowedFetchHosts`.

Checks:

- `agent sandbox`
- `agent doctor`
