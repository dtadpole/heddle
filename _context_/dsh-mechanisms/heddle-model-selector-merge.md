---
title: Landing the model selector on main — merge, deploy, verify
version: 1.0.0
description: How feature/model-selector is integrated into the rewritten main line, which conflicts were resolved and why, what the merged build was verified with, and the hand-off boundary for deploying the owner's supervised service.
grounded_in:
  - owner instruction 2026-10-17 to set up a full-loop goal to merge, deploy and verify the model selector
  - lead coordination note 2026-10-17 that com.dtadpole.heddle-web (3082/8082) is the owner's main-build service, is supervised outside this workstream, and must not be repointed or restarted by this workstream
  - the topology measured 2026-10-17: main's history was rewritten around 19:4x, so the feature branch's base commits (d446e67, 8e99e55) are no longer ancestors of main; a merge is not the right operation
---

# Landing the model selector on main

This document is the memory of the merge-deploy-verify loop. The feature branch
`feat/model-selector` was written against a main line that another session later **rewrote**; the merge answer is
therefore a replay of the feature's changes onto the current main, not a merge of the old branch.

## Cycle 1 — topology, integration, verification

```
Cycle 1 — replay the feature onto the rewritten main and verify the merged build
  measured:   topology first: `git merge-base main HEAD` = e84ffa7, while the branch's base commits d446e67 and
              8e99e55 are **not** ancestors of main (`git merge-base --is-ancestor` exits 1). Main's reflog shows
              the rewrite at 19:42-19:45 (d18b1a9 onwards). A merge would reintroduce the pre-rewrite line and 120
              duplicated commits; a replay is the only answer.
              A `git merge main` into the branch produced 32 conflicted files (~150 hunks); the same content as six
              cherry-picks onto main produced 5 conflicted files in the first commit and 1-3 later. Chosen:
              cherry-pick the six feature commits onto a fresh branch from main (`integrate/model-selector`).
  brainstorm: (a) merge main into the branch — rejected: divergent rewritten history, 32 files, duplicate commits;
              (b) cherry-pick the six feature commits onto main — chosen: 5 conflicts in the feature commit, the
              rest small; (c) squash the whole feature diff as one patch — rejected: one giant conflict region;
              (d) rebase the old branch — rejected: replays 120 unrelated pre-rewrite commits.
  step back:  the objective narrows from "merge" to "replay onto main". The replay must also adapt the feature's
              checks to what main now does — the provider context-window discovery (`GET /models`) and the
              statistics dock, which changes the composer's height during a turn.
  changed:    branch integrate/model-selector, six commits replayed (35d1406, 062bb71, 7052640, 52ead69, b768a4d,
              ccda137). Conflicts resolved: src/llm/adapters.ts (usage imports + reasoning imports);
              src/server/web.ts (SessionFlagError + SessionMeta imports); src/server/page.html (main's session
              stats assignment kept beside the reasoning-effort argument of applySessionModel); the skill's
              v1.4.0 delivery section kept whole over main's 1.3.0; test/page-contract kept main's
              `extracted[1] ?? ''`; test/model-switcher kept main's "no machine-specific endpoint default" test
              **and** the new exclusion test, rewritten for main's defaults (only `scripted` now).
              Integration fixes: the browser contract's doubles now answer `GET /models` (main's context-window
              discovery) and count `turns` separately from discovery calls; `openMenu` retries a click once after
              a layout shift (main's statistics dock appears during the first turn and moves the composer by a few
              pixels); the running-turn hold is 3.2s so the switch happens before the first round ends.
  evidence:   `npm run check` clean; `npm test` 345/345; `npm run build` clean; `_verifiers_/80-web-ui` folder
              exit 0 (39 checks across its ten files, including the model-switcher contract 5/5); model-switcher
              contract green on a fresh run after the double/retry fixes (it was 3/5 before them: discovery calls
              counted as turns, and the running-turn menu click landed where the seat used to be).
  delivered:  not deployed by this workstream. The shared service stays the owner's main build; the merged tree is
              verified from a private server (3086) started from the integrated worktree, and `8082` is not touched.
              Landing on `main` is blocked while the main checkout has another session's uncommitted changes
              (18 files incl. src/server/page.html).
  reds:       none in the integrated tree's own suites. Outside: main landing must wait for the main checkout to be
              clean; deployment (restart of com.dtadpole.heddle-web) belongs to the Lead/owner.
  coverage:   the whole integrated build's unit suite and the Web UI verifier folder; the model-selector contract
              with trusted input; the live probe against 3086 with the real catalogue (see cycle 2 for its result).
  invariants: main's statistics dock, session flags, sidebar column and context-window discovery are all exercised by
              their own checks in the same folder; the model selector's states are unchanged by the integration.
  lessons:    when the base line is rewritten, a "merge" is a replay — and the replay must adopt the new line's
              behaviours in its own verification instruments (discovery requests, moving composer), not just in
              the product code.
```

