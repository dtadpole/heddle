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

## Text-read failure policy — issue #45

Both builds classify an OS permission-denied text read as HTTP `400` with
`{"error":"cannot read \"denied.txt\": permission denied","code":"workspace-file/unreadable"}`
for a file named `denied.txt`. This is the owner's unreadable policy shared with the folder/picker
refusal in issue #106; only the basename is shown.
Unexpected filesystem I/O is HTTP `500` with
`{"error":"cannot read file: I/O error","code":"workspace-file/read-failed"}`.
Neither answer exposes a parent directory or raw OS error. Missing paths and directories retain `404`;
binary and invalid UTF-8 retain `415`. Authentication and canonical workspace ownership still
precede reading. PNG metadata and raw-byte routes are not changed by this text-read policy.

This is **scoped Heddle policy, not DSH HTTP status parity**. The inspected installed
`@deepseek-ai/dsh-fs-local` and `@deepseek-ai/dsh-api-workspace-files` versions are `0.2.1-rc.2`.
The former's `statRegularFile` (`lib/index.js` 349–359) names missing/nonregular files but
rethrows permission/I/O failures; `streamWholeText` (452–471) rethrows stream failures.
The latter's `cutPage` (618–634) maps only `FS_NOT_TEXT` to `workspace-file/not-text` and
rethrows other errors. It supplies no permission-specific HTTP status contract to copy.

The focused [TypeScript regression](../../test/file-preview-errors.test.ts) needs **no browser
or build**. It changes only its own fixture file to mode `000`, verifies actual OS denial,
and restores the mode in `finally` before deleting its scoped scratch directory. If the host
can still read that mode, it reports the permission case skipped/unjudged, not passing.
It also checks a real symlink-loop I/O failure, HTTP status/body, auth, outside symlink,
nonfile, binary, invalid UTF-8 and readable controls. Rust's workspace reader has the same
own-file permission fixture with a drop guard; the web-files route tests pin named error
status/body. A privileged Rust host fails the fixture prerequisite explicitly rather than
silently claiming denial coverage. These tests do not judge rendered browser error text.

```bash
_tools_/local-build/run --ts -- node --test test/file-preview-errors.test.ts test/tree.test.ts test/read-file-errors.test.ts
```

### Delivered-CLI HTTP regression

[`check-read-failures.mjs`](check-read-failures.mjs) needs **no browser** and never builds the product.
It starts the selected actual CLI on loopback port zero with its own private home, offline scripted
configuration and named workspace. Its unique scratch directory is under the initialized, realpathed
shared test root. Only its own nested `denied.txt` changes to mode `000`; the mode is restored before
cleanup. A host (including root) that can still read it skips the permission subtest as **unjudged**,
not passing; the other HTTP controls still run. The shared runner returns `3` for that skip.

The check asserts exact `400 workspace-file/unreadable` JSON with basename-only permission text,
JSON/no-store headers and no parent paths or raw Node errors; it also pins missing/nonregular `404`,
binary/invalid UTF-8 `415`, unauthenticated `401`, outside/canonical-symlink `400`, restored-file and
readable-control `200`. A real self-symlink gives `500 workspace-file/read-failed` with only the generic
I/O sentence. That loop case follows inspected canonical-path fallback, ownership and actual host-reader
wiring in **both** servers, not merely an in-process reader test. Startup, headers/body consumption,
response size, overall test and owned-process shutdown are bounded. No rendered File-panel error body
or path header is judged by this HTTP-only check.

The parent/caller must pin and build each selected product first; this verifier uses those artifacts
unchanged and does not run build, cargo, a browser or an existing daemon. From the repository root:

```bash
node --check _verifiers_/88-file-preview/check-read-failures.mjs
node _tools_/verify-runner/run.mjs _verifiers_/88-file-preview/check-read-failures.mjs --json
HEDDLE_BIN=/path/to/pinned/heddle node _tools_/verify-runner/run.mjs _verifiers_/88-file-preview/check-read-failures.mjs --json
```

The folder's existing `check*.mjs` entry-point discovery includes this check automatically.
This entry describes authored coverage, not execution evidence; a parent-run result is required.

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

## Fixed HTML shell #50

Owner design 808e serves a constant empty `GET /api/html/frame` behind the existing auth door. Its
response CSP is `PREVIEW_CSP` plus `frame-ancestors 'self'` and `sandbox allow-same-origin`; the
response also has `nosniff`, `no-store` and `no-referrer`. The parent still fetches document JSON and
uses the same DOMPurify configuration. Only clean output is parsed and imported into a fresh current
frame after the fixed same-origin HTML shell loads; cancellation and late failures cannot publish
into a newer selection. No server sanitizer, path-reading shell, POST store or asset bridge is added.

