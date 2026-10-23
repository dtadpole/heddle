//! `heddle-llm` — the backend wire shapes, the HTTP client, streamed content and reasoning deltas, model info and usage.
//!
//! Ported from the TypeScript build: `src/llm/`, `src/stream/`, `src/plugins/model.ts`.
//! Judged through the `heddle` binary (`HEDDLE_BIN`) by `_verifiers_/10-llm-backends`, `_verifiers_/20-streaming`, `_verifiers_/98-model-endpoints`.
//! Nothing is ported yet; the public API lands here first so dependent crates can build against it.