## Cycle log continues

(cycles 2 and 3 appended as they complete: private-server live probe, landing, deployment hand-off and the
owner-URL verification)

## Cycle 2 — main's landing convention and the two v1.4 skills

```
Cycle 2 — merge the refreshed main and keep both completion rules
  measured:   main moved twice while the first integration was verified: ed183ea (permission modes, sidebar column,
              session flags) and 42bfc17, which added `_conventions_/landed-and-deployed/` and
              `_verifiers_/96-deployment/` — the judge that fails when the process behind 3082 is not this
              checkout's `dist/cli.js` or when the 8082 page is not this checkout's built page. Both main and this
              branch had independently written a v1.4.0 of `full-loop-goal`: main's landing rule and this
              branch's delivery rule.
  brainstorm: skill clash: (a) take main's version — loses the deliver-at-the-owner's-address mechanisms the branch
              learned; (b) take the branch's — loses the landing rule and the `landed:` cycle line; (c) keep both
              as one v1.4 — chosen: they are the two halves of completion (deliver to the address, then land and
              deploy). Conflict-resolution: page.html and page-contract auto-merged this time (main's latest edits
              were the access-control markup already merged in cycle 1).
  step back:  the acceptance criterion is now explicit and external: land in main, then the deployment must be
              verified by `_verifiers_/96-deployment` (process + byte-identical owner page) **and** the
              user-visible selector on 8082. A green integration branch is a checkpoint.
  changed:    branch integrate/model-selector now = main 42bfc17 + the six feature commits + two merge commits
              (f733609, b282d68). Skill conflict resolved by combining the two v1.4 intros and grounding bullets.
  evidence:   npm run check clean; 352/352 unit tests; build clean; model-switcher contract 5/5; the final
              integrated build on a private server (3086) passes the live probe 50/50 including the running-turn
              switch, reload, keyboard and trusted mouse clicks; screenshot `heddle-live-integrated-3086.png`.
              `_verifiers_/80-web-ui` folder was green (39 checks) before the latest docs-only merge; the merged
              tree's `96-deployment` cannot pass by construction until main itself carries the build.
  delivered:  not yet. Landing is blocked by another session's **uncommitted** edits in the main checkout to four
              files this change also edits: src/local-config.ts, src/server/page.html, src/session/store.ts,
              test/page-contract.test.ts (measured 20:52, diff 71 lines total, mtimes 20:28-20:43). A fast-forward
              would overwrite them; sweeping them into main is the anti-pattern the new convention names. The
              landing is therefore **handed over ready-to-run**: branch `integrate/model-selector` @ b282d68,
              fast-forwards main; the deploy half (restart of com.dtadpole.heddle-web) is the Lead's, and the
              8082 verification runs after that restart.
  reds:       none in the integrated tree. Two external conditions block completion and are named: (1) main
              checkout dirty on overlapping files; (2) service restart owned by the Lead.
  coverage:   private-server live probe states (seat, root, grouped models, search, effort, keyboard, selection,
              reload, running switch, clamp, outside click) on the integrated build; the owner's 8082 behaviour is
              not measured yet by construction.
  invariants: main's new `_verifiers_/96-deployment`, permission modes, stats dock, session flags and sidebar are all
              in the same merged tree and the 80-web-ui folder remained green.
  lessons:    "merge, deploy, verify" already existed as a convention in the target main — a workstream's completion
              rule must be read from the target line, not assumed from its own skill.
```

## Cycle 3 — readiness

```
Cycle 3 — the landing package and its judge
  measured:   the landing command is a fast-forward of main to b282d68 (main 42bfc17 is an ancestor). The judge
              after the merge is `_verifiers_/96-deployment` (two assertions: process path, served-page byte
              identity), plus the model-selector live probe against 8082 after the Lead restarts the service.
  state:      branch pushed (origin/integrate/model-selector), main untouched, service untouched (still
              /Users/zhenc/heddle/dist/cli.js, PID seen at 20:43).
  landing steps recorded for whoever holds the clean window:
              1. `git -C /Users/zhenc/heddle merge --ff-only integrate/model-selector`
              2. `npm run build` in /Users/zhenc/heddle
              3. Lead/owner restarts com.dtadpole.heddle-web (this workstream must not)
              4. `sh _verifiers_/96-deployment/verify.sh` and the trusted-click selector probe at 8082
  lessons:    a delivery that cannot land because someone else's half-written tree overlaps it is a handover, not a
              completion; the branch and the exact steps are the deliverable until the window opens.
