---
title: heddle-web-trajectory test fixtures
created: 2026-10-23T04:18:47Z
modified: 2026-11-01T09:08:17Z
version: 1.5.0
description: Session logs the TypeScript build wrote for the exact scenarios the Trajectory verifiers run, the script that records them again, and the hand-written logs both projections are judged on.
grounded_in:
  - source: the TypeScript build's src/cli.ts at main a819f5f, run from source with Node 24 on 2026-10-22
  - source: _verifiers_/85-trajectory-view/check.mjs and _verifiers_/80-web-ui/check-trajectory-view.mjs, check-runtime-context.mjs, check-composer.mjs (the statistics dock)
---

# `fixtures`

Input **data** for [`../verifier_expectations.rs`](../verifier_expectations.rs): each `80-` and `85-` `.jsonl` is a
session log as the TypeScript build wrote it, one JSON event per line. Recorded rather than hand-written, so the tests judge what
the harness **actually records** — runtime-context notes, `model/request` with its estimate, the `call-<tool>` ids —
instead of restating this crate's assumptions.

| File | The scenario of |
|---|---|
| [`85-run-pwd-and-answer.jsonl`](85-run-pwd-and-answer.jsonl) | `85-trajectory-view`: the scripted model calls `bash pwd`, then answers |
| [`80-list-dir-two-turns.jsonl`](80-list-dir-two-turns.jsonl) | check-trajectory-view: two prompts, each calling `list_dir` on a folder holding `a.txt` and `b.txt` |
| [`80-composer-stats-two-turns.jsonl`](80-composer-stats-two-turns.jsonl) | check-composer's dock: two prompts against its chat double, reporting 1000 prompt tokens (800 cached) and 50 output tokens per round, in a 2000-token window |
| [`record.mjs`](record.mjs) | records all three again: `node record.mjs --checkout <TypeScript checkout> --out <dir>` |
| [`timeline-records.jsonl`](timeline-records.jsonl), [`timeline-records.expected.json`](timeline-records.expected.json) | hand-written: a timed two-turn log (a request, its first token 300 ms later, a tool call, a running second turn) and the timeline `records` both builds must produce; read by [`../timeline_records.rs`](../timeline_records.rs) and `test/ledger.test.ts` |
| [`between-turns.jsonl`](between-turns.jsonl), [`between-turns.expected.json`](between-turns.expected.json) | hand-written in the shape of a log the TypeScript build wrote on 2026-10-31: `/permission` before the first prompt, `/compact` with its `compaction/start` and `compaction/failed` between two turns, `/export` after the last, and the row placement both builds must produce; read by [`../between_turns.rs`](../between_turns.rs), `test/ledger.test.ts` and `test/page-ledger-rows.test.ts` |
| [`attachments.jsonl`](attachments.jsonl), [`attachments.expected.json`](attachments.expected.json) | hand-written in the TypeScript build's message shape: a prompt with text, an image, a zero-byte file, an unnamed image, a repeat and a part with no stored path, then an attachment-only prompt; and the user rows' text and attachments both builds must produce; read by [`../attachments.rs`](../attachments.rs) and `test/ledger.test.ts` |
| [`pruned-result.jsonl`](pruned-result.jsonl) | hand-written in the shape `src/context/prune.ts` writes, with the original shortened: a `read_file` result, the `compaction/prune` that shadows it, and its cut copy as a second `message` for the same call marked `surfaceOp: {"op": "replace"}` (#186). Read by [`../pruned_result.rs`](../pruned_result.rs), `test/ledger.test.ts`, `test/web.test.ts` and `heddle-server`'s `transcript.rs`: each view keeps one tool row holding the original and draws the copy nowhere |

The committed logs carry the paths of their recording homes (`/tmp/heddle-recorded-*`). A re-recording on main
8072846 matched them event for event: types, roles, tool-call ids, fields and reported usage.

## Read next

[`../INDEX.md`](../INDEX.md); [`../../VERIFICATION.md`](../../VERIFICATION.md).
