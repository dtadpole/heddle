---
title: 50-agentic-loop fixtures
version: 1.0.0
description: The recorded stores the agentic-loop checks boot a server on, and the one-time recorder that produced them from the TypeScript build.
grounded_in:
  - source: heddle commit a5b0c66, 2026-10-22, the TypeScript build that wrote this store's bytes
---

# `fixtures`

Holds input **data** for the checks under [`../INDEX.md`](../INDEX.md), not checks: `verify.sh` runs `check*.mjs` only,
so nothing in this folder runs as part of a suite.

| Path | What it is |
|---|---|
| [`team-recover/`](team-recover/INDEX.md) | the session store a previous process left behind, recorded from the TypeScript build |
| [`record-team-recover-store.mjs`](record-team-recover-store.mjs) | the recorder that produced it, kept so the bytes have a stated provenance |

Why bytes rather than a call into the store: the claim is about a store **another process wrote**, so the input is
data. It also keeps the backend lane able to judge the binary through `HEDDLE_BIN` without `dist/` or
`npm run build` — the seam exists so the lane judges the binary, and a fixture that imported the TypeScript build
would drag it back in.
