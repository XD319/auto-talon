# Long-term memory

Long-term memory is **off by default**. Session transcripts and same-session summaries still remain in SQLite, but approved profile/project memory is not injected and the agent cannot submit memory suggestions until you enable it.

Use any interactive surface:

```text
/memory status
/memory on
/memory off
```

Or use the CLI:

```bash
talon memory status
talon memory on
talon memory off
```

The setting is stored in `.auto-talon/runtime.config.json` as `memory.enabled`. A change applies to the next task. A core-memory snapshot that was already frozen for a session is never rewritten mid-session.

When enabled, the agent may use the `memory` tool to propose `add`, `replace`, or `remove` changes for `profile` or `project` memory. Suggestions are queued for review; they never edit approved memory directly. Review them with `talon memory review-queue list` and accept or dismiss them explicitly.

Only stable preferences, project conventions, environment facts, corrections, and important decisions should be saved. Credential-like content, prompt injection, invisible Unicode controls, raw logs, temporary state, and easily reconstructed facts are rejected.

Maintenance and diagnostics:

```bash
talon memory doctor
talon memory maintenance rebuild --dry-run
talon memory maintenance rebuild --apply
```

`--apply` creates a timestamped SQLite backup before starting one transaction. It archives legacy candidate memory/experience data and creates review suggestions only for repeated, high-confidence evidence; it never auto-promotes a suggestion.

Relevant configuration defaults:

```json
{
  "memory": {
    "enabled": false,
    "core": {
      "profileTokenBudget": 500,
      "projectTokenBudget": 800
    },
    "flush": {
      "enabled": true,
      "maxSuggestions": 3
    },
    "search": {
      "provider": "fts"
    }
  }
}
```

The optional `openai_compatible` search provider accepts `endpoint`, `model`, `apiKeyEnv`, `dimensions`, `timeoutMs`, and `batchSize`. Restricted, rejected, archived, stale, or expired memory is never sent to an external embedding endpoint. Provider failures fall back to FTS.