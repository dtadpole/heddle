---
title: Local build capacity
created: 2026-10-24T05:01:03Z
modified: 2026-10-24T05:01:03Z
level: L2
version: 1.0.0
description: How the coordinator cuts the usable build slots with a cap file, reads the load of the Mac, and when integrators free disk.
status: unverified
grounded_in:
  - source: the local-build INDEX.md version 1.2.0 this was split from
---

# Capacity

## The cap

The coordinator can cut the Mac to fewer usable slots in one write, without every seat changing an environment
variable:

```bash
echo 2 > ~/.hd-build-slots/cap     # two usable slots until the file says otherwise
rm ~/.hd-build-slots/cap           # back to the default, every slot
```

`run` reads the file on every call. It must hold a whole number from 1 to the slot count; anything else is
reported and ignored, and the default count applies. Slots beyond the cap are not taken, but a dead one is
still swept, so a leaked directory cannot linger. `status` prints the cap in force and marks a slot that is
beyond it.

## Seeing the machine

The coordinator's review pass starts with one report of the Mac:

```bash
node _tools_/load-check/load-check.mjs
```

It prints the free disk against the 26 GB and 20 GB lines, the load average per core, swap, every slot's
owner, and the processes in the `~/heddle--*` worktrees, then exits 0 ok, 1 warn, 2 stop (see
[`../load-check/INDEX.md`](../load-check/INDEX.md)).

## The disk line

When the disk falls below 26 GB free, integrators remove release artifacts before the next verifier run
(working model, D-021).
