---
title: Verifier — File Preview
version: 1.0.0
description: a file clicked in the left panel is previewed in one place, rendered by the library its type calls for.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, asking that the Docs tab be removed and the File tab be the one preview surface, rendered with the appropriate library
---

# `88-file-preview`

Instance of this project's `_verifiers_`. **The claim it decides:** a file is previewed in exactly **one** place —
the File panel a click on the left panel opens — and each file type is rendered with the library appropriate to it.

This part replaced `89-markdown-view`, which judged a **Docs** tab that the owner removed. Its subject no longer
exists, so its claims moved here: what remains to judge is where a document is shown, and by what.

## Where it runs

**Headless browser.** The checks that need a page open a real Chrome with no window, through
[`_tools_/browser-tool/`](../../_tools_/browser-tool/INDEX.md); the rest drive the CLI and local HTTP
doubles. Nothing here needs a display, so it runs unattended.

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
| 8 | a source file's tokens resolve to **different colours**, not merely carrying the highlighter's classes | spans in the markup prove the library ran; only the computed colour proves a reader can see it |
| 9 | no entity code is visible in the text | the highlighter writes a single quote as hexadecimal, and a decoder that knows only the decimal spelling leaves `&#x27;` on screen |
| 10 | an image in a document is **fetched and decoded**, not merely referenced | an `img` with a broken source still has a `src`, so counting elements passes while a reader sees a broken marker |
| 11 | a file a browser would run is served as a download, and a path outside every workspace root as nothing | the route carries the session cookie, so serving an `.html` inline would be a same-origin page the harness runs by being viewed |
| 12 | the code is set at a readable size with leading, a **CJK fallback** in its stack, and a narrow gutter | a bare `monospace` resolves to a face with no CJK coverage, so a mixed line loses its column |
| 13 | each appearance has its own palette, on a surface the page paints itself | a palette written for a dark surface puts pale text on white on a light system |
| 14 | a link to a file in the workspace is followed **in the panel**, and the page does not navigate away | measured: `[x](DEPLOY.md)` asked for `/DEPLOY.md`, which answered `404`, so a reader lost the document to reach a blank page |

## How it is judged

Two checks. The first reads each type through the route the panel uses, and asserts on the **served page** that the
second surface is gone. The second drives a real browser: it clicks files in the left panel and measures the ring,
the pane, the highlighter's spans, the gutter, and the computed styling — because every claim here is a rendering
claim, and an API that answers correctly says nothing about what a reader sees.

## What it deliberately does not judge

- **Which library, beyond "the appropriate one".** The choice is recorded in the code and in the readings; what is
  judged is that a type is rendered by one, and that the two surfaces are one.
- **Office documents and PDFs.** Neither is previewed yet, so neither is claimed; both are zero-to-few-dependency
  candidates if the owner wants them.
- **The length of a large file.** Truncation is the file route's own concern and is judged where it belongs.

## Running it

```bash
sh verify.sh            # every check, with the verdict
sh verify.sh --list     # the check names, and why any was unjudged
sh verify.sh --json     # one parseable object
```

Exit `0` when the claim holds, `1` when it fails, `3` when it could not be judged — a host without a browser is the
`3` case.
