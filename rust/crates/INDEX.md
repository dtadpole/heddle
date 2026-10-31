---
title: Rust crates
version: 0.1.0
description: The crates of the Rust port, one folder per crate, one owner per crate.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
---

# `rust/crates`

One folder per crate, all members of [`../Cargo.toml`](../Cargo.toml). A crate is one owner's write scope, so
parallel work never shares a file; a crate depends on another through its public API.

| Crate | What it ports |
|---|---|
| [`heddle/`](heddle/INDEX.md) | the binary: the command line every verifier runs, and the boot that composes the crates |
| [`heddle-config/`](heddle-config/INDEX.md) | the configuration tree — profiles, patch layers, includes, environment references, validation and provenance |
| [`heddle-events/`](heddle-events/INDEX.md) | the event bus and the named hook points, with the emit, parallel, bail and waterfall modes |
| [`heddle-session/`](heddle-session/INDEX.md) | the append-only session log, its store layouts, transcripts, definitions and the session tree |
| [`heddle-workspace/`](heddle-workspace/INDEX.md) | workspaces, the folders they name, and the classified recursive tree |
| [`heddle-llm/`](heddle-llm/INDEX.md) | the backend wire shapes, the HTTP client, streamed content and reasoning deltas, model info and usage |
| [`heddle-context/`](heddle-context/INDEX.md) | the surface over the log, the window budget, pruning and compaction |
| [`heddle-tools/`](heddle-tools/INDEX.md) | the tool registry, the built-in tools, outside tools as processes, and `bash`'s background seam |
| [`heddle-agent/`](heddle-agent/INDEX.md) | the agentic loop, turns and subagents |
| [`heddle-sandbox/`](heddle-sandbox/INDEX.md) | the permission modes, their enforcement backends, escalation and approvals |
| [`heddle-goal/`](heddle-goal/INDEX.md) | session goals, their driver and their tool |
| [`heddle-todo/`](heddle-todo/INDEX.md) | the todo list and its tool |
| [`heddle-team/`](heddle-team/INDEX.md) | durable teams, their policy, state and tool |
| [`heddle-schedule/`](heddle-schedule/INDEX.md) | reminders a session sets for itself, their delivery, the time-context reading, and the page's routes |
| [`heddle-jobs/`](heddle-jobs/INDEX.md) | background jobs — the registry and its output ring, the three job tools, background `bash`, completion notices and the page's job routes |
| [`heddle-server/`](heddle-server/INDEX.md) | the HTTP server, the token, the live stream and the page it serves |
| [`heddle-web-trajectory/`](heddle-web-trajectory/INDEX.md) | the trajectory view routes, the ledger and log download |
| [`heddle-web-composer/`](heddle-web-composer/INDEX.md) | the composer routes — runtime context, the context view, the model switcher and the tool catalog |
| [`heddle-web-files/`](heddle-web-files/INDEX.md) | attachments, uploads, the picker, file previews, markdown, highlighting and sanitizing |

## Read next

[`../INDEX.md`](../INDEX.md) for how the workspace is built and judged.
