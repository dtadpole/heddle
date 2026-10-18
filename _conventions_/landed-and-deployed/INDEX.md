---
title: Landed and deployed
version: 1.1.0
description: A change is not finished on a green branch — it is finished when it is merged into main and the deployment the owner actually uses is verified serving that build from a checkout that contains only committed main, with the merge commit and the deployment evidence recorded.
grounded_in:
  - source: owner statement 2026-10-17 that a worktree branch may carry the initial verification, but the job is not done until the code is merged to main and the actual deployment is verified working
  - source: owner report 2026-10-17 that the composer's new footer was not visible — twice — while every suite was green, because the service behind port 8082 was running another worktree's build
  - source: the SESSION_STATS.md deployment section, which records the service repointed to /Users/zhenc/heddle-model-selector, the owner-page check, and the fix
  - source: owner statement 2026-10-17 that when the main checkout is not clean, a folder holding only committed main should exist and the daemon should only run from there
---

# Landed and deployed

The rule: **a green branch is a checkpoint; "done" means merged to `main` and deployed.** Work may be isolated
in a git worktree and verified there first — that is why worktrees exist, and two sessions on one checkout will
otherwise fight over the same files — but the branch is not the delivery. The delivery is `main` merged, built
and running in the place the owner looks at.

## What "done" means, in two parts

1. **Merged into `main`.** The branch's own suites are green first, then it is merged (fast-forward or merge,
   per the repository's practice). If `main` carries another session's uncommitted work, the merge stages only
   this change's hunks; it never sweeps a half-written tree into `main`. The merge commit is recorded.
2. **The deployment is verified working.** Name the service the owner uses, read **which checkout its process
   runs** (`ps`/`lsof`, not the freshness of `dist/`), confirm the served artifact carries the feature, and
   observe the user-visible behaviour end to end. A `npm run build` is not a deployment; a daemon still running
   `/some/other-worktree/dist/cli.js` is the failure this convention exists for, and from the source tree it
   looks identical to a fresh one.

## The deployment checkout

A **workspace** and a **deployment** are two different checkouts, and they must not be the same one.

- The working checkout (`~/heddle` for this owner) is where sessions edit: it carries feature branches and other
  sessions' uncommitted files, and at any moment it may be mid-write.
- The **deployment checkout** is a separate folder containing only committed `main`. It is created once (a clone
  of the origin, on `main`), built, and served: the launchd agent's `ProgramArguments` name its `dist/cli.js`, and
  its `WorkingDirectory` is that folder.
- `_tools_/web-daemon/install.sh` **refuses** to install the agent from a checkout that is not on `main` or that
  has uncommitted changes (`HEDDLE_ALLOW_DIRTY_INSTALL=1` is the development override, never the deployment path).
  The refusal is the rule made mechanical: a green suite run from a workspace is not a deployment, and a served
  workspace can be modified under the process that is serving it.
- Landing means merging the change into the deployment checkout's `main`, building **there**, and letting the
  agent serve **that** folder. Waiting for a shared working checkout to become momentarily clean and racing a
  build into it is the failure mode this rule removes: the window is not a contract, and a build started there
  reflects whatever else the working tree holds.

This checkout also gives the landing step a fixed target: the merge happens on a tree that contains only
committed objects, so it can never sweep another session's half-written work, and the served bytes are exactly
the committed build. `~/heddle-deploy` is this machine's instance; the folder name is local, the rule is not.

## The instance that made it necessary

The composer's bottom statistics were implemented across three cycles and every suite was green. The owner
reported, twice, that the footer was not visible. The cause was not the code: the launchd service behind port
3082 had been repointed by another session to `/Users/zhenc/heddle-model-selector`, and the 8082 proxy — a
supervised transparent proxy fixed to 3082 by design — faithfully served that worktree's pre-feature build. The
fix was a plist edit, a restart and a page response; more features would not have helped.

A second instance is in the same record: the input-area loop's own "deployment is the last assertion" lesson,
written in SESSION_STATS.md after the service was found running a different checkout.

## The inverse anti-patterns

- **"The branch is green, so the job is done."** The owner's page can serve a different build while every
  check passes — the checks judge the tree they run in, not the process the owner's browser talks to.
- **"`dist/` is newer than `src/`, so it is deployed."** Freshness of an artifact says nothing about which
  process, on which checkout, is answering requests.
- **Serving from the working checkout.** A checkout that sessions edit is modified under the running process; the
  page a person sees then depends on which half-written file happened to be on disk. Serve a checkout that only
  contains committed main.
- **Merging by sweeping.** A merge that commits another session's uncommitted files is a delivery of someone
  else's half-finished work; stage only this change's hunks, or hand the branch over.
- **Verifying only through the loop's own tools.** A page screenshot taken from a scripted server proves the
  build; it does not prove the deployment. The deployed URL is its own instrument.

## How it is judged

[`../../_verifiers_/96-deployment/`](../../_verifiers_/96-deployment/INDEX.md) — on a machine where an agent is
installed and the service lives, it reads the **agent's** checkout and fails when: the process behind the owner's
port is not that checkout's `dist/cli.js`; the page the port serves is not that checkout's built
`dist/server/page.html` byte for byte; or that checkout is not a clean checkout of `main` (branch, no uncommitted
changes, HEAD at main's tip). When no agent or no live service exists it reports **unjudged** rather than passing;
a deployment that cannot be observed is not a deployment that was verified.

## Where it applies

Every change whose effect is served to a person — the Web UI, the daemon, the proxy, the endpoints the page
reads. A library-only change still merges to `main`; the deployment half applies wherever there is a running
process to verify. It is partial today in exactly one way: the repository's checks judge a tree on an ephemeral
port, so the deployment half exists as this verifier and as the closing condition of the
[full-loop-goal](../../_skills_/full-loop-goal/INDEX.md) skill, not yet as a step in every verifier.
