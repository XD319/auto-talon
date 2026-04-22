# Skills

Skill roots:

- Project: `.auto-talon/skills`
- Local: `~/.auto-talon/skills` (or `AGENT_SKILLS_HOME`)

Each skill folder contains `SKILL.md` and optional attachments:

- `references/`
- `templates/`
- `scripts/`
- `assets/`

Commands:

- `agent skills list`
- `agent skills view <skill_id> --with references,templates`
- `agent skills enable <skill_id>`
- `agent skills disable <skill_id>`
- `agent skills draft --from-experience <experience_id>`
- `agent skills promote <draft_id>`
