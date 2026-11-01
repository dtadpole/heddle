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

## Encoded Markdown image HTTP regression

[`check-markdown-image-paths.mjs`](check-markdown-image-paths.mjs) needs **no browser**. It starts an isolated
server on port zero, reads the Markdown preview's emitted image URLs, and verifies exact distinct PNG bytes for
space, literal-percent and Unicode/ampersand filenames, plus cookie and workspace refusal. It does not judge
standalone PNG preview, browser image rendering, or query-suffix semantics.

```bash
node --test check-markdown-image-paths.mjs
HEDDLE_BIN=/path/to/heddle node --test check-markdown-image-paths.mjs
```

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
checks one rendered note body, two plain numeric superscripts, one plain ↩ return marker per
occurrence, no generated footnote IDs or click hrefs, and sanitized markup. This follows DSH's
plain-footnote policy rather than anchors that can jump into another answer. Ordinary note-body
links remain links. This is not full Markdown grammar parity.

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

## HTML base policy regression

The HTML check in [`check.mjs`](check.mjs) uses a **headless browser** and reads its actual recorded console
for `base-uri` violations. It verifies that source base elements are sanitized, no base is injected, the
`base-uri 'none'` policy and script/form/frame/sandbox restrictions remain intact, and quoted image and
linked stylesheet resources still load via the authenticated raw route. Relative CSS `url()`/`@import`
dependencies remain unsupported; this check does not claim full CSS dependency parity or URL isolation.

```bash
_tools_/local-build/run --ts -- node --test --test-name-pattern='an html document is previewed' _verifiers_/88-file-preview/check.mjs
HEDDLE_BIN=/path/to/heddle _tools_/local-build/run --ts -- node --test --test-name-pattern='an html document is previewed' _verifiers_/88-file-preview/check.mjs
```

## Read next

[`checks.md`](checks.md) for the surface and the renderers; [`rendering.md`](rendering.md) for rendering fidelity; [`readings.md`](readings.md) for the measured verdicts; [`../INDEX.md`](../INDEX.md) for the verifications.
