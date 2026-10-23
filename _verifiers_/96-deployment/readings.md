---
title: 96-deployment — readings
created: 2026-10-23T04:42:38Z
modified: 2026-10-23T04:42:38Z
level: L3
version: 1.0.0
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

The served page was 533,283 bytes against `dist/server/page.html` at 533,280: the difference is the marker filled
with `dd6d45d28567`, the build's own sha256 prefix. The full redeploy log is in
[`../../_context_/rust-port/`](../../_context_/rust-port/INDEX.md).
