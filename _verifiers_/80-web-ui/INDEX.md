---
title: Verifier 9 — Web UI
created: 2026-10-11T09:56:12Z
modified: 2026-10-23T05:04:11Z
version: 1.3.0
description: a Web UI on localhost, on a documented default port, whose access-mode control is a session-scoped permission selector.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, listing the ten verifiers
---
# `80-web-ui`

Instance of this project's `_verifiers_`. **The claim it decides:** a Web UI on localhost, on a documented default port.

The harness needs a face. This part judges that a documented default port serves a page, that the page carries the session list and a live region, and that a browser-shaped request without a token is not the same answer as one with it.

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

Exit `0` when the claim holds, `1` when it fails, `3` when it could not be judged. A
claim that could not be judged is never reported as holding, which is the runner's
whole reason for existing — see [`_tools_/verify-runner/`](../../_tools_/verify-runner/INDEX.md).

## Read next

[`checks.md`](checks.md) for each check file and what the part leaves out; [`readings.md`](readings.md) for the measured verdicts.

[`../INDEX.md`](../INDEX.md) for the verifications, and
[`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the part this one decides.
