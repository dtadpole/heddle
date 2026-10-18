---
title: Session Folder Baseline Regression Evidence
level: L0
version: 1.0.0
description: Records the two-folder context verifier and its old-rule negative control.
status: verified
grounded_in:
  - source: af7a874 regression fixture and the built context verifier observed during this session
---

# Session folder baseline regression

The context baseline implementation is `a8bf162`. The fixture correction is `af7a874`.
The claim is that a turn reads instructions from its session's own folder while file effects remain
under the configured sandbox root.

## Why the former check missed the defect

The old fixture opened its session from the repository root but put `ALPHA` in the sandbox root. It
therefore described the old rule rather than the delivered rule. The new fixture launches its first
turn from the folder holding `ALPHA` and puts the decoy `ELSEWHERE` in a separate sandbox root.

The instruction notes in the turn's append-only log are inspected **before** `heddle context` is run.
That command refreshes the baseline itself and can conceal an incorrect turn baseline in the current
surface. The log cannot conceal it because replacement does not erase a prior note.

## Observations

- With the session-folder rule, all eight checks in verifier 30 pass without skips.
- A negative control changed only the generated loop's three instruction-directory uses to its
  sandbox-directory value. The targeted instruction check failed. The generated loop was restored
  before rerunning the verifier.
- The resumed turn still follows an edit from `ALPHA` to `BETA`; the surface has one current baseline
  while the log retains the earlier one.
- The whole-file budget fixture now starts from its nested session folder. It retains the narrow
  rules rather than loading the launch repository's rules.

These observations establish the fixture's ability to reject the original directory-selection bug.
They do not establish whole-project completion or browser, deployment, or real-provider correctness.
