---
title: 88-file-preview — rendering fidelity
created: 2026-10-23T05:06:41Z
modified: 2026-10-23T05:06:41Z
level: L3
version: 1.0.0
description: The claims 8 to 14 of 88-file-preview, on how faithfully each file type is drawn, and what the part leaves out.
status: unverified
grounded_in:
  - source: moved verbatim from _verifiers_/88-file-preview/INDEX.md@1.0.0
---

# 88-file-preview — rendering fidelity

## What it must get right, continued

| # | Claim | Why it is not obvious |
|---|---|---|
| 8 | a source file's tokens resolve to **different colours**, not merely carrying the highlighter's classes | spans in the markup prove the library ran; only the computed colour proves a reader can see it |
| 9 | no entity code is visible in the text | the highlighter writes a single quote as hexadecimal, and a decoder that knows only the decimal spelling leaves `&#x27;` on screen |
| 10 | an image in a document is **fetched and decoded**, not merely referenced | an `img` with a broken source still has a `src`, so counting elements passes while a reader sees a broken marker |
| 11 | a file a browser would run is served as a download, and a path outside every workspace root as nothing | the route carries the session cookie, so serving an `.html` inline would be a same-origin page the harness runs by being viewed |
| 12 | the code is set at a readable size with leading, a **CJK fallback** in its stack, and a narrow gutter | a bare `monospace` resolves to a face with no CJK coverage, so a mixed line loses its column |
| 13 | each appearance has its own palette, on a surface the page paints itself | a palette written for a dark surface puts pale text on white on a light system |
| 14 | a link to a file in the workspace is followed **in the panel**, and the page does not navigate away | measured: `[x](DEPLOY.md)` asked for `/DEPLOY.md`, which answered `404`, so a reader lost the document to reach a blank page |

## What it deliberately does not judge

- **Which library, beyond "the appropriate one".** The choice is recorded in the code and in the readings; what is
  judged is that a type is rendered by one, and that the two surfaces are one.
- **Office documents and PDFs.** Neither is previewed yet, so neither is claimed; both are zero-to-few-dependency
  candidates if the owner wants them.
- **The length of a large file.** Truncation is the file route's own concern and is judged where it belongs.
