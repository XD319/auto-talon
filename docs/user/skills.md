# Skills

Skill layers (precedence high → low; later layers override earlier when `namespace/name` collide):

1. **Team** (enforced): configured via `skills.teamRoots` or `AGENT_TEAM_SKILLS_HOME`. Skills with `required: true` cannot be disabled.
2. **Project / repo**: `.auto-talon/skills` and `.agents/skills` (workspace + parent directories)
3. **User global**: `~/.auto-talon/skills` (or `AGENT_SKILLS_HOME`)
4. **Builtin**: package-shipped skills under `<package>/skills` (or `skills.builtinRoot` / `AGENT_BUILTIN_SKILLS_ROOT`)

**Plugins** live under `.auto-talon/plugins/<plugin>/skills` and are **namespaced** as `plugin:<plugin>/<namespace>/<name>`, so they do not shadow other layers.

Default precedence (low → high merge order): `builtin` → `local` → `project` → `team`. Override with `skills.precedence` or `AGENT_SKILLS_PRECEDENCE`.

Each skill folder contains `SKILL.md` and optional attachments:

- `references/`
- `templates/`
- `scripts/`
- `assets/`

`SKILL.md` supports the Agent Skills minimum frontmatter:

```md
---
name: release-notes
description: Draft release notes for a change set.
---
```

AutoTalon-specific metadata remains supported. Missing fields are normalized to
safe defaults. A skill can opt out of implicit invocation with
`disable-model-invocation: true`; explicit `$skill-name` invocation still works.

Set `required: true` on team skills that must stay available (disable overrides are ignored).

Explicit invocation supports simple argument replacement:

- `$ARGUMENTS` and `$0` expand to the full argument string.
- `$1`, `$2`, ... expand to whitespace-separated arguments.

Skill tool constraints can be declared with `allowed-tools` and
`disallowed-tools`. These constraints only affect tool exposure; they do not
bypass policy, sandbox, or approval checks.

Commands:

- `talon skills list`
- `talon skills view <skill_id> --with references,templates`
- `talon skills enable <skill_id>`
- `talon skills disable <skill_id>`
- `talon skills draft --from-experience <experience_id>`
- `talon skills promote <draft_id> [--target project|user|team]`
- `talon skill rollback <skill_id> --reason "<text>"`

Promotion target layers:

- `project` (default) → `.auto-talon/skills` (`project:...`)
- `user` → `~/.auto-talon/skills` (`local:...`)
- `team` → first configured team root (`team:...`)

Local plugin bundles can package skills and MCP server declarations under
`.auto-talon/plugins/<plugin>`. The skill registry reads bundled skills from
the same runtime path instead of using a separate install mechanism.
