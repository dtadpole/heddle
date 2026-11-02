---
title: Partial file picks and empty ordinary uploads
version: 1.0.0
description: Issue 42 source policy and bounded regression evidence for the shared picker and both attachment backends.
grounded_in:
  - source: owner request for issue 42
  - source: installed DSH attachment admission and conversation upload implementation
---

# Issue 42 — partial file picks

## Source policy

The implementation starts at freshly fetched `origin/main` revision
`5ce8a70465c996f1e405afede5da0bc4b7359fda`. Historical patch
`d85fcceb42497c5d181d7928eaf39fc6cf28270a` was read only as the batch-loss
fix; historical test `8c5dc8b0ed7db9859f0f6bfba505efa215b40666` was also read,
not merged. That test's blanket rejection of an ordinary empty file is obsolete.
No answer-images branch or old framework was imported.

Installed DSH package sources were re-read before implementing the policy:

- `@deepseek-ai/dsh-attachment/lib/types/admission.js` lines 37–49 accepts an
  ordinary zero-byte file; lines 5–13 rejects an empty encoded image.
- `@deepseek-ai/dsh-attachment/lib/types/index.js` lines 102–104 describes
  verbatim file content of any length as accepted.
- `@deepseek-ai/dsh-client-ui-conversation/lib/client.js` lines 4751–4766 creates
  drafts per file, lines 4774–4778 retries only a failed file, and lines 4827–4845
  updates ready/error state for the individual attachment id.

Heddle keeps its local 50 MiB upload ceiling and path-backed store. Ordinary
zero-byte files now pass the TS and Rust upload routes and attachment admission.
Empty image uploads fail before storage when the supported raster extension or
an image content-type declares them images; stored empty raster paths fail at
attachment admission too. Nonempty corrupt image decoding is **not** implemented
by this change. This is not a full attachment parity claim.

The shared page keeps each admitted file immediately, continues after individual
HTTP or transport failures, and renders one note per refused file. Rust embeds
that same page. This does not copy DSH's retry control, receipt ids, per-session
upload ownership or full draft service. Send-time validation of an untrusted
attachment-path list remains atomic and refuses a bad list rather than silently
sending a partial message.

## Regressions and evidence

**Unit browser mode — none.** Execute actual shared-page functions in Node's VM,
actual TS HTTP upload route with scratch-only configuration, and Rust unit/router
functions. No live settings or sessions are written. A separate **headless**
`#42` picker check is authored in `check-composer.mjs` with a 60-second outer
bound and bounded page waits, for parent execution on both built backends. It
selects two ordinary files, an invalid empty PNG and an ordinary empty text file;
asserts three retained cards, one correctly attributed refusal, and only three
stored uploads including the verbatim zero-byte text file. Authored is not run.

Regression-only checkpoint `ebacc72607c76aaa2122b5ec4366477c0ceacb82` preserves
unfixed production sources. The TS baseline on that checkpoint was **13 tests,
8 passed and 5 failed**, proving early loop termination, withheld successful
cards, incorrect failure attribution, empty-raster admission and ordinary-empty
HTTP rejection. The same targeted tests after implementation were **13 passed,
0 failed**. The first full TS suite exposed one obsolete removal-detector regex
that hardcoded a batch append; it was updated to the required immediate per-file
append, with the actual-function regressions retained. The final full TS suite
was **1,295 tests, 1,294 passed, 0 failed and 1 skipped** (the opt-in installed
DSH schedule comparison). `npm run check` and the authored browser verifier's
`node --check` both exited `0`. Final full-suite preflight measured 41 percent
free memory and 19,193,104 KiB available disk.

Both runs used the existing `_tools_/local-build/run --ts` slot runner. Explicit
preflight checked memory free percentage at least 25 and available disk at least
16,777,216 KiB. Baseline measured 45 percent and 19,355,596 KiB; the fixed run
measured 38 percent and 19,155,160 KiB.

```sh
_tools_/local-build/run --ts -- node --test \
  test/page-picked-files.test.ts test/server-attachments.test.ts \
  test/upload-admission-http.test.ts
_tools_/local-build/run --ts -- npm run check
```

Matching Rust regressions are authored in `heddle-web-files`, including image
content-type refusal on an ordinary filename. **Rust execution is delegated to
the parent, not claimed here.** The tests to compare on the regression-only
checkpoint and implementation revision are:

```sh
cargo test -p heddle-web-files ordinary_empty_files_are_admitted_but_empty_rasters_are_refused
cargo test -p heddle-web-files ordinary_empty_uploads_are_stored_and_admitted
cargo test -p heddle-web-files an_empty_raster_upload_is_refused_without_storing
```

No build or browser verifier was executed in this worktree. End-to-end browser
selection, model projection, Rust compilation and the full Rust suite remain
separate parent checks; authored tests are not passing evidence until executed.
