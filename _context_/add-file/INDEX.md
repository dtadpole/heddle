---
title: Add File
version: 1.0.0
description: Screenshots recorded by the Add File loop, one per cycle, beside the document that explains what they show.
grounded_in:
  - source: the Add File loop's document at ../../SESSION_ADD_FILE.md, cycle 1 measured 2026-10-17
---

# `add-file`

Instance of [`_context_`](../INDEX.md). Holds the screenshots the Add File loop records as evidence,
one image per cycle, so a later round can see what the check saw rather than only read that it passed.

This folder has **no browser requirement of its own**: the images are produced by the loop's browser
checks (`_verifiers_/80-web-ui/check-composer.mjs` runs headless), and a reader needs no browser at all.

| File | What it shows |
|---|---|
| [`cycle-1-add-file.png`](cycle-1-add-file.png) | the browser contract's final state: the draft holding the stored path of the file chosen through the `+` menu's File item |
| [`cycle-1-heddle-after.png`](cycle-1-heddle-after.png) | the independent re-measurement after the change, with the menu's `File` entry and the stored path in the draft |

## Read next

[`../../SESSION_ADD_FILE.md`](../../SESSION_ADD_FILE.md) for the measurements, the designs considered
and the per-cycle record; [`../dsh-browser-mcp/REPORT.md`](../dsh-browser-mcp/REPORT.md) for the browser
surface the measurements were taken with.

## Cycle 2 and 3

| File | What it shows |
|---|---|
| [`cycle-2-before.png`](cycle-2-before.png) | cycle 2's fix row: the descended menu with `↑ up` and the folder's children, and no `File` |
| [`cycle-2-file-inside-folder.png`](cycle-2-file-inside-folder.png) | after the fix: `File` offered in the same descended menu |
| [`cycle-3-menu-in-folder.png`](cycle-3-menu-in-folder.png) | the final state at the folder level: `File` is offered above `↑ up` |
| [`cycle-3-draft.png`](cycle-3-draft.png) | the draft after a file was chosen from that level, holding the stored path the agent can read |
| [`landed-8082.png`](landed-8082.png) | the deployed page at `http://127.0.0.1:8082/` after the change was landed and served: the draft holds the stored path of a real file chosen through the `+` menu |
