---
title: Landed and deployed
version: 1.0.0
description: A change is not finished on a green branch — it is finished when it is merged into main and the deployment the owner actually uses is verified serving that build, with the merge commit and the deployment evidence recorded.
grounded_in:
  - source: owner statement 2026-10-17 that a worktree branch may carry the initial verification, but the job is not done until the code is merged to main and the actual deployment is verified working
  - source: owner report 2026-10-17 that the composer's new footer was not visible — twice — while every suite was green, because the service behind port 8082 was running another worktree's build
  - source: the SESSION_STATS.md deployment section, which records the service repointed to /Users/zhenc/heddle-model-selector, the owner-page check, and the fix
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
- **Merging by sweeping.** A merge that commits another session's uncommitted files is a delivery of someone
  else's half-finished work; stage only this change's hunks, or hand the branch over.
- **Verifying only through the loop's own tools.** A page screenshot taken from a scripted server proves the
  build; it does not prove the deployment. The deployed URL is its own instrument.

## How it is judged

[`../../_verifiers_/96-deployment/`](../../_verifiers_/96-deployment/INDEX.md) — on a machine where the live
service exists, it fails when the process behind the owner's port is not the main checkout's `dist/cli.js`, or
when the page that port serves is not the main checkout's built `dist/server/page.html` byte for byte. When no
live service exists it reports **unjudged** rather than passing; a deployment that cannot be observed is not a
deployment that was verified.

## Where it applies

Every change whose effect is served to a person — the Web UI, the daemon, the proxy, the endpoints the page
reads. A library-only change still merges to `main`; the deployment half applies wherever there is a running
process to verify. It is partial today in exactly one way: the repository's checks judge a tree on an ephemeral
port, so the deployment half exists as this verifier and as the closing condition of the
[full-loop-goal](../../_skills_/full-loop-goal/INDEX.md) skill, not yet as a step in every verifier.
