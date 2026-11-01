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

## Footnote author literal HTTP regression

[`check-footnote-literals.mjs`](check-footnote-literals.mjs) needs **no browser**. Authored against source
`d7101503c26daa28df7f3402a8667abd19e06be0`, it complements the functional footnote check above with two
small synthetic Markdown cases, with and without an actual note. Harmless literal NULs, the former
marker's proper prefix, bare and numeric lookalikes, and an escaped colon remain author prose; in the
note case each is immediately adjacent to an actual citation. The escaped-colon lookalike is created
by ordinary parsing, not recognized by a text postpass. It requires exact author paragraphs, ordinary
prose emphasis, current plain `<sup>1</sup>` citations, one shared rendered note and one plain ↩ per
citation. After excluding exact author paragraphs, no generated marker may leak; these anchor-free
fixtures must acquire no IDs, hrefs or anchors.

This is primarily a TypeScript literal-retention regression, not full footnote grammar, parser-budget
or security coverage. The default TypeScript CLI must retain U+0000 exactly. For an alternate CLI
selected with `HEDDLE_BIN`, an unrelated harmless-NUL control must first establish either literal NUL
retention or U+FFFD normalization, and every marker paragraph must follow that same behavior. The
check emits that dialect distinction as a diagnostic; a Rust/Comrak normalization result is **not**
a claim of exact TypeScript byte parity. It introduces no product NUL policy and changes no Rust code.

The check drives the actual built CLI `POST /api/markdown` with authenticated JSON text, honors
`HEDDLE_BIN`, and uses a private home and registered scratch workspace. The file reader intentionally
refuses NUL-bearing files as nontext (415); this check does not relax file admission. Port-zero token
authentication remains in place. Startup, body bytes/time and child
cleanup are bounded; only exact resolved self-allocated `mkdtemp` directories are removed after the
child stops. It neither builds nor reads private/live inputs, contacts a model endpoint or needs a
browser. Actual built-server checks passed **2/2 on TypeScript and 2/2 on Rust**, with no skips.
TypeScript retained U+0000; Rust's unrelated control established U+FFFD normalization, which remained
consistent across all marker paragraphs. Both retained the intentional file-reader 415 refusal for
NUL-bearing files. These endpoint results complement the actual pre-fix TS renderer regressions;
they do not claim exact NUL byte parity or a full parser/security verdict.

```bash
node --test _verifiers_/88-file-preview/check-footnote-literals.mjs
HEDDLE_BIN=/path/to/heddle node --test _verifiers_/88-file-preview/check-footnote-literals.mjs
```

Run from the repository root after the caller builds the selected CLI.

## Unicode author anchor attribute HTTP regression

[`check-unicode-anchor-attributes.mjs`](check-unicode-anchor-attributes.mjs) needs **no browser**. Two
synthetic Markdown fixtures, with and without a footnote, place `é`, `文字` and `😀` in ASCII-named
raw author-anchor `id` and `title` values before `href`. Through the actual built CLI `/api/file`,
the check requires rendered heading and ordinary prose emphasis, preserved author IDs, titles and
safe fragment hrefs, readable unsafe labels with `java&#x09;script:` hrefs refused, and rendered
notes when present. It rejects a source proxy and whole-document `unrendered` fallback.

This pins the Rust helper's UTF-8 byte-scan regression. The preexisting helper panic was caught and
returned fallback markup, **not** a server abort. It does not claim all sanitizer grammar or Unicode
attribute-name coverage. The check honors `HEDDLE_BIN`, uses a private home and registered scratch
workspace with port-zero token authentication, bounds startup, HTTP body size/time and child cleanup,
and removes only its exact resolved fixture allocations after the child stops. No private payloads,
model endpoint or browser are needed; the caller builds the selected CLI first.

```bash
node --test _verifiers_/88-file-preview/check-unicode-anchor-attributes.mjs
HEDDLE_BIN=/path/to/heddle node --test _verifiers_/88-file-preview/check-unicode-anchor-attributes.mjs
```

Run from the repository root. Both commands judge the selected delivered server, not imported
renderer modules. No before/after endpoint verdict is claimed by authoring this check.

## Unicode attribute name HTTP regression

[`check-unicode-attribute-names.mjs`](check-unicode-attribute-names.mjs) needs **no browser**. Two
synthetic, note-free Markdown fixtures put unknown `é`, `文字`, `😀`, `unknowné`, `unknown文字`
and `unknown😀` attribute names on an ordinary raw `<p>`. Through the actual built CLI `/api/file`,
one case requires the exact sanitized `<p>ok</p>`; the other requires only allowed `title="é 文字 😀"`
and `width="12"` to survive after the unknown names. Both require rendered heading, normal
`**prose**` before the paragraph and following `*words*`, not escaped source or whole-document
`unrendered` fallback. There are no anchors, URIs, scripts, footnotes or private payloads in either
fixture. The existing Unicode author-anchor **value** check above remains separate coverage.

Authored against source `c13e28dcdb4755d6a5b093f7f70289a38ac185da`. This is a narrow attribute-name
rendering regression, not an XSS, process-abort, full-parser or overall security claim; authoring
does not establish a before/after endpoint verdict. The check honors `HEDDLE_BIN`, uses a private
`HOME` and registered scratch workspace with port-zero token authentication, bounds startup,
HTTP body size/time and child cleanup, and removes only its exact resolved `mkdtemp` allocations
after the child stops. It neither builds nor contacts a model endpoint; the caller builds the
selected CLI first.

```bash
node --test _verifiers_/88-file-preview/check-unicode-attribute-names.mjs
HEDDLE_BIN=/path/to/heddle node --test _verifiers_/88-file-preview/check-unicode-attribute-names.mjs
```

Run from the repository root. Both commands judge the selected delivered server, not imported
renderer modules. No browser, fonts, image libraries or extra footnote branch are needed.

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
