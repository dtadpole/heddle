---
title: Live health
version: 2.2.0
description: One read-only pass over the address the owner uses for heddle - the gate, the server behind it, the served build, a streamed turn and the console - and over the owner's Rust preview, pinned for the record.
grounded_in:
  - source: the live-monitor seat's responsibilities, 2026-10-22
  - source: the heddle web gate's entry point in the dsh-web-ops tree, read 2026-10-22
created: 2026-10-23T03:19:02Z
modified: 2026-10-25T14:32:52Z
---

# `live-health`

Instance of [`_tools_`](../INDEX.md). **One read-only pass per run** over `http://127.0.0.1:8082/` and the
Rust preview on `3097`, judged in a real browser and appended to
[`../../_context_/rust-port/live-health.jsonl`](../../_context_/rust-port/live-health.jsonl).

**Surface: headless.** The pass drives [`../browser-use/`](../browser-use/INDEX.md) in its own session
(`hd-live-monitor`) and closes the browser when it ends. It never restarts, kickstarts or kills anything.

## What belongs in it

| File | What it is |
|---|---|
| [`probe.mjs`](probe.mjs) | the pass: reads the page, the deployment and its logs, calls the rules, pins the record |
| [`rules.mjs`](rules.mjs) | every judgment, as a pure function |
| [`summary.mjs`](summary.mjs) | the pinned record as a table |
| [`_tests_/`](_tests_/INDEX.md) | the unit tests of the rules |
| [`checks.md`](checks.md) | what each check claims and how it decides |
| [`outages.md`](outages.md) | how a down reading becomes a restart or an outage, and who hears of it |

## Run it

```bash
node _tools_/live-health/probe.mjs --pin        # one pass, appended to the record
node _tools_/live-health/probe.mjs --json       # the whole record of one pass
node _tools_/live-health/probe.mjs --pin --no-preview-turn   # the preview's turn paused, by its owner's request
node _tools_/live-health/probe.mjs --pin --deployment-conversation   # 8082 also gets a follow-up on the same page
node _tools_/live-health/summary.mjs --last=12  # the newest passes as a table
node --test _tools_/live-health/_tests_/pass-rules/unit.test.mjs
```

## Read next

[`checks.md`](checks.md), then [`outages.md`](outages.md); the record is introduced in
[`../../_context_/rust-port/live-health.md`](../../_context_/rust-port/live-health.md).
