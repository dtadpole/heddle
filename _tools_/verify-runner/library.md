---
title: The library a check imports
created: 2026-10-24T05:55:00Z
modified: 2026-10-31T07:45:00Z
level: L3
version: 1.0.0
description: The five rules lib.mjs carries for every check, the browser wrapper, and where runtime screenshots go.
status: unverified
grounded_in:
  - source: human-authored
  - source: measurement that the Cordis loader imports a plugin by absolute path, so a fixture in /tmp cannot resolve its package
---

# The library, `lib.mjs` and `browser.mjs`

`lib.mjs` is what a check file reaches for so that a fixture, a fake model or a transcript read is written once
instead of in every check. Five rules it carries are worth naming:

- **Nothing spends anything.** `scriptedConfig` points an endpoint at a JSON file of steps, and `chatDouble` /
  `responsesDouble` are local HTTP servers that speak the provider's real wire shape. The one check that spends quota
  says so in its own name. A new session's first prompt also sends a title request to the same endpoint (DSH's
  first-prompt title, #68); every double refuses it with `refuseTitleRequest` when `isTitleRequest(body)` says so, and
  does not count it, so a double that answers a turn's requests in order still sees only the turn's.
- **Fixtures live under `.heddle-tmp/` inside this checkout.** Measured: the Cordis loader imports a plugin by
  absolute path, so a fixture in `/tmp` cannot resolve `@deepseek-ai/cordis`, and Node strips TypeScript types by
  extension, so a generated plugin fixture is `.ts` while a check file is `.mjs`.
- **A check that cannot judge says so.** `skipUnless` turns a missing mechanism into a labelled skip, which the runner
  counts as unjudged rather than as a pass.
- **A check asks for a session, not for a file format.** `transcriptFile(dir)` finds the transcript a session actually
  has in either store layout, and `readTranscript` decodes both the zstd and plain formats.
- **A check runs the harness under test, never `dist/cli.js` by name.** `runCli`, `runCliTimed` and a check's own
  `spawn(...heddleCommand(args))` run `node dist/cli.js` by default and the binary named by `HEDDLE_BIN` otherwise;
  `harnessEntry()` is the file that is the harness, for a check asking whether there is a build to judge. A check that
  imports `dist/` modules cannot judge a binary, so it starts with `inProcessOnly(context, claim)` and is unjudged
  under `HEDDLE_BIN`.

`browser.mjs` is the one-page wrapper over [`browser-use`](../browser-use/INDEX.md): `goto`, `evaluate`, `waitFor`,
`screenshot`, `close`, headless by default, with a temporary profile per call. It is not a second driver — it imports
the tool and adds only the API the checks were written against. `gotoSession(url, id)` opens the Web UI with that
session as the one it restores: the page opens no session on its own (a load with nothing saved starts a fresh one,
#17), so a check that seeds a session and reads it on screen names it this way.

**Runtime browser evidence.** `evidencePath(name)` allocates a distinct screenshot destination under
`.heddle-tmp/verifier-evidence/<run>/<allocation>/`; the parent exists before capture, each allocation preserves
earlier observations (same filenames included), and names cannot contain directory components. Browser checks must
not overwrite the historical screenshots in `_context_`: that dirties the committed deployment checkout while it is
being verified. The mechanism needs no browser; taking a screenshot still runs headless, as each verifier describes.

The library's rules are component-tested in [`_tests_/helper-rules/`](_tests_/helper-rules/INDEX.md): transcript
finding and decoding, session listing, JSON extraction, fingerprints and `skipUnless`.