Authored regressions are in [`preview-shell.test.ts`](../../test/preview-shell.test.ts),
[`page-file-selection.test.ts`](../../test/page-file-selection.test.ts), and the Rust server/preview
unit tests. Existing browser checks now inspect the loaded frame DOM and response headers rather
than source-document markup. At the initial source checkpoint `bd80bf04`, D067 allowed only static
diff and Node syntax checks because disk was below 16 GiB; runtime verdicts were UNJUDGED.

After the parent explicitly reauthorized TypeScript validation and fresh preflights met memory free
at least 25 percent and disk at least 16 GiB, focused regressions passed **37 of 37** and the corrected
type check passed. The initial type check exposed a setter-only test control inferred as undefined;
`f060f427` adds its boolean getter. The parent then formatted Rust sources in `751df88d` and reported
**21 Rust preview tests and clippy passing**. The child ran no Cargo, build or browser commands.

The first full TypeScript suite at `751df88d` honestly **failed** with **1439 tests, 1436 passed,
2 failed and 1 skipped**. The unchanged jobs timing test's first read already contained both `one`
and `two` instead of only `one`; its 150 ms observation is not a synchronization barrier. The
highlight parity test could not read its cwd-relative local dependency directory, absent in the new
worktree even though ancestor module imports resolved. The parent subsequently linked existing
dependencies for its build; this fixes that environment premise but does not retroactively pass the
suite or waive the jobs failure. At that shell checkpoint build/browser results and the actual-resource
premise were pending; no blind full-suite retry or unrelated jobs test change is claimed here.

## Main DOM and fixed-shell resource policies

Owner2b2f approved the separate #50 policy change on top of the fixed-shell candidate `b375c6ab`.
Markdown images render in the main DOM, so the main page retains `img-src 'self' data: blob: https:`.
In both builds only main-page `style-src`, `font-src` and `media-src` lose `https:`; their exact values
are `style-src 'self' 'unsafe-inline'`, `font-src 'self' data:` and `media-src 'self'`. Script hashes,
Browser-dependent frames, object, base, ancestor and form directives are unchanged. The HTML shell
has its own response policy; `PREVIEW_CSP` and `PREVIEW_FRAME_CSP` retain all existing resource
permissions and restrictions. No ephemeral store, server sanitizer or referrer meta is introduced.
The owner's CSS-origin Referer observation is a non-regression and does not require a policy workaround.

This patch depends on the fixed authenticated shell; it is not a standalone `srcdoc` change. Exact
TypeScript and Rust assertions cover both Browser booleans and the unchanged child policies, and
part 80's exact expected main-page policy is updated for the same three directives with HTTPS images
kept. The old main-page policy fails the new focused TypeScript assertion specifically on the three
remaining HTTPS permissions (exit 1); after the change the five focused TypeScript policy assertions
pass (exit 0), and `npm run check` passes (exit 0), both using `_tools_/local-build/run --ts` after
fresh D067 clearance. The part 80 check passes Node syntax checking; its browser runtime verdict is
not inferred. Rust, build and browser validation remain the parent's responsibility;
the earlier full-suite jobs failure remains known, not waived. The named pre-push public gate is
`node _tools_/public-hygiene/gate.mjs --range b375c6ab..HEAD` on the normal separate branch. Source
owner review must approve the exact candidate SHA before MAIN; this patch does not land on main or
update any live server/settings.

## Actual resource-policy regression

[`check-preview-resource-policy.mjs`](check-preview-resource-policy.mjs) drives the delivered CLI selected
by `HEDDLE_BIN`, not a source-import double. It pins authenticated fixed-shell headers and the complete main
CSP, then uses a controlled alternate HTTPS origin with test-only certificate trust bypass. In both built
backends, two cases passed and no cases failed: child CSS applied, child and CSS images decoded, valid WAV
loaded under the child policy, main CSS/media requests were blocked by its exact response CSP, and a remote
Markdown image still decoded in the main DOM. These results do not certify TLS trust or supported production
audio/video rendering. The valid-font decode subtest was explicitly UNJUDGED because no workspace font
fixture was provided; font-src is still pinned by headers, and the owner's separate request-count probe
covers its CSP boundary. The first Resource Timing ownership wait failed and was replaced by decoded-asset
and actual asset-server evidence, not by relaxing production policy. Full integration and live acceptance
remain pending; the earlier full-suite jobs timing failure is not waived.

## Read next

[`checks.md`](checks.md) for the surface and the renderers; [`rendering.md`](rendering.md) for rendering fidelity; [`readings.md`](readings.md) for the measured verdicts; [`../INDEX.md`](../INDEX.md) for the verifications.
