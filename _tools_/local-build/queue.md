---
title: Local build queue
created: 2026-10-31T04:20:00Z
modified: 2026-10-31T04:20:00Z
level: L2
version: 1.0.0
description: The first-come-first-served ticket queue of the slot runner, which serves waiting runs in arrival order instead of to whoever polls first, with a 60 s head bypass and a coordinator's one-time priority turn.
status: unverified
grounded_in:
  - source: developer-eight's report of 2026-10-31 04:00Z, a cargo run queued over 7 minutes behind integrators' back-to-back commands at cap 1
  - source: the coordinator's request of 2026-10-31 04:02Z for a fair FIFO cargo slot like browser-slot
---

# The queue

Before the queue, a waiting run polled every 3 s and the first poll after a slot freed took it. A seat that
starts its next cargo command the moment one ends therefore won nearly every free moment: at cap 1 a developer's
run waited more than seven minutes behind two integrators, though it had arrived while the slot was free.

## The rule

- **A run joins the queue when it starts**, as one ticket `<class>.queue/<ms>-<pid>` under the slot root
  (`slot.queue` for cargo, `ts-slot.queue` for `--ts`), holding `<pid> <epoch> <seat> <tree>`. `seat` is
  `$HD_SEAT` when set, else `-`; `tree` is the caller's git top level.
- **Place N takes a slot only while N slots are free** within the cap. At cap 1 only the head takes, so the
  head is served next whoever polls faster. With an empty queue a run takes a free slot at once, as before.
- **A ticket goes with its run**: on the slot being taken, on the wait running out (exit 75), and on `INT`,
  `TERM` or `HUP` while waiting.
- **A dead or stuck waiter cannot block the queue.** A waiter touches its ticket on every poll. A ticket whose
  run is gone, or that has not been touched for 300 s (`LOCAL_BUILD_TICKET_SECONDS`), is dropped by the next
  waiter. A waiter silent for 60 s (`LOCAL_BUILD_HEAD_GRACE_SECONDS`) is passed over: the next waiter may take
  the slot, and the silent one keeps its place if it polls again.
- Only the head breaks an hour-old stamp when every slot is busy.

## Priority turn

For a security candidate, the coordinator puts one waiter first with one write:

```bash
echo developer-eight > ~/.hd-build-slots/slot.next       # ts-slot.next for the ts pool
```

The token names a seat or a tree. It matches a ticket whose seat is the token, whose tree is the token, or whose
tree's folder name is the token, `<repo>--<token>` or `<repo>--<token>-<suffix>`. So `developer-eight` covers
`heddle--developer-eight` and `heddle--developer-eight-b4`, and `developer-eight-b4` only the latter. A tree
outside that naming (`/tmp/hd12-csp`) needs its full path, or `HD_SEAT` set by the seat. That waiter goes
first, or takes the slot at once if it arrives later. The turn is used once: the file is removed when that waiter takes a slot. A file older than 30
minutes (`LOCAL_BUILD_NEXT_SECONDS`) is ignored.

## Status

`run status` (and `run --ts status`) lists `next:` and the queue in serving order, each waiter with its pid,
seat, time waited and tree, and why a waiter is skipped:

```text
next: developer-x (from ~/.hd-build-slots/slot.next; that waiter goes first, once)
queue: 3 waiting, first come first served
  1. pid=4102 seat=- waiting=31s tree=~/heddle--developer-eight (named by next)
  2. pid=3977 seat=- waiting=52s tree=~/heddle--developer-four
  3. pid=3812 seat=- waiting=95s tree=~/heddle--developer-nine (silent 90s; passed over, keeps its place)
summary: busy=1 stale=0 free=0
```

A waiting run says its place once, and again when it changes:
`local-build: queued for a slot at position 2 of 2 (cap 1); first is pid 4102 in ~/heddle--developer-eight`.

## Bounds

A copy of `run` from before the queue takes a free slot without a ticket, ahead of everyone. Sync
`_tools_/local-build` from main so every seat queues.
