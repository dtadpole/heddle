---
title: Verify Runner
version: 2.0.0
description: Turns one check file into the project's verdict, and holds the fixtures, doubles and browser wrapper the checks are written with.
grounded_in:
  - source: human-authored
---

# `verify-runner`

Holds the two halves of one job — making a verifier's result **honest** and making a verifier's check
**writable**:

| File | Half |
|---|---|
| [`run.mjs`](run.mjs) | the judge: runs a check under Node's test runner, reads the TAP stream, and exits with the project's verdict |
| [`lib.mjs`](lib.mjs) | the library every check imports: the CLI runners, the scripted config and model doubles, isolated fixtures, transcript and session finding, `skipUnless` |
| [`browser.mjs`](browser.mjs) | the one-page wrapper over [`browser-use/`](../browser-use/INDEX.md) that the checks needing a page import |
| [`lib.d.mts`](lib.d.mts) | the names a TypeScript test may import from the library |
| [`_tests_/`](_tests_/INDEX.md) | both component suites — the verdict mapping and the library's rules |

## The verdict contract

| Exit | Meaning |
|---|---|
| `0` | every check passed |
| `1` | at least one check failed |
| `3` | nothing could be judged — a skip, or no checks at all |

## Why the judge exists rather than plain `node --test`

Measured on Node v24.19.0: a suite whose checks all skip exits `0`. That is the one answer that must
never be given for "nothing was judged", and it is the whole reason this wrapper exists. A part of the
goal that is not built yet must read as unjudged, never as holding.

## Run it

```bash
node _tools_/verify-runner/run.mjs _verifiers_/10-llm-backends/check-model-service.mjs
node _tools_/verify-runner/run.mjs <check> --list    # the check names, and why any was unjudged
node _tools_/verify-runner/run.mjs <check> --json    # one parseable object
```

`--list` and `--json` return the same verdict as a plain run, because the verdict is the result rather
than a side effect of printing.

The mapping itself is component-tested without running a check:

```bash
node --test _tools_/verify-runner/_tests_/verdict-rules/unit.test.mjs
```

## The library a check imports

`lib.mjs` is what a check file reaches for so that a fixture, a fake model or a transcript read is
written once instead of in every check. Four rules it carries are worth naming:

- **Nothing spends anything.** `scriptedConfig` points an endpoint at a JSON file of steps, and
  `chatDouble` / `responsesDouble` are local HTTP servers that speak the provider's real wire shape.
  The one check that spends quota says so in its own name.
- **Fixtures live under `.heddle-tmp/` inside this checkout.** Measured: the Cordis loader imports a
  plugin by absolute path, so a fixture in `/tmp` cannot resolve `@deepseek-ai/cordis`, and Node strips
  TypeScript types by extension, so a generated plugin fixture is `.ts` while a check file is `.mjs`.
- **A check that cannot judge says so.** `skipUnless` turns a missing mechanism into a labelled skip,
  which the runner counts as unjudged rather than as a pass.
- **A check asks for a session, not for a file format.** `transcriptFile(dir)` finds the transcript a
  session actually has in either store layout, and `readTranscript` decodes both the zstd and plain
  formats.

Alongside it, `browser.mjs` is the one-page wrapper over `browser-use`: `goto`, `evaluate`, `waitFor`,
`screenshot`, `close`, headless by default, with a temporary profile per call. It is not a second
driver — it imports the tool and adds only the API the checks were written against.

## Why the judge and the library share an instance

They are one job with two audiences: the judge is a command, the library is a library, and a reader
looking for either starts at the same place. The boundary that matters is still the process, not the
folder:

- `run.mjs` is invoked by every `verify.sh` (`node _tools_/verify-runner/run.mjs <check>`) and is
  **never imported by a check**, so a check cannot reach into the decision about its own score.
  `classify` is exported only for the component tests.
- `run.mjs` stays dependency-free — no browser, no harness modules — while `lib.mjs` and `browser.mjs`
  carry the transcript decoder and the tool. The judge's dependencies are the judge's own.

## The mapping it implements

`classify` is exported and documented because the mapping is the claim: no checks at all is `3`, any
failure is `1`, any skip is `3`, and only a run where every check passed is `0`.

## Component tests

Two suites, one per half: [`_tests_/verdict-rules/`](_tests_/verdict-rules/INDEX.md) pins
`classify`/`tapCounts`/`collectNames` with nine tests that spawn nothing, and
[`_tests_/helper-rules/`](_tests_/helper-rules/INDEX.md) pins the library's rules — transcript finding
and decoding, session listing, JSON extraction, fingerprints and `skipUnless`.

## Read next

[`_verifiers_/INDEX.md`](../../_verifiers_/INDEX.md) for the verifications and the contract they keep,
[`browser-use/INDEX.md`](../browser-use/INDEX.md) for the browser the page checks drive, and
[`_tests_/INDEX.md`](_tests_/INDEX.md) for both suites.

## Runtime browser evidence

`evidencePath(name)` allocates a distinct screenshot destination under
`.heddle-tmp/verifier-evidence/<run>/<allocation>/`. The parent exists before capture. Each allocation
preserves earlier observations, including allocations with the same filename. Names cannot contain
directory components. Browser checks must not overwrite the historical screenshots in `_context_`:
that dirties the committed deployment checkout while it is being verified. This mechanism needs no
browser; taking a screenshot still runs headless as described by each verifier.
