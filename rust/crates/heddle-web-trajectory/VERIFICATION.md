---
title: heddle-web-trajectory verification
created: 2026-10-23T05:09:00Z
modified: 2026-10-23T14:20:19Z
level: L2
version: 1.1.0
description: The evidence that heddle-web-trajectory answers as the TypeScript build does, each item with how to repeat it, and what the binary still lacks.
status: unverified
grounded_in:
  - source: src/server/ledger.ts, src/server/log-download.ts, src/server/web.ts as the reference
  - source: tests/verifier_expectations.rs and tests/fixtures/ in this crate
---

# heddle-web-trajectory verification

Every item below was run, not reasoned; re-run a check rather than trust a stored output.

| What | Result | Repeat with |
|---|---|---|
| Unit tests | 65, including every `ledger.test.ts` case; the number formatter's own tests are heddle-web-composer's | `_tools_/local-build/run test -p heddle-web-trajectory` |
| Verifier expectations | 6 tests: every API assertion of `85-trajectory-view`, check-trajectory-view, check-runtime-context and check-composer's dock, on logs the TypeScript CLI recorded for those exact scenarios | the same command; the logs are in [`tests/fixtures/`](tests/fixtures/INDEX.md) |
| Differential | ledger, rows, timeline and stats equal to `src/server/ledger.ts` on 26 logs (15 synthetic, 8 live, 3 fixtures) | [`examples/`](examples/INDEX.md): `project_log`, then `ts_projection.mjs <log> <rust.json>` |
| Real server (2026-10-22) | through the real heddle-server router and door, 27 sessions: `?view=ledger`, stats, `/log` and its headers identical to `src/server/web.ts`; refusals `400`, `404`, and `401` without the cookie | a scratch probe, not kept |
| Rust-recorded logs (2026-10-22) | the binary's agent runtime (branch commit ad04b9a) records the verifiers' scenarios event for event as the TypeScript build does; the 14 trajectory assertions hold on them | a scratch probe, not kept |

Two divergences were found this way and fixed, each pinned by a unit test: a float read one ulp off without
`serde_json`'s `float_roundtrip` (now in the workspace entry), and numbers printed `1.0` where JavaScript prints
`1` (fixed by a JavaScript number formatter written here and now kept, with its tests, in heddle-web-composer's
`js` module, which this crate uses).

## Through the binary

Main's own binary, unedited, through `HEDDLE_BIN` (2026-10-23, main bc3ce8b and every later main that touched
`web.rs`, `heddle-server` or this crate, to d4e584f): `85-trajectory-view` 2/2, check-trajectory-view 1/1,
check-runtime-context 1/1, none skipped, each read twice. On the same build of
709bee6 the composer-side checks read check-composer 25/25, check-context-view 2/2, check-model-switcher 5/5.
Repeat with a debug build of main and `node _tools_/verify-runner/run.mjs <check>`; the lane gate's readings are
in each verifier's `readings.md`.

## Read next

[`API.md`](API.md); [`tests/`](tests/INDEX.md).
