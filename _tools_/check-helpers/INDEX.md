---
title: Check Helpers
version: 1.0.0
description: The fixtures and doubles every verifier check shares, so no check invents its own.
grounded_in:
  - source: human-authored
---

# `check-helpers`

Holds [`lib.mjs`](lib.mjs), the library every check file imports, and
[`browser.mjs`](browser.mjs), the one-page wrapper over
[`../browser-use/`](../browser-use/INDEX.md) that the checks which need a real page import. The
wrapper is deliberately thin: the driver, the snapshot and the session belong to the tool, and a check
that used a second implementation would be judging the wrong code.

`lib.mjs` exists so that three rules are stated once instead of ten times.

- **Fixtures live under `.heddle-tmp/` inside this checkout.** Measured: the Cordis
  loader imports a plugin by absolute path, so a fixture under `/tmp` cannot resolve
  `@deepseek-ai/cordis` and fails to load, and Node strips TypeScript types by
  extension, so a generated plugin fixture must be `.ts` while a check file itself is
  plain JavaScript.
- **Nothing spends anything.** `scriptedConfig` points an endpoint at a JSON file of
  steps and `chatDouble` / `responsesDouble` are local HTTP servers that speak the
  provider's real wire shape, so a check that drives a turn is offline and
  reproducible.
- **A check that cannot judge says so.** `skipUnless` turns a missing mechanism into a
  labelled skip, which the runner counts as unjudged rather than as a pass.
- **A check asks for a session, not for a file format.** `transcriptFile(dir)` finds the transcript
  a session actually has — `session.v2.jsonl.zstd` (one zstd frame per event) or the plain
  `session.jsonl` written before it — and `readTranscript` accepts either a directory or a path and
  decodes both. Measured while this changed: fifteen checks named `session.jsonl` directly, and
  every one of them would have been judging a file that no longer exists. These rules are now
  component-tested in [`_tests_/helper-rules/`](_tests_/helper-rules/INDEX.md), because a helper that reads the wrong file
  turns a check into a claim about nothing.

## What belongs in it

A helper used by two or more checks, or a rule that a check must not be free to
restate. A fixture used by exactly one check stays in that check's folder.

## Read next

[`../verify-runner/INDEX.md`](../verify-runner/INDEX.md) for the verdict the helpers feed, and
[`../../_verifiers_/INDEX.md`](../../_verifiers_/INDEX.md) for the ten claims.
