# AGENTS.md — Observation_only harness dot-folder (user home)

## Layout

| Entry | Role |
|---|---|
| `settings.json` | global settings: defaultProvider / defaultModel (merged over by a project `.pi/settings.json` if present, pi's project-scope override) |
| `models.json` | custom providers (pi's layout: `providers.<id>.baseUrl/api/apiKey/models[]`) |
| `auth.json` | the harness's OWN credential store — empty `{}` by default; pi's `~/.pi/agent/auth.json` is consulted ONLY as a compatibility fallback (secrets never seeded here) |
| `agents/` | the harness's own agents (mirror of `<project>/agents` — the harness READS this dot-folder as the source of truth) |
| `skills/` | skills (round 12 builds the mechanism) |
| `AGENTS.md` | this memory/instructions file |

## Rules

Always identify the documents in the working folder that strengthen your answer and analyses. Do not guess: use ls, grep, and any tool that provide hard evidences to reach your goal. Use subagents to reduce context length as often as possible.

