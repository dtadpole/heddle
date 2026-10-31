---
title: Local build TypeScript slots
created: 2026-10-31T03:50:00Z
modified: 2026-10-31T04:20:00Z
level: L2
version: 1.1.0
description: The ts slot class of the slot runner, which queues TypeScript test runs in a pool of two and caps each run's node test concurrency at four, so full gates from several seats cannot overload the Mac.
status: unverified
grounded_in:
  - source: the coordinator's request of 2026-10-31 03:33Z, load 46 on 10 cores from 43 unslotted node test processes
  - source: node 24 refusing --test-concurrency in NODE_OPTIONS, checked on this Mac 2026-10-31
---

# TypeScript slots

`npm test` is `node --test test/*.test.ts`. Node starts one process per test file, up to the number of cores
less one at a time, so a few seats running full gates at once put forty node processes on ten cores. A
TypeScript test run therefore takes a slot too.

## Use

```bash
_tools_/local-build/run --ts -- npm test
_tools_/local-build/run --ts -- node --test test/session-tree.test.ts
_tools_/local-build/run --ts status
```

Anything after `--ts` (and an optional `--`) is the command, run from the caller's directory. `npm run check`
and `verify:fast` can go through it the same way.

## What a ts slot guarantees

- **Two runs at once on the Mac**, from a pool of its own (`ts-slot-N` under the slot root), apart from the
  cargo slots: a TypeScript run never waits for a build, nor a build for it. The coordinator sets the pool
  with one write, `echo 1 > ~/.hd-build-slots/ts-cap` (1 to 4; anything else is ignored with a warning).
- **Four test files at a time per run.** Node refuses `--test-concurrency` in `NODE_OPTIONS`, so the runner
  puts a `node` first on the command's `PATH`, inside its slot, that starts the real node with
  `--test-concurrency=4` (`LOCAL_BUILD_TS_CONCURRENCY` changes it). npm scripts and `#!/usr/bin/env node` find
  it. A caller's own `--test-concurrency` comes later on the command line and wins.
- The release on exit and on a signal, dead-owner reclaim, the hour-old stamp and the bounded wait (exit 75) are
  the cargo slots' rules ([slots.md](slots.md)), and so is the first-come-first-served queue, kept apart in
  `ts-slot.queue` with its own `ts-slot.next` ([queue.md](queue.md)). No `-j`, no shared-target guard and no build output sweep apply.

## Bounds

A node started by absolute path (`/opt/homebrew/bin/node --test …`) bypasses the shim, though not the slot.
