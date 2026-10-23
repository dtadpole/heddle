---
title: 96-deployment — readings
created: 2026-10-23T04:42:38Z
modified: 2026-10-23T06:20:46Z
level: L3
version: 1.1.0
description: The measured verdicts of 96-deployment on the Linux host and on the owner's Mac, before and after main accepted the detached deployment shape.
status: unverified
grounded_in:
  - source: runs of _verifiers_/96-deployment/verify.sh, 2026-10-22
---

# Readings

| When (2026-10-22) | Deployment | Verdict |
|---|---|---|
| before the move | Linux host, `~/heddle-live` detached at `origin/main`, the server on 8082 | 3 of 3; once failed as `detached at a8b08b7c403f, not at origin/main 8dbdcf83158f` after another seat moved `main`, and passed after the redeploy |
| 20:2x PDT, Mac | `a5b0c66`, the TypeScript build as the oracle, agent on 3082, gate on 8082 | main's checks 2 of 3 (the checkout is not on branch `main`); this verifier's branch checks 3 of 3 |
| after the tooling merge | `1bcff7e`, the agent running `supervisor.mjs` | 3 of 3 from `~/heddle-live`; with the agent booted out, verdict 3 (the checkout check passes, the other two are unjudged) |
| every redeploy since | each new `main`, by `redeploy.sh` | 3 of 3 |

**Through the Rust binary, a pre-reading, not a verdict.** 96 judges only the deployment the owner uses, and that still
serves the TypeScript build. At 23:19 PDT the binary-served 3097 preview (main `3c12b45`, built from the same checkout)
was held to check 2's own rule, `expectedPage` over the checkout's `src/server/page.html`: byte for byte, 532,211
characters, marker `dd6d45d28567`. Check 1 has the same shape there (the process on the port is the binary its agent
names), so serving the binary on 8082 is expected to read 3 of 3; the switch is the coordinator's decision.

The served page was 533,283 bytes against `dist/server/page.html` at 533,280: the difference is the marker filled
with `dd6d45d28567`, the build's own sha256 prefix. The full redeploy log is in
[`../../_context_/rust-port/`](../../_context_/rust-port/INDEX.md).
