---
title: 88-file-preview — the surface and the renderers
created: 2026-10-23T05:06:41Z
modified: 2026-10-23T05:06:41Z
level: L3
version: 1.0.0
description: Why one preview surface is a claim, the first seven claims 88-file-preview judges, and how it judges them.
status: unverified
grounded_in:
  - source: moved verbatim from _verifiers_/88-file-preview/INDEX.md@1.0.0
---

# 88-file-preview — the surface and the renderers

## Why it is a claim and not a preference

The project had grown **two** preview surfaces. A session offered Chat, Trajectory and **Docs**, where Docs listed
the repository's documents and rendered them; and a click on a file in the left panel opened a **File** tab that
rendered the same markdown through a second pane. Two surfaces meant two renderers, two style blocks and two places
for one document to look wrong — and it did: the file pane was **unstyled** until that was measured, because every
markdown rule named the Docs pane's element. A reader saw tables without borders and code spans showing their
backticks, while the same document in the other tab looked right.

## What it must get right

| # | Claim | Why it is not obvious |
|---|---|---|
| 1 | the ring offers **no** Docs tab, and the served page holds no document list | a tab hidden by a script still exists, and its list is still fetched |
| 2 | a click in the left panel opens the File panel, and the ring then offers the file alone | two panes can both be present and one merely hidden |
| 3 | a document is rendered by the **markdown** library — elements, tables, fenced code tokenised — not handed over as source | "rendered" and "shown as source" are one CSS mistake apart |
| 4 | a source file is rendered by the **highlighting** library, with the language its extension names and a line gutter | a second highlighter written by hand would classify differently from the one in a fenced block |
| 5 | a file with no renderer is shown as text, with no markup invented for it | inventing markup for plain text is how a file becomes unreadable |
| 6 | the preview is **styled**: a bordered table, an inline code span with a background, a heading larger than its body | markup can be entirely right while every rule names another pane |
| 7 | a file outside every workspace root is refused | a preview that can be asked for any path is disclosure with a renderer in front |
| 8 | only an `.html` or `.htm` file is previewed as a page; a Word document or a text file is refused (`415`), as DSH frames a page only through its HTML renderer | decoding a binary file as text and framing it looks like a preview while showing garbage, and a text file framed as a page runs its words as markup |

## How it is judged

Two checks. The first reads each type through the route the panel uses, and asserts on the **served page** that the
second surface is gone. The second drives a real browser: it clicks files in the left panel and measures the ring,
the pane, the highlighter's spans, the gutter, and the computed styling — because every claim here is a rendering
claim, and an API that answers correctly says nothing about what a reader sees.
