---
title: Verifier — File Preview
created: 2026-10-12T05:27:41Z
modified: 2026-10-23T05:04:11Z
version: 1.1.0
description: a file clicked in the left panel is previewed in one place, rendered by the library its type calls for.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, asking that the Docs tab be removed and the File tab be the one preview surface, rendered with the appropriate library
---
# `88-file-preview`

Instance of this project's `_verifiers_`. **The claim it decides:** a file is previewed in exactly **one** place —
the File panel a click on the left panel opens — and each file type is rendered with the library appropriate to it.

This part replaced `89-markdown-view`, which judged a **Docs** tab that the owner removed. Its subject no longer
exists, so its claims moved here: what remains to judge is where a document is shown, and by what.

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

Exit `0` when the claim holds, `1` when it fails, `3` when it could not be judged — a host without a browser is the
`3` case.

## PNG regression

The standalone PNG check in [`check.mjs`](check.mjs) drives offline HTTP and a headless browser against
both builds (default TypeScript CLI, or `HEDDLE_BIN` for Rust). It asserts actual image decoding,
accessible alt and decode-error text, `no-referrer`, and unchanged token/workspace refusals for the
metadata and raw-byte routes. This is PNG-only coverage, not an all-format or zoom claim.

```bash
_tools_/local-build/run --ts -- node --test --test-name-pattern='standalone PNG' _verifiers_/88-file-preview/check.mjs
```

Run from the repository root; build the selected CLI through its corresponding resource gate first.

## Functional footnote regression

[`check-footnotes.mjs`](check-footnotes.mjs) judges functional Markdown footnotes through the actual
`/api/file` renderer against either built CLI, honoring `HEDDLE_BIN`. Its isolated, offline document
cites one note twice and includes multiple paragraphs, bold text, a list and safe/unsafe URLs. It
checks one rendered note body, two visible numeric citations, safe return links, and sanitized
markup. This is not full Markdown grammar parity or an exact DSH/Rust/TypeScript anchor DOM contract.

**No browser by default.** The optional actual File-panel check runs **headless** only when
`HEDDLE_FOOTNOTE_BROWSER=1` and the shared browser gate permits it; `HEDDLE_VERIFY_UI=0` skips it
normally. Startup, HTTP requests, tests and cleanup are bounded. Build the selected CLI first;
the verifier neither builds nor contacts a model endpoint.

```bash
node --test _verifiers_/88-file-preview/check-footnotes.mjs
HEDDLE_FOOTNOTE_BROWSER=1 node --test _verifiers_/88-file-preview/check-footnotes.mjs
# For the other built CLI, prefix either command with HEDDLE_BIN=/path/to/heddle.
```

Run from the repository root. The optional browser test is a labelled skip unless requested;
the default API test still judges the selected build.

## Read next

[`checks.md`](checks.md) for the surface and the renderers; [`rendering.md`](rendering.md) for rendering fidelity; [`readings.md`](readings.md) for the measured verdicts; [`../INDEX.md`](../INDEX.md) for the verifications.
