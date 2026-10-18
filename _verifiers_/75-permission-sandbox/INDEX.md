---
title: Verifier 8 — Permission Sandbox
version: 1.2.0
description: a permission sandbox distinguishes read-only, workspace write and full access, per session as well as per process, for the file tools and for a shell.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, listing the ten verifiers
---

# `75-permission-sandbox`

Instance of this project's `_verifiers_`. **The claim it decides:** a permission sandbox distinguishes read-only, workspace write and full access.

A sandbox that has never refused anything is a sandbox nobody has tested. This part judges three modes that behave differently — a write inside the workspace, a write outside it, and the same write under each mode — and judges that a refusal names the boundary it enforced.

## Where it runs

**No browser.** The checks drive the CLI, a scripted endpoint or a local HTTP double; nothing here needs
a display or a window.

## What decides it

- [`check.mjs`](check.mjs) — the three modes under three profiles, judged by refusal: a write inside the
  workspace, a write outside it and a read outside it, each under the mode that should permit or refuse it,
  including the string-prefix and host-temp cases a sandbox is easy to get wrong.
- [`check-session-mode.mjs`](check-session-mode.mjs) — the mode as a **session** fact: a session's own mode
  outranks the deployment mode for that session and no other, the change is recorded once through the HTTP
  API, an escalation to full access is refused by the server without the explicit confirmation, and no tool
  call writes the mode.
- [`check-shell-confinement.mjs`](check-shell-confinement.mjs) — the mode as a **kernel** fact for the shell:
  the inside write is permitted and the outside one denied under workspace-write (including from a descendant
  shell), read-only keeps the shell but denies its writes, danger-full-access is the only bypass, `/dev/null`
  stays writable, a command that merely prints the denial sentence is not misclassified, and a missing backend
  fails closed instead of running the command unconfined.

## Running it

```bash
sh verify.sh            # every check, with the verdict
sh verify.sh --list     # the check names, and why any was unjudged
sh verify.sh --json     # one parseable object
```

Exit `0` when the claim holds, `1` when it fails, `3` when it could not be judged. A
claim that could not be judged is never reported as holding, which is the runner's
whole reason for existing — see [`_tools_/verify-runner/`](../../_tools_/verify-runner/INDEX.md).

## What it deliberately does not judge

- **How well a model reasons.** Nothing here scores an answer's quality; the checks
  ask whether the mechanism works.
- **Anything it has to spend to see.** Except where a check is named for the real
  backend, every fixture is local and the run is free.

## Read next

[`../INDEX.md`](../INDEX.md) for the verifications, and
[`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the part this one decides.
