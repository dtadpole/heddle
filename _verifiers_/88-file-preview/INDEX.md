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

## Read next

[`checks.md`](checks.md) for the surface and the renderers; [`rendering.md`](rendering.md) for rendering fidelity; [`readings.md`](readings.md) for the measured verdicts; [`../INDEX.md`](../INDEX.md) for the verifications.
