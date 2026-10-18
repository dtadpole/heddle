---
title: Add File, the composer's one new capability
version: 1.0.0
description: What DSH's composer file action does, what heddle's plus menu did before it, and the smallest honest way to add Add File to a path-based harness, cycle by cycle.
level: L2
status: verified
grounded_in:
  - owner statement 2026-10-17 that the composer's bottom-left plus button gains exactly one capability, Add File, and nothing else
  - DSH 0.2.0-rc.2 driven in a browser at http://127.0.0.1:8080 on 2026-10-17, composer plus menu and file handling measured directly
  - heddle at fbfb1b1 on branch feat/add-file, measured in a browser on the same day
---

# Add File

The owner's job: the composer's bottom-left `+` gains **exactly one capability — Add File — and
nothing else**. Not the goal, plan or command entries DSH puts beside it; one way to get a file
from the person's computer into the conversation.

This document is the loop's memory, one block per cycle: the reference measured, the target
measured, the designs considered and discarded, the plan, and the evidence that the plan held. A
later round or a restarted process resumes from here rather than repeating the measurements.

## The reference, measured

**Artifact.** DSH 0.2.0-rc.2, served at `http://127.0.0.1:8080`, loaded fresh at 1400x900 in a
headless Chrome on 2026-10-17 and driven through heddle's own browser tool
(`_tools_/browser-use/`). The build is the one the page's own boot scripts identify: the
`dsh-client-modules` preload list including `@deepseek-ai/dsh-client-file-upload`.

### The button and the menu

- The composer's bottom-left control is a 28px circled `+` with `aria-label="Add files or run
  commands"`; the class is `uV2eYG_add`.
- Clicking it opens one surface above the card (`_surface_ri079_1 _3e4SsG_menu`). Its rows are
  735x34 `button[role=option]` elements with `id="dsh-slash-option-command-<n>"`, each a 14px icon
  followed by a name, and a description for everything but the first.
- The menu's entries, in order: **File**, Goal, Plan, Feedback, Compact, Permission, Model,
  Export, mobile. Two group headings (`Add`, `Commands`) are text, not rows.
- **File is first and has no description.** Choosing it closes the menu and invokes the picker.
- The picker is a hidden `<input type="file" multiple hidden>` in the page, clicked from the File
  handler. Probed by replacing `HTMLInputElement.prototype.click`: the call fires; `showOpenFilePicker`
  is never called, so the Operating System's file picker is the mechanism, not the File System
  Access API, and no `accept` filter is set.

### What the composer receives

A file chosen through that input becomes a **pending attachment card above the editor**, not text:

```text
div.JVDQca_item
  div.gSkjMW_card[title="example.md"]
    span.gSkjMW_icon                       28x28 type icon (SVG; markdown vs other)
    span.gSkjMW_body[aria-label="Pending files"]
      span.gSkjMW_name                     "example.md"
      span.gSkjMW_meta                     "MD 34B"   (type, size)
    button.gSkjMW_remove[aria-label="Remove file example.md"]   12x12 ✕
```

- Two files produce two cards, in the order chosen; removing one leaves the other.
- The draft text is **unchanged** (empty) while the cards exist: the files are composer state of
  their own, not a path typed into the prompt.
- The remove button is per card, and the card's `title` is the file name.

State matrix that decided the target: idle menu closed; open menu; File selected (menu closed,
picker asked); one file pending; two files pending; one removed.

## The target before the change

heddle at `fbfb1b1`, built from the worktree and served on an ephemeral port with an isolated
`HEDDLE_HOME`; same 1400x900 browser.

- The `+` is already DSH's shape: 28x28, `border-radius: 999px`, `background: rgb(53,54,56)`,
  `opacity: .5` at rest and `1` on hover, `aria-label="Add files or run commands"`, title
  `Insert a file path`.
- The menu is `#attach-menu`: `position:absolute; left:50%; translateX(-50%)`, 512px wide,
  `background: rgb(35,35,36)`, 8px radius, 1px `rgb(53,53,53)` border, 4px padding, 28px rows,
  `font-size: 12.48px`.
