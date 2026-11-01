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

## Text-read failure policy — issue #45

Both builds classify an OS permission-denied text read as HTTP `403` with
`{"error":"cannot read file: permission denied","code":"workspace-file/unreadable"}`.
Unexpected filesystem I/O is HTTP `500` with
`{"error":"cannot read file: I/O error","code":"workspace-file/read-failed"}`.
Neither answer exposes a host path or raw OS error. Missing paths and directories retain `404`;
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

## Read next

[`checks.md`](checks.md) for the surface and the renderers; [`rendering.md`](rendering.md) for rendering fidelity; [`readings.md`](readings.md) for the measured verdicts; [`../INDEX.md`](../INDEX.md) for the verifications.
