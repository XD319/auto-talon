# Skills

Skill roots:

- Project: `.auto-talon/skills`
- Repository: `.agents/skills` from the workspace and parent directories
- Local: `~/.auto-talon/skills` (or `AGENT_SKILLS_HOME`)
- Plugin bundles: `.auto-talon/plugins/<plugin>/skills`

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
- `talon skills promote <draft_id>`

Local plugin bundles can package skills and MCP server declarations under
`.auto-talon/plugins/<plugin>`. The skill registry reads bundled skills from
the same runtime path instead of using a separate install mechanism.
