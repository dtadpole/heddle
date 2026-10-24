---
title: Build host
version: 1.0.0
description: The loop the Rust port is developed in — one git worktree per team member on a Linux build host, run, test and verify there with a compiler cache and a job cap.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-22, proposing one worktree per team member on the devserver, an integration worktree and a live deployment worktree
  - source: owner statement in the same session, that each feature owner runs its own unit tests
  - source: rust/INDEX.md, why the port does not build on the owner's Mac
created: 2026-10-23T00:55:27Z
modified: 2026-10-23T00:55:27Z
---

# `build-host`

Instance of [`_tools_`](../INDEX.md). The Rust port runs what it builds only on a Linux build host
([`rust/INDEX.md`](../../rust/INDEX.md)), so every member works there: `~/heddle--<seat>` is its worktree on
branch `hd/<seat>`, `~/heddle--int` is where branches are merged and judged together, and `~/heddle-live` is the
deployment. Commands carry the host's compiler cache and a job cap, because the hosts are shared.

**Browser mode: none.** The host is machine configuration: `--host` or `HEDDLE_BUILD_HOST`, never a default.

```bash
T=_tools_/build-host/build-host.mjs
node $T bootstrap --host H                          # toolchain, cache, base clone ~/heddle (idempotent)
node $T worktree --name llm --host H                # ~/heddle--llm on hd/llm, resumed if pushed before
node $T test --name llm --crates=heddle-llm         # the owner's own unit tests
node $T verify --name llm 10-llm-backends           # release build, then the verifier through HEDDLE_BIN
node $T run --name int -- cargo test --manifest-path rust/Cargo.toml
```

| File | What it is |
|---|---|
| [`build-host.mjs`](build-host.mjs) | the command line and the script builders it is made of |
| [`_tests_/command-rules/`](_tests_/command-rules/INDEX.md) | the unit tests of those builders |

## Read next

[`../../rust/INDEX.md`](../../rust/INDEX.md) for the working model and the status of each part.
