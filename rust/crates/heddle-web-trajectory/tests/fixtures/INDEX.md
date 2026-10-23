---
title: heddle-web-trajectory test fixtures
version: 1.0.0
description: Session logs the TypeScript build wrote for the exact scenarios the Trajectory verifiers run, used to pin the verifiers' API expectations against this crate's projection.
grounded_in:
  - source: the TypeScript build's src/cli.ts at main a819f5f, run from source with Node 24 on 2026-10-22
  - source: _verifiers_/85-trajectory-view/check.mjs and _verifiers_/80-web-ui/check-trajectory-view.mjs, check-runtime-context.mjs
---

# `fixtures`

Input **data** for [`../verifier_expectations.rs`](../verifier_expectations.rs), not tests. Each file is a session
log as the TypeScript build wrote it, decoded from its zstd frames into one JSON event per line, byte for byte.

| File | Scenario | Recorded with |
|---|---|---|
| [`85-run-pwd-and-answer.jsonl`](85-run-pwd-and-answer.jsonl) | `85-trajectory-view`'s turn: the scripted model calls `bash {"command":"pwd"}`, then answers `the answer` | one `--turn "run pwd and answer"` |
| [`80-list-dir-two-turns.jsonl`](80-list-dir-two-turns.jsonl) | `80-web-ui check-trajectory-view`'s session: two prompts in one session, each calling `list_dir` on a folder holding `a.txt` and `b.txt` | `--turn "what is in here"`, then `--resume <id> --turn "and again"` |

Why recorded bytes rather than events written by hand: the claim is that the verifiers' assertions hold on what the
harness **actually records** — runtime-context notes, `model/request` with its estimate and breakdown, the
`call-<tool>` id the scripted endpoint gives a call — and a hand-written log would only restate this crate's
assumptions. The same logs projected by `src/server/ledger.ts` and by this crate give identical ledgers, rows,
timelines and statistics (the crate INDEX's differential procedure).

## How they were recorded

From a checkout of the TypeScript sources with its `node_modules`, for each scenario a fresh `$H`, a work folder
holding `a.txt` and `b.txt`, a scripted endpoint whose `script.json` holds the scenario's steps, and the run started
**in the work folder** as the verifiers start theirs:

```sh
cd "$H/work" && HEDDLE_HOME="$H" HEDDLE_CONFIG="$H/heddle.json" NO_COLOR=1 \
  node <checkout>/src/cli.ts --config <checkout>/cordis.yml --session-root "$H/sessions" \
  --sandbox-root "$H/work" --endpoint scripted --turn "<prompt>"
zstd -dc "$H"/sessions/*/*.v2.jsonl.zstd > <fixture>.jsonl
```

`$H` was `/tmp/heddle-recorded-85` and `/tmp/heddle-recorded-80`, which is why those paths appear in the logs.
`heddle.json` is `{"default":"scripted","endpoints":[{"name":"scripted","kind":"scripted","baseUrl":"$H/script.json","model":"scripted"}]}`,
the shape `_tools_/verify-runner/lib.mjs`'s `scriptedConfig` writes.
