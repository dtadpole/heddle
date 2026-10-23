---
title: Verifier — Trajectory View
created: 2026-10-11T22:05:58Z
modified: 2026-10-23T05:04:11Z
version: 1.1.0
description: the same session read as a conversation and as an event ledger, switched by a view ring.
grounded_in:
  - source: DSH's dsh-client-ui-trajectory, read from the installed 0.2.0-rc.2 packages on 2026-10-11
  - source: owner statement in the dsh session, 2026-10-11, asking for the two-view right panel
---
# `85-trajectory-view`

Instance of this project's `_verifiers_`. **The claim it decides:** one session can be read two ways — as
the conversation it was, and as the ledger of what the harness actually did — and the two views cannot
disagree about it.

It sits beside [`90-web-ui-token`](../90-web-ui-token/INDEX.md) rather than inside it because it judges a
different thing: not who may read a session, but whether the session's own record is *legible*. The
mechanism is copied from DSH's `dsh-client-ui-trajectory`, which the owner asked heddle to match.

## Where it runs

**Headless browser.** The checks that need a page open a real Chrome with no window, through
[`_tools_/browser-use/`](../../_tools_/browser-use/INDEX.md); the rest drive the CLI and local HTTP
doubles. Nothing here needs a display, so it runs unattended.

## Running it

```bash
sh verify.sh            # every check, with the verdict
sh verify.sh --list     # the check names, and why any was unjudged
sh verify.sh --json     # one parseable object
```

Exit `0` when the claim holds, `1` when it fails, `3` when it could not be judged — a host without a browser
is the `3` case.

## Read next

[`scope.md`](scope.md) for the two views and what the part leaves out; [`checks.md`](checks.md) for what it must get right; [`readings.md`](readings.md) for the measured verdicts.

[`../INDEX.md`](../INDEX.md) for the verifications,
[`../../_context_/dsh-mechanisms/`](../../_context_/dsh-mechanisms/INDEX.md) for the DSH readings, and
[`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts these sit under.
