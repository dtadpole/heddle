---
title: Browser slot queue
created: 2026-10-29T13:08:51Z
modified: 2026-10-29T14:40:05Z
level: L2
version: 1.2.0
description: How browser-slot shares the team's browser slots fairly. It covers the slot count and the integrator reservation, the queue and tickets, the coordinator's priority turn, the memory gate, stale-holder recovery, working beside a hand-made mkdir lock, and the exit codes.
status: unverified
grounded_in:
  - source: coordinator task 2026-10-29 - replace the ad-hoc browser lock with a fair FIFO tool, since 30-second retries starved some seats for an hour
  - source: '[hd] build-and-resources.md, Browser lock bullet: mkdir browser.lock with an owner file, at most 10 minutes, browser.next for a P0 gate'
  - source: 'coordinator D-060, 2026-10-29: a slot count in browser-cap, a slot reserved for integrators (browser.lock2), and no new holder while memory is short'
---

# Browser slot queue

Twelve seats share the browser slots. Retrying a mkdir every 30 seconds served whoever happened to ask at the
right moment, so some seats waited an hour. `browser-slot` serves the seats in the order they asked.

## The slots and the queue

- **The slots.** `~/.hd-build-slots/browser-cap` reads `<count> [reserve=<role>]`, and is 1 when the file is
  missing. Today it is `2 reserve=integrator`. Slot 1 is `browser.lock`, and slot n is `browser.lock<n>`. With
  a reservation, the last slot serves only that role and the other slots serve everyone else. A seat's role
  is `--role`, or `integrator` for an `integrator-*` key.
- **Each slot** is a mkdir directory with an `owner` file inside. The
  owner's first line keeps the old format, `<seat> <purpose> <HH:MM:SS>`. The tool adds `seat=`, `pid=` and
  `start=` lines.
- **A ticket** in `browser.queue/` holds each waiting seat's place, one per seat. It is named by the time the
  seat first asked. Every `take` refreshes it. A ticket not refreshed for 5 minutes is dropped: that seat
  stopped asking.
- **`take`** waits up to `--wait` seconds (default 100, inside the two-minute tool-call bound). It gets a slot
  only when that slot is free and the seat is the first waiter that slot serves. Otherwise it exits 75 and keeps the ticket, so the
  next `take` keeps the place.
- **`browser.next`**, written by the coordinator, puts its first word's seat first while that seat is queued.
  It does not hold the slot for a seat that is not asking. It is deleted when that seat takes the slot, and
  ignored once it is 30 minutes old.

**A head that does not take.** When a slot has been free for 60 seconds and the first waiter has not taken it,
for example because it stopped asking or runs an old copy, the next waiter whose gate passes takes it. The head
keeps first place for the next free slot. `browser.free-since<n>` marks when slot n was first seen free.

**Old copies.** Each copy carries a version and records it in `browser-slot.version`. A copy older than one
already in use exits 78 with an instruction to sync `_tools_/local-build` from main, and does not renew its
ticket, so it expires after 5 minutes. `status` shows each waiter's last verdict, the reason it did not take a
slot.

**Memory gate (D-061).** No new holder is admitted while `memory_pressure` reports under 25% free, the
primary gate, or `vm.swapusage` used is at or over 7680M, the backstop for sticky macOS swap. The seat stays
queued, and the exit-75 line says why. `browser-cap` may move the lines (`min-free=25 swap-stop=7680`).

## Holding and releasing

Hold the slot at most 10 minutes, and release it as soon as the gate ends. `run -- <command>` takes the slot,
runs the command and releases it even when the command fails. With `take`, the recorded pid is your shell, and
that shell may end before the gate does, so call `release` yourself.

A holder older than 15 minutes whose pid is gone is cleared by the next `take`. A holder with no recorded pid
(a lock taken by hand) is cleared the same way. A live pid is never cleared, however old. `status` reports
the holder, its age and pid, `browser.next` and the queue in serving order. It never changes anything.

## During the switch

A hand-made lock and the tool exclude each other, since both are the same mkdir. A seat that still takes the
slot by hand skips the queue. That seat should `rmdir` the lock within 10 minutes, or it is cleared after 15.
Once every seat uses the tool, the queue is the only way in.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | took, released, already holding, or `status` |
| `75` | still queued after `--wait`; the ticket is kept, run `take` again |
| `1` | `release` refused: this seat holds no slot (`--force`, with `--slot n` when two are held, clears one) |
| `78` | this copy is older than one in use: sync `_tools_/local-build` from main |
| `64` | usage: a verb or `--seat` missing |

`run` exits with the command's status. Environment for tests: `LOCAL_BUILD_SLOT_ROOT`,
`BROWSER_SLOT_STALE_SECONDS`, `BROWSER_SLOT_TICKET_SECONDS`, `BROWSER_SLOT_NEXT_SECONDS`, `BROWSER_SLOT_POLL_MS`,
`BROWSER_SLOT_MIN_FREE_PCT`, `BROWSER_SLOT_SWAP_STOP_MB`, and `BROWSER_SLOT_FAKE_FREE_PCT` / `BROWSER_SLOT_FAKE_SWAP_MB`, which stand in for the readings.
