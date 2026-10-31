---
title: The heddle-jobs sources
created: 2026-10-31T01:30:00Z
modified: 2026-10-31T06:52:53Z
version: 0.2.0
description: The sources of the heddle-jobs crate, with unit tests beside the code.
grounded_in:
  - source: src/jobs/INDEX.md
---

# `rust/crates/heddle-jobs/src`

The sources of the crate, with unit tests in `#[cfg(test)]` modules beside the code.

| File | What it is |
|---|---|
| [`lib.rs`](lib.rs) | the crate root, its documentation and the re-exports |
| [`js.rs`](js.rs) | the JavaScript number semantics the refusal sentences and the follow offset lean on |
| [`ring.rs`](ring.rs) | `OutputRing`: chunks at absolute UTF-8 byte offsets, whole head chunks dropped past the cap, an oversized chunk cut to a UTF-8-safe tail marked `gapBefore`, non-consuming reads that answer `lossy` below `earliest` |
| [`registry.rs`](registry.rs) | `JobRegistry`: the five statuses, `<kind>-<16 hex>` ids re-rolled on collision, preflight in DSH's order, the per-owner cap, the pump, the one consuming `read` and the non-consuming `read_at`, kill, wait, remove, first-wins settle with the kill reason merged, ownership, the `job/registered` and `job/settled` session-log events, the event stream, teardown |
| [`tools.rs`](tools.rs) | `job_output`, `job_list`, `job_kill`: DSH's descriptions, schemas and renderings |
| [`spill.rs`](spill.rs) | `StreamSpill` and `ProcessSpills`: a stream's complete output in a private spill file once it outgrows a 64 000-byte tail (64 MiB cap), reported to the job as pull sources with no text, so the dropped-output notice names the file (`src/jobs/spill.ts`) |
| [`bash.rs`](bash.rs) | background `bash`: the producer (confined by `launch_shell`, its own process group, SIGTERM then SIGKILL after 3000 ms through `heddle_sandbox::signal_process_group`, DSH's outcome mapping and sandbox notes), the running tool call read from the log, the runner attached to the tools row's `bash`, and `run_foreground`: a foreground call run as a job and promoted when it outlives its wall time (`render_promoted`) |
| [`prompt.rs`](prompt.rs) | DSH's `tool:jobs` prompt section at the end of the system prompt of a request that offers `job_output`, through the model service's `model/request` hook (`withJobsSection`) |
| [`notice.rs`](notice.rs) | the completion notice's text and source, and `NoticeDelivery`: who is told, wake or inject, per-session serialization, `quiet` delivery and the wake budget |
| [`http.rs`](http.rs) | the page's routes under `/api/jobs`: list, follow (non-consuming), kill (`cancelled by the user`) |
| [`compose.rs`](compose.rs) | the `jobs` row over `heddle-session`, `heddle-agent` and `heddle-tools`, for the binary, and its teardown |

## Read next

[`../INDEX.md`](../INDEX.md) for what the crate ports and where it differs.
