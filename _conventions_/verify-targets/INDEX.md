---
title: Verification targets
version: 1.0.0
description: The suite has two targets — a fast standard run that needs no browser, and the full UI run — with measured costs, a rule for which to run, and an honest accounting of what the standard target skips.
grounded_in:
  - source: owner statement 2026-10-17 asking which part of the test or verifier suite is slow, to fix the speed or make browser-dependent checks optional for a standard deployment, with a separate target for UI browser checks
  - source: measurements of 2026-10-18 in this checkout (_tools_/verify-runner/all.mjs timings on this machine)
---

# Verification targets

The verifier suite grew a browser: 14 checks in part 7 alone drive a real Chrome, and they take almost the whole run. That is
the right way to judge a rendered behaviour, and the wrong thing to require of a standard deployment host. This convention states
the two **targets**, which one a change runs, and what the standard target is allowed to leave unjudged.

## The rule

- **The standard target needs no browser.** `HEDDLE_VERIFY_UI=0` makes the browser gate answer "no" for every check that needs a
  page; those checks report **skipped** with a reason. The standard target is the verdict for a machine that has no display and no
  Chrome, and it must hold there.
- **A change runs the standard target** (`npm run verify:fast`: unit suite plus every verifier part) before it is done.
- **A change that touches a rendered surface runs the UI target** (`npm run verify:ui`) as well: the page, the sidebar, the panel,
  the composer, a control, a glyph, any layout or animation.
- **A skip is stated, never silently counted as a pass.** The runner exits `3` for an unjudged run. Only the standard target, with
  `--allow-skip` passed by its own runner, converts *deliberate* skips into a `0` — and it prints how many it skipped and why.
  A failure always outranks a skip.
- **A check is not made optional by editing it.** The gate is the environment (`browserAvailable()`), so the same check file is
  fully judged by the UI target and honestly skipped by the standard one.

## How it is implemented

| Piece | What it does |
|---|---|
| `_tools/verify-runner/browser.mjs` `browserAvailable()` | answers `false` when `HEDDLE_VERIFY_UI=0`, so every `skipUnless(browserAvailable())` check skips with one reason |
| `_tools/verify-runner/run.mjs` `--allow-skip` | a no-failure run with deliberate skips becomes verdict `0` with the skipped count in its reason; without the flag a skip is still `3` |
| `_tools_/verify-runner/all.mjs` | runs **every** `_verifiers_/*` part in order, prints a per-part timing table and the slowest parts, and reports one verdict |
| `npm run verify:fast` | unit suite, then `all.mjs` with `HEDDLE_VERIFY_UI=0` |
| `npm run verify:ui` | unit suite is not repeated; `all.mjs` with the browser available |
| `_tools/verify-runner/_tests_/verdict-rules/unit.test.mjs` | judges the skip rule: allowed only on request, never by default, and never over a failure |

## Measured cost (2026-10-18, this machine)

Standard target — every part, no browser — **234.5 s** (15 of 16 parts hold; the one red part is the delivery check, see below):

| Part | Standard | UI target |
|---|---|---|
| 80-web-ui | 82.8 s | 315.2 s |
| 75-permission-sandbox | 67.0 s | 66.9 s |
| 70-workspaces-sessions | 42.2 s | 146.1 s |
| 90-web-ui-token | 18.0 s | 18.1 s |
| 10-llm-backends | 5.4 s | 5.5 s |
| 30-context-management | 4.2 s | 4.3 s |
| every other part | ≤ 4 s each | ≤ 11 s each |
| **all 16 parts** | **234.5 s** | **593.3 s** |
| unit suite (`npm test`) | ~2 s | ~2 s |

The browser checks are the difference: part 7 goes from 42 s to 146 s (45 checks instead of 31 judged + 14 skipped), and
80-web-ui nearly quadruples. The **core** parts that hold the harness itself (05 through 60) cost about **20 s together**, so a
target that wants only the core can run those seven folders in that time.

## The instance that made it necessary

The owner reported the suite as slow and asked for the UI checks to be optional. Measured from the runner's TAP durations, the
slowest 12 checks of part 7 were **all browser checks except one**, led by a folder open/close check at 24.5 s — and the full part
7 run took 149 s with a browser versus 42 s without. A standard deployment host without Chrome could therefore not run the
repository's own contract at all.

## Where this is partial today

- **96-deployment needs a clean deployment checkout.** Its second check asserts the deployed checkout is on `main` with no
  uncommitted changes. In this shared checkout, a concurrent session's working files make it red even when the code holds;
  that is a **delivery fact** the check reports correctly, not a target defect. It is fast (≈1 s) and belongs to the standard run.
- **80-web-ui's UI target run was red on 2026-10-18**, and the three failing check files are named rather than hidden:
  `check-chat-view.mjs` (the served page carries a build marker that is not this build — the deployment is serving another
  worktree's build), `check-composer.mjs` (a scripted turn left "0 turns" where the check expects 2), and `check-goal.mjs` (the
  goal dock measures 764 px against a 796 px card). The standard target skips all three; that is the honest state of that part, and
  the split is what makes it visible without making the standard run red for a UI-only reason.

## The anti-patterns

- Removing or weakening a browser check so the standard target can be green: the standard target is green **because it says what it
  skipped**, not because the check is gone.
- A skip reported as a pass by the runner: the `--allow-skip` flag exists only in the standard target's command, and the verdict
  reason names the skipped count.
- A timing claim without a measurement: the table above is produced by `all.mjs` on this machine, and re-measuring is one command.
