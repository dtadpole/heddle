---
title: 90-web-ui-token — what decides it
created: 2026-10-23T05:06:41Z
modified: 2026-10-23T05:06:41Z
level: L3
version: 1.0.0
description: The check file of 90-web-ui-token and what the part deliberately leaves to others.
status: unverified
grounded_in:
  - source: moved verbatim from _verifiers_/90-web-ui-token/INDEX.md@1.0.0
---

# 90-web-ui-token — what decides it

## What decides it

`check.mjs` starts the server, probes it with no token, a wrong token and the right one, and opens the stream with each.

## What it deliberately does not judge

- **How well a model reasons.** Nothing here scores an answer's quality; the checks
  ask whether the mechanism works.
- **Anything it has to spend to see.** Except where a check is named for the real
  backend, every fixture is local and the run is free.
