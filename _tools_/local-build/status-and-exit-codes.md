---
title: Local build status and exit codes
created: 2026-10-24T05:01:03Z
modified: 2026-10-31T04:20:00Z
level: L2
version: 1.3.0
description: What the status report of the slot runner looks like and what each exit code of the runner means.
status: unverified
grounded_in:
  - source: the local-build INDEX.md version 1.2.0 this was split from
---

# `status` and exit codes

## `status`

```text
root: ~/.hd-build-slots
slots: 3  jobs: 3
cap: 3 of 3 slots (default; no cap file)
slot 0: busy pid=3521 cargo=3499 age=151s cwd=~/heddle--developer-six
slot 1: free
slot 2: stale pid=7371 cargo=0 age=3601s cwd=~/heddle--developer-twelve
next: none
queue: 1 waiting, first come first served
  1. pid=4102 seat=- waiting=31s tree=~/heddle--developer-eight
summary: busy=1 stale=1 free=1
```

`run --ts status` reports the ts pool the same way, headed `class: ts  slots: 4  node test concurrency: 4`,
with `ts slot N` lines and `cmd=` for the command's pid. The `next:` and `queue:` lines are the waiting runs in
serving order ([queue.md](queue.md)); `status` only reads them.

`status` exits `0` when every slot is free or live, and `1` when it found a stale or ownerless slot — a
machine-readable "something died here".

## A run's exit status

A run's exit status is cargo's, apart from the runner's own:

| Code | Meaning |
|---:|---|
| `64` | a usage error |
| `129`, `130`, `143` | a waiting run stopped by `HUP`, `INT` or `TERM`; it left the queue |
| `75` | no free slot within the wait, with the run's queue position ([queue.md](queue.md)), or a shared target still locked by another tree ([shared-target.md](shared-target.md)) |
| `127` | cargo not found, or the command after `--ts` not found ([ts-slots.md](ts-slots.md)) |
