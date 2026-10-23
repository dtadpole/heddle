---
title: Verifier 10 — Web UI Token
created: 2026-10-11T09:56:12Z
modified: 2026-10-23T05:04:11Z
version: 1.1.0
description: the Web UI and its stream are protected by a token.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, listing the ten verifiers
---
# `90-web-ui-token`

Instance of this project's `_verifiers_`. **The claim it decides:** the Web UI and its stream are protected by a token.

A UI on localhost is still a door. This part judges that a token is generated and stored where a person can find it, that a request without it is refused with a status that says so, that a request with it is answered, and that the event stream enforces the same rule as the API.

## Where it runs

**No browser.** The checks drive the CLI and the server over local HTTP, and read the served page as
text where the page's own source is the subject. Nothing here needs a display or a window; the page's
rendering is judged by the Web UI parts that own it.

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

[`checks.md`](checks.md) for what decides the claim and what it leaves out; [`readings.md`](readings.md) for the measured verdicts.

[`../INDEX.md`](../INDEX.md) for the verifications, and
[`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the part this one decides.