- Its contents are the **registered workspace roots**, walked one level at a time: opening a folder
  pushes a level and shows `↑ up` plus its children; choosing a file inserts that file's absolute
  path at the cursor and closes the menu. Measured: choosing `note.md` under a registered root put
  `/Users/.../ws/note.md` in the textarea.
- There is no file input and no way to name a file outside a registered workspace root.

### The gap this cycle closes

| Dimension | DSH | heddle before | Cycle-1 fix |
|---|---|---|---|
| A file from the computer | first menu entry `File` opens the OS picker | no item, no picker | add `File` as the menu's first entry and a hidden multiple file input |
| What happens to the bytes | kept as pending attachment cards, sent with the message | — | upload to the harness's store, insert the stored path in the draft |
| Reachable files | anywhere the OS picker can reach | only inside a registered workspace root | the stored copy is reachable from anywhere |

## The substrate, and why the path is the honest form

- The composer's turn request is a **string prompt** (`POST /api/turn` takes `prompt`), and the
  provider layers accept text; heddle has no attachment content block and no upload pipeline.
- The agent's file tool is `read_file`, which calls `sandbox.assertReadable(path)`. In
  `workspace-write` the admitted roots are the workspace, named extra roots, the temp root when
  configured, and **the harness's own directory** (`$HEDDLE_HOME`).
- So a file can enter the conversation in exactly two ways: its bytes become text in the prompt, or
  it becomes a **path the agent can read**. The second is the substrate heddle already has, and it
  is the one that survives a large or binary file, keeps the agent able to re-read the source, and
  needs no provider capability.
- Consequence for the design: the visible result cannot be an attachment content block; the honest
  equivalent is a stored path in the draft. The reference's **pending-card treatment** is therefore
  a possible later refinement, not a requirement of the claim.

## Designs considered

1. **Native picker -> upload to `$HEDDLE_HOME/uploads` -> insert the stored path in the draft.**
   *Chosen.* It is the only design that reaches a file outside a workspace and still lands on the
   substrate the agent already reads; one new endpoint, one new menu item, no message-format change.
2. **Native picker -> read the file in the page -> paste its text into the draft.**
   *Discarded.* It spends the prompt's tokens on the file's bytes, cannot represent binary files, and
   takes away the agent's ability to re-read the source. It also duplicates `read_file`.
3. **Keep the workspace tree only.**
   *Discarded.* It cannot serve the claim: a file outside every registered root is exactly what
   "Add File" means to a person looking at their own computer.
4. **Pending attachment cards and a message-level attachment reference.**
   *Deferred, not discarded.* It is the reference's visible form, but heddle's turn body is a string
   and its providers have no attachment block, so this cycle would have to invent a second message
   shape. The claim is satisfied by the path; this is re-measured in cycle 2 against the reference
   before any such work is taken on.
5. **Drag-and-drop only.**
   *Discarded.* The owner named the `+` button as the entry, and a drag gesture cannot be exercised
   by the menu contract.
6. **A native dialog that returns a real filesystem path (Electron-style bridge).**
   *Discarded.* The UI is a browser page served over HTTP; there is no bridge to the host, and the
   browser deliberately hides a chosen file's path.

## Cycle 1 — plan and change

Files that own the facts, and nothing else:

| File | Change |
|---|---|
| `src/server/uploads.ts` (new) | the substrate: safe leaf names, the `$HEDDLE_HOME/uploads` store, non-overwriting paths, `0600` files, the 10 MiB ceiling |
| `src/server/web.ts` | `POST /api/uploads?name=<encoded>` taking the raw bytes and answering `{path,name,bytes}`, behind the existing token/cookie gate, same ceiling as a turn |
| `src/server/page.html` | the hidden `<input type="file" multiple>`, the menu's first `File` entry that invokes it, one request per file, and the stored paths inserted at the cursor; a failure re-opens the menu with the reason |
| `src/sandbox/service.ts` | the readable-root rule now resolves `$HEDDLE_HOME` instead of `~/.heddle`, so an upload under a non-default home is a path the agent can read |
| `test/uploads.test.ts` (new) | failing-first unit tests for every helper rule |
| `_verifiers_/80-web-ui/check-composer.mjs` | the browser contract: open `+`, choose `File`, put a real file in the input, assert the draft names the stored path and the bytes on disk match, and keep a screenshot |
| `test/page-contract.test.ts` | removal detector for the input, the `File` label, the route and the path-into-draft wiring |

