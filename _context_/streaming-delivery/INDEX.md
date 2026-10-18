---
title: Streaming Delivery
version: 1.0.0
description: Screenshots and measurements taken at the owner's address while judging whether a DeepSeek answer reaches the Web UI as it is written.
grounded_in:
  - source: the deployed Web UI at http://127.0.0.1:8082, measured in a fresh headless Chrome profile on 2026-10-18
  - source: SESSION_STREAMING.md, the full-loop document these files are the evidence for
---

# `streaming-delivery`

Instance of [`_context_`](../INDEX.md). Holds the evidence the streaming loop cites: what the page a
person opens looked like while an answer was arriving, taken from the delivered address rather than
from a spawned copy of it.

## What belongs in it

One file per measurement a cycle of [`SESSION_STREAMING.md`](../../SESSION_STREAMING.md) quotes, named
`cycle-<n>-<what>.png`. The cycle block says which instrument took each one and what it showed.

- `cycle-1-streamed-answer-8082.png` — the page at `http://127.0.0.1:8082/` after a 20-line DeepSeek
  Flash answer streamed into it, from a browser profile created after the daemon restart.
- `cycle-2-tool-turn-8082.png` — the same address after a two-round tool turn (`bash`, then a streamed
  answer about its output), taken from a fresh profile; the baseline of cycle 2, before the live tool card.
- `cycle-2-live-tool-card-8082.png` — the same address mid-stream after cycle 2 landed: a `write_file` card live
  at 1615 characters of arguments, still growing, from a profile created after the daemon restart.

## Where it runs

Taking these needs a browser; the files themselves are read with none. They were taken **headless**
with [`_tools_/browser-use/`](../../_tools_/browser-use/INDEX.md).

## Read next

[`../../SESSION_STREAMING.md`](../../SESSION_STREAMING.md) for what each file is evidence of.
