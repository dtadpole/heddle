---
title: heddle-web-trajectory test fixtures
created: 2026-10-23T04:18:47Z
modified: 2026-10-23T05:16:00Z
version: 1.2.0
description: Session logs the TypeScript build wrote for the exact scenarios the Trajectory verifiers run, and the script that records them again.
grounded_in:
  - source: the TypeScript build's src/cli.ts at main a819f5f, run from source with Node 24 on 2026-10-22
  - source: _verifiers_/85-trajectory-view/check.mjs and _verifiers_/80-web-ui/check-trajectory-view.mjs, check-runtime-context.mjs, check-composer.mjs (the statistics dock)
---

# `fixtures`

Input **data** for [`../verifier_expectations.rs`](../verifier_expectations.rs): each `.jsonl` is a session log as
the TypeScript build wrote it, one JSON event per line. Recorded rather than hand-written, so the tests judge what
the harness **actually records** — runtime-context notes, `model/request` with its estimate, the `call-<tool>` ids —
instead of restating this crate's assumptions.

| File | The scenario of |
|---|---|
| [`85-run-pwd-and-answer.jsonl`](85-run-pwd-and-answer.jsonl) | `85-trajectory-view`: the scripted model calls `bash pwd`, then answers |
| [`80-list-dir-two-turns.jsonl`](80-list-dir-two-turns.jsonl) | check-trajectory-view: two prompts, each calling `list_dir` on a folder holding `a.txt` and `b.txt` |
| [`80-composer-stats-two-turns.jsonl`](80-composer-stats-two-turns.jsonl) | check-composer's dock: two prompts against its chat double, reporting 1000 prompt tokens (800 cached) and 50 output tokens per round, in a 2000-token window |
| [`record.mjs`](record.mjs) | records all three again: `node record.mjs --checkout <TypeScript checkout> --out <dir>` |

The committed logs carry the paths of their recording homes (`/tmp/heddle-recorded-*`). A re-recording on main
8072846 matched them event for event: types, roles, tool-call ids, fields and reported usage.

## Read next

[`../INDEX.md`](../INDEX.md); [`../../VERIFICATION.md`](../../VERIFICATION.md).