No command, goal, plan, or other menu action was added. The existing workspace tree is unchanged;
`File` is one new entry at the top of the same menu.

## Cycle 1 — verification

Failing first, against the unmodified build:

- `node --test test/uploads.test.ts` -> `ERR_MODULE_NOT_FOUND` for `src/server/uploads.ts`.
- `node --test --test-name-pattern "adds a file from this computer" _verifiers/80-web-ui/check-composer.mjs`
  -> `AssertionError: the menu offers File`.

Then, after the change:

- `npm run check` -> 0 (types, source and tests).
- `npm test` -> 340 tests, 340 pass, 0 fail.
- `node --test _tools_/*/_tests_/*/unit.test.mjs` -> 35 tests, 35 pass.
- `node --test test/uploads.test.ts` -> 8 tests, 8 pass.
- `node --test --test-name-pattern "menu" _verifiers/80-web-ui/check-composer.mjs` -> both the old
  workspace-tree contract and the new Add File contract pass.
- Independent re-measurement after the change: the menu reads `File`, `ws/`; choosing `File` asks
  the picker once and closes the menu; the draft becomes
  `/Users/.../.heddle-tmp/add-file/home/uploads/<stamp>-from-picker-cycle1.md`; the file exists and
  contains the chosen bytes. Screenshot: [`_context_/add-file/cycle-1-heddle-after.png`](_context_/add-file/cycle-1-heddle-after.png).
- Browser-contract screenshot: [`_context_/add-file/cycle-1-add-file.png`](_context_/add-file/cycle-1-add-file.png).

