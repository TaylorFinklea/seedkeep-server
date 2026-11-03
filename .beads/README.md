# Beads - AI-Native Issue Tracking

Welcome to Beads! This repository uses **Beads** for issue tracking - a modern, AI-native tool designed to live directly in your codebase alongside your code.

## What is Beads?

Beads is issue tracking that lives in your repo, making it perfect for AI coding agents and developers who want their issues close to their code. No web UI required - everything works through the CLI and integrates seamlessly with git.

**Learn more:** [github.com/steveyegge/beads](https://github.com/steveyegge/beads)

## Quick Start

### Essential Commands

This repository's Beads store is local-only. Pass `--sandbox` to every command so Beads does not sync or push to a Dolt remote.

```bash
# Find available local work
bd --sandbox ready

# Create an issue
bd --sandbox create --title="Add user authentication" --type=task --priority=2

# View issues and details
bd --sandbox list
bd --sandbox show <issue-id>

# Claim and complete an issue
bd --sandbox update <issue-id> --claim
bd --sandbox close <issue-id> --reason="Completed"
```

### Working with Issues

Issues in Beads are:
- **Local-only here**: Stored in this repository's embedded Dolt database; no remote is configured
- **AI-friendly**: CLI-first design works with AI coding agents
- **Offline-ready**: The local queue works without a network connection

## Why Beads?

✨ **AI-Native Design**
- Built specifically for AI-assisted development workflows
- CLI-first interface works seamlessly with AI coding agents
- No context switching to web UIs

🚀 **Developer Focused**
- The issue database lives under `.beads/` beside the code
- Works offline and stays local to this checkout
- Fast, lightweight, and stays out of your way

🔧 **Local Storage**
- The embedded Dolt database is ignored by Git
- No Dolt remote is configured for this repository
- Use `bd --sandbox` for every issue command

## Get Started with Beads

This checkout already has its local store initialized. Run `bd --sandbox quickstart` for CLI usage; keep `--sandbox` on all Beads commands.

## Learn More

- **Documentation**: [github.com/steveyegge/beads/docs](https://github.com/steveyegge/beads/tree/main/docs)
- **Quick Start Guide**: Run `bd --sandbox quickstart`
- **Examples**: [github.com/steveyegge/beads/examples](https://github.com/steveyegge/beads/tree/main/examples)

---

*Beads: Issue tracking that moves at the speed of thought* ⚡
