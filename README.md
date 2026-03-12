<p align="center">
  <img src="aegis-banner.svg" alt="Aegis — Structured governance for AI agents" width="900" />
</p>

<p align="center">
  <strong>The reference implementation of the <a href="https://github.com/cleburn/aegis-spec">Aegis governance spec</a>.</strong>
</p>

<p align="center">
  Run <code>aegis init</code>, have a conversation, and give every AI agent that touches your codebase a structured operating contract. Schema-validated, machine-parseable, agent-agnostic.
</p>

---

## What It Does

Aegis CLI scans your codebase, conducts a discovery conversation, and generates a complete `.agentpolicy/` directory conforming to the [Aegis governance specification](https://github.com/cleburn/aegis-spec).

You don't write policy files by hand. You talk to Aegis — it asks sharp questions about your project, your priorities, your boundaries — and compiles your answers into structured, schema-validated JSON that any agent can parse deterministically.

## Quick Start

```bash
# Install
npm install -g aegis-cli

# Start the discovery conversation
aegis init

# Have Aegis explain the current policy in plain language
aegis explain

# Validate policy files against the schema
aegis validate
```

## How `aegis init` Works

Run it in your project root. Aegis scans your repo — not just the file tree, but the actual contents of your config files, documentation, CI workflows, and project structure. By the time the conversation starts, Aegis already knows your stack, your architecture, your build pipeline, and your patterns.

If Aegis detects files that look sensitive — environment variables, credentials, database files — it skips them and tells you what it chose not to read. You decide whether it needs access.

From there, the conversation is focused and specific. Aegis doesn't ask what language you're using — it already knows. Instead, it asks about the things it can't infer from code alone:

- Your guiding principles and what's non-negotiable
- How much autonomy agents should have across different domains
- Which files are sacred and which are fair game
- How you want agents to coordinate when multiple roles are in play
- What should happen when an agent hits ambiguity or a gap in the rules

The conversation moves fast. When Aegis has the full picture, your `.agentpolicy/` directory appears — complete, schema-validated, and ready for every agent that works here next.

## Return Visits

Run `aegis init` again in a repo that already has `.agentpolicy/` and Aegis picks up where you left off. No full rediscovery — it reads the existing policy, asks what's changed, and updates only what needs updating.

## The `.agentpolicy/` Format

This CLI generates files conforming to the [Aegis governance specification](https://github.com/cleburn/aegis-spec). The spec defines four file types:

| File | Purpose |
|------|---------|
| `constitution.json` | Project identity, tech stack, principles, build commands |
| `governance.json` | Autonomy levels, permissions, conventions, quality gates, escalation |
| `roles/*.json` | Scoped role definitions with collaboration protocols |
| `state/ledger.json` | Shared operational state and task tracking |

See the [spec repo](https://github.com/cleburn/aegis-spec) for full schema documentation, design principles, and examples.

## Requirements

- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com/)

On first run, Aegis will prompt for your API key and store it locally.

## License

MIT

Built by [Cleburn Walker](https://github.com/cleburn) as the reference implementation of the [Aegis governance specification](https://github.com/cleburn/aegis-spec).