**Landed:** commit `a6d2d38` on `main`, and the deployed page at `http://127.0.0.1:8082/` was observed
doing this gesture end to end — see [Landing and deployment](#landing-and-deployment).

### What verification found, and the fix

The first run of the sandbox unit test failed with a real denial: the stored path under the temp
home was `/var/folders/...` while the sandbox compared it against the canonical `/private/var/...`.
The readable root is now canonicalised — the same trap the sandbox's own comment warns about, and
the reason the test asserts the read rather than the string.

### The full verifier sweep

`for d in _verifiers_/*/; do sh "$d/verify.sh"; done`, one suite after another, logs kept in
`.heddle-tmp/add-file/verifiers/` (gitignored). The first sweep left three suites not green. Each
was re-run and each result is recorded here rather than rounded up:

| Suite | First sweep | After re-run | What it was |
|---|---|---|---|
| `70-workspaces-sessions` | 1 (one check) | **0**, 43/43 | a search assertion read an empty result set under the load of the whole sweep; the same check passes alone and passes when the suite is re-run |
| `80-web-ui` | 1 (`check-model-switcher`) | **0** after the fixes below | two latent bugs in that check's harness, measured red on the pre-change commit too |
| `10-llm-backends` | 3 (one check unjudged) | **0**, all checks | the machine's configured endpoint returned no text within its token budget on that attempt; the same command passed twice afterwards, and passed on the pre-change commit |

Every other suite (`05`, `20`, `30`, `40`, `50`, `60`, `75`, `85`, `87`, `88`, `90`, `95`) exited
`0` on the first sweep. After cycle 2's change the **whole sweep was run once more on the shipped
tree** and every suite exited `0` in that single pass: `05`, `10`, `20`, `30`, `40`, `50`, `60`, `70`,
`75`, `80`, `85`, `87`, `88`, `90`, `95` — 15 of 15 (`_verifiers_/` all green; logs in
`.heddle-tmp/add-file/verifiers-final/`).

### What the sweep found in the verifier itself

`check-model-switcher.mjs` was red on the **pre-change commit** as well (measured in a detached
worktree at `fbfb1b1`), so this loop did not break it; it was already not judging what it claimed
on a clean machine. Two causes, both fixed in the check rather than worked around:

- it read the model seat immediately after the element existed, before `/api/endpoints` had been
  answered (`'model'` instead of `'double-one · model-one'`); it now waits for the endpoint list to
  be **drawn**, then asserts the same exact label;
- it created a folder session without registering that folder as a workspace, so on a fresh
  `HEDDLE_HOME` the route refused it (`the folder must be under a workspace root`); it now registers
  the checkout through the same API the page's control posts to, and its child process gets its own
  `HEDDLE_HOME` so the operator's real workspace store is not part of the test.

That is the loop's verification fix, not a change to the Add File capability.

## Cycle 2 — a measurement that found one more row

Measured on the shipped cycle-1 build, same browser and fixture shape as cycle 1:

| State | Reading |
|---|---|
| `+` at the menu's root | `File`, `ws/` |
| after descending into `ws/` | `↑ up`, `sub/`, `root.md` — **no File** |
| after descending into `sub/` | `↑ up`, `nested.md` — **no File** |
| two files chosen through File | two stored paths in the draft, in the order chosen; both files exist with the chosen bytes |
| removal | there is no card to remove: the path is edited out of the draft |

The first three rows are the fix row: DSH's menu is flat and always lists `File` first, while heddle's
menu **took the action away as soon as a person descended into the workspace tree** — so the one new
capability was available only from the root. A person already inside the tree had to walk back up.

**Fix.** `File` is now drawn at every level of the tree, above `↑ up`, and the browser contract gained
the claim: choose the root, wait for the descended level, and assert `File` is still offered and still
asks for the picker. The failing-first run of that check is recorded: its first version passed for the
wrong reason (it read the stale root menu); it was corrected to wait for the descended level before
asserting, then failed against the unmodified page with
`AssertionError: descending into a folder still offers File`, and passed after the fix.

Screenshots: before the fix [`_context_/add-file/cycle-2-before.png`](_context_/add-file/cycle-2-before.png)
(the descended menu with no `File`), after it
[`_context_/add-file/cycle-2-file-inside-folder.png`](_context_/add-file/cycle-2-file-inside-folder.png).

**Landed:** the same landing commit `a6d2d38` carries this fix; the deployed page at 8082 serves it
(see [Landing and deployment](#landing-and-deployment)).

## Cycle 3 — measured, no fix row, stopped

Re-measured after cycle 2, with a file chosen **from inside a folder**:

| State | Reading |
|---|---|
| root | `File`, `ws3/` |
| `ws3/` level | `File`, `↑ up`, `sub/` |
| picker from that level | asked once; menu closed |
| draft | `.../uploads/<stamp>-final.md`, the stored copy of the file chosen while the tree was open |

`File` is present at every level, the picker is the mechanism, and the path in the draft is a file the
agent can read. The differences that remain are measured and deliberate, so the loop stops here rather
than inventing work:

| Difference | Why it stays |
|---|---|
| the row is 28px / 12.48px with no icon; DSH's is 34px with a 14px icon | heddle's menu draws every row in that scale and with no icons; changing only `File` would make the one new row speak a different visual language from the tree beneath it |
| DSH keeps pending **cards** above the editor; heddle puts the stored **path** in the draft | the substrate decision (see above): the agent reads paths, the provider takes text, and a card would have to invent a message shape |
| removal is editing the draft, not a per-file ✕ | follows from the same decision: there is no separate attachment object to remove |
| the menu is a tree; DSH's is flat | pre-existing heddle shape, unchanged by this job; `File` is now reachable at every level |

Screenshots: [`_context_/add-file/cycle-3-menu-in-folder.png`](_context_/add-file/cycle-3-menu-in-folder.png),
[`_context_/add-file/cycle-3-draft.png`](_context_/add-file/cycle-3-draft.png).

**Landed:** commit `a6d2d38`; `_verifiers_/96-deployment` reports the live service at 3082 running the
deployment checkout's `dist/cli.js` and 8082 serving that checkout's built page byte for byte.

## Cycle log

| Cycle | Reference measured | Target measured | Fix rows | Outcome |
|---|---|---|---|---|
| 1 | `+` menu, File item, hidden multiple input, pending cards, remove | workspace-tree menu only; no file input | the capability itself (no way to add a file from the computer) | implemented; unit tests, browser contract, screenshot, every suite green after re-runs |
| 2 | the same menu, re-read | `File` only at the menu's root; two-file and removal behaviour | 1: `File` disappears inside the tree | pinned at every level; failing-first browser check now passes |
| 3 | the same menu, re-read | `File` at every level, picker asked, stored path in the draft | none | stopped early with the differences above recorded rather than worked around |

## What is not covered

- A file larger than 10 MiB is refused by the route; the browser gesture for that refusal is not
  exercised.
- A failed upload shows a reason in the menu; only the happy path is in the browser contract.
- The screenshot per cycle is evidence for a reader, not the assertion: the contract asserts the
  draft path, the stored bytes and the menu states.

## Landing and deployment

The owner's rule of 2026-10-17 (full-loop-goal v1.4, [`_conventions_/landed-and-deployed/`](../_conventions_/landed-and-deployed/INDEX.md)):
a green branch is a checkpoint, and done means **merged into main and deployed**, with the deployment
observed at the address the owner uses.

### The landing

`main` was being written by other sessions throughout this loop, so landing could not be a plain
fast-forward: it would have overwritten their working copies. The change was landed as one commit whose
tree is the branch's tree, with the three files another session also edits
(`src/server/page.html`, `_verifiers_/80-web-ui/check-composer.mjs`, `test/page-contract.test.ts`) set to
a three-way merge of **main's committed content, their uncommitted working copy, and this change** — so
their hunks stayed uncommitted and unstaged by this loop, and the landing commit contains only this
change's hunks. Their staged entries for other files were not touched.

- **Landed commit:** `a6d2d38` — `feat(web): the + menu adds a file from the computer as a readable path`,
  on `main` (parent `5a44f08`).
- **Branch:** `feat/add-file` in `/Users/zhenc/heddle-addfile` remains the checkpoint; it was rebased onto
  `5a44f08` before landing (reconciling the sandbox's module rewrite and the model-seat check rewrite),
  its suites were green there, and it carries the per-cycle commits. The branch's verifier-fix commit was
  dropped during rebase because main's newer `check-model-switcher.mjs` had already replaced that check.
- **Main and origin:** `origin/main` reached `ba4f991` with `a6d2d38` in its history (another session's
  push carried the landed commit), so main and origin agree.

### The deployment

The deployment is a separate checkout, `/Users/zhenc/heddle-deploy`, whose agent is
`~/Library/LaunchAgents/com.dtadpole.heddle-web.plist`; the verifier reads that agent rather than assuming
a path. It was one commit behind, so it was pulled to `ba4f991` (clean, committed `main`), built, and the
agent restarted. The process behind the owner's port is now the deployment checkout's own build:

- **Process:** PID 97134, started 21:26 local, command
  `/Users/zhenc/.volta/tools/image/node/24.19.0/bin/node /Users/zhenc/heddle-deploy/dist/cli.js web --host 127.0.0.1 --port 3082`.
- **`_verifiers_/96-deployment`:** 3 of 3 checks pass — the live service runs the deployment checkout's
  cli, the page at `http://127.0.0.1:8082/` is that checkout's built page byte for byte, and the
  deployment checkout contains only committed `main` (`ba4f991`).
- **Observed end to end at the deployed URL:** `+` opened the menu, its `File` entry asked for the file
  picker once and closed the menu, and choosing a real file put
  `/Users/zhenc/.heddle/uploads/2026-10-18T04-27-03-497Z-landed-sample.md` in the draft; the stored file
  exists and its bytes are the chosen file's. Screenshot:
  [`_context_/add-file/landed-8082.png`](../_context_/add-file/landed-8082.png).

The two conditions of the rule are therefore met: the change is on `main` (and on `origin/main`), and the
owner's address serves that build with the behaviour observed live.

## Commits

| Where | Commit | What |
|---|---|---|
| `main` | `a6d2d38` | the landed change: Add File, its unit tests, the browser contract, this document and its screenshots |
| `feat/add-file` | branch tip before landing | the per-cycle commits: the capability, cycle 2's per-level fix, and this document's first version |
| dropped | `fix(verifiers): the model switcher check isolates its home and waits for its own answer` | superseded by main's newer model-seat check; not re-applied |
