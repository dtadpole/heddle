---
title: Verifier 7 — Workspaces And Sessions
version: 1.1.0
description: a workspace names a target folder, a session is bound to a folder under it, and those folders form a recursive tree.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, listing the ten verifiers
  - source: owner statement in the dsh session, 2026-10-11, choosing containment, one session per folder, every folder in the tree, and kind icons with type badges
  - source: SESSION_TREE.md, the design this part judges
---

# `70-workspaces-sessions`

Instance of this project's `_verifiers_`. **The claim it decides:** a workspace names a target folder,
a session is bound to a folder under it, and the folders form a recursive tree whose nodes are named
and classified by the conventions repository's own rules.

A session records the folder it ran in, and the workspace above that folder accounts for it. This part
also judges the navigation that follows from it: that the workspace with the **longest root above** a
folder owns its session, that one folder holds one session, and that the tree classifies each folder
and lists one level at a time. The model is stated in full, with the decisions behind it and what was
rejected, in [`../../SESSION_TREE.md`](../../SESSION_TREE.md).

## Where it runs

**Headless browser.** The checks that need a page open a real Chrome with no window, through
[`_tools_/browser-use/`](../../_tools_/browser-use/INDEX.md); the rest drive the CLI and local HTTP
doubles. Nothing here needs a display, so it runs unattended.

## What decides it

`check.mjs` — one file, twenty-two checks in three groups:

| Group | Checks | What it judges |
|---|---|---|
| the transcript | 5 | a session outlives its run, resumes, is readable on disk, is appended to rather than rewritten, and survives a frame torn by an interruption |
| the association | 3 | a session is grouped under the folder it ran in, a subdirectory is a member of the root above it, and one folder's prompts continue one session |
| the tree | 14 | containment, the segment-wise trap, the nearest root, `--new` and history, one level at a time, type and instance classification, badges, recursion, plain containers, plumbing and generated folders, **the boundary that only an instance carries a session**, the folder name as the session name, an empty type folder, a folder outside every root, and **in a browser: a folder that opens and closes with the same control, and a tree whose lists draw no markers** |

Since 29 Oct one more check judges the Web API's add, rename and delete of a workspace at DSH parity, on whichever
build runs the part (TypeScript or `HEDDLE_BIN`): `the Web API adds, renames and deletes a workspace the way DSH does`.
Another judges first use, DSH's `workspace/initializeDefault`: `first use creates or reuses default-workspace under the
heddle home, once, the way DSH initializes its default` (an empty install only, reused on a repeated call, never given
back once deleted, nothing made in the user's Documents).

## Where it stands, 2026-10-11

**22 checks, all passing — verdict `0`.** The tree group was written **before** the mechanism it judges,
because the owner asked for the checks first; both then landed in one session, and the checks went from
unjudged to passing without being bent: the two assertions that had to change are the ones whose rule the
owner reversed, and each says so in its own comment.

One check is a **browser** check, added after the owner hit two defects that no API check could see. A
leaf folder could be opened and then had no control left to close it, because the disclosure was disabled
once the folder turned out to be empty. And every nested row carried a stray circle marker in a 40px
gutter, because the element a node's children are built into is a `<ul role="group">` while the style rule
named `ol`, so the browser's own list defaults drew the dot and pushed the level in. Both were confirmed
to be caught by putting the old behaviour back and watching the check fail — `expected '−', actual '·'`
for the first, `no list in the tree draws a marker` for the second.

## Running it

```bash
sh verify.sh            # every check, including the browser ones
sh verify.sh --list     # the check names, and why any was unjudged
sh verify.sh --json     # one parseable object

# The two targets. A standard deployment host has no browser and must not need one.
npm run verify:fast     # unit suite, then every check that needs no page (~47 s here)
npm run verify:ui       # every check, browser included (~149 s here)
```

`HEDDLE_VERIFY_UI=0` makes the browser gate answer "no" for every check that needs a page; they report
**skipped**, and `--allow-skip` lets the runner call the standard target's verdict `0` while still printing
"14 skipped by this target". Without the flag a skip is still exit `3`: the standard target is honest about
what it did not judge, and the full UI target is what judges the rest.

Exit `0` when the claim holds, `1` when it fails, `3` when it could not be judged. A
claim that could not be judged is never reported as holding, which is the runner's
whole reason for existing — see [`_tools_/verify-runner/`](../../_tools_/verify-runner/INDEX.md).

## What it deliberately does not judge

- **How well a model reasons.** Nothing here scores an answer's quality; the checks
  ask whether the mechanism works.
- **Anything it has to spend to see.** Every fixture here is a scripted endpoint and a local
  directory tree, so the run is free and offline.
- **A rendered page, except one behaviour.** The tree is judged as a **derivation**, one level at a time,
  through the CLI — which is where the mechanism lives and where a browser is not needed. One rendered
  behaviour *is* judged, because the owner found it broken and no API check could have: that a folder opens
  **and closes** with the same control, including a leaf with nothing inside. The pixels, the kind icons and
  the type badges are not judged anywhere; they were read back from a real browser by hand against a fixture
  shaped like the conventions repository, and the roadmap's "a browser check" is now partly done.

## Read next

[`../../SESSION_TREE.md`](../../SESSION_TREE.md) for the model these checks judge,
[`../INDEX.md`](../INDEX.md) for every verification, and
[`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the part this one decides.
