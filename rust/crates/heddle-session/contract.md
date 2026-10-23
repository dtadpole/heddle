---
title: The heddle-session byte contract
created: 2026-10-23T00:55:27Z
modified: 2026-10-23T08:24:41Z
level: L1
version: 1.0.0
description: What a log written by either build must look like for the other to read it, and the decisions a dependent crate should know.
status: unverified
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/session/, the TypeScript sources it ports
  - source: _verifiers_/70-workspaces-sessions/check.mjs, the checks that judge it
---

# The contract: a log either build wrote, the other reads


- **Layout.** New: `<root>/<workspace-key>/<id>.v2.jsonl.zstd` and `<id>.json`. Old, read and appended to
  but never created: `<root>/<id>/{session.v2.jsonl.zstd | session.jsonl, meta.json}`.
- **Transcript.** One zstd frame per event with a content checksum; a torn tail is cut back to the last
  whole frame on open and recorded as `transcript/repaired { droppedBytes }`. Plain JSONL stays plain.
- **Event bytes.** `{"seq":…,"at":…,"type":…,…}` as `JSON.stringify` writes it; `at` is `toISOString`
  (`2026-10-22T18:17:41.123Z`). JSON objects keep insertion order (`serde_json/preserve_order`).
- **Meta and definition bytes.** `JSON.stringify(v, null, 2)` + `\n`; an edit keeps every untouched key
  where it was and appends a new one, as the TypeScript spread does.
- **Directory order.** Entries are visited in byte order, which is what Node's `readdirSync` returns.

## Decisions a dependent crate should know


1. **No dependency on `heddle-events`.** The store takes an `EventListener` closure; the boot passes one
   that emits `session/event { session, event }`. A transient `tool-call-delta` reaches the listener and
   never the log.
2. **No dependency on `heddle-sandbox`.** The mode fold is generic and reads and writes the event's `mode`
   through serde, so `SandboxMode` (kebab-case `Serialize + Deserialize`) is used as it is.
3. **Message types are `heddle-llm`'s.** `message.rs` re-exports `Message`, `ContentPart`, `Chunk`, `Role`, `ImagePart`, `FilePart`, `ImageMediaType`, `TokenUsage` and `ToolCall`, so the log and the wire share one declaration and a dependent crate converts nothing. `RecordedMessage` is `Message` (the `source` field is inline, as `src/llm/types.ts` has it). The shape the log still depends on:
   tagged by `"type"` first, kebab-case variants, camelCase fields, `Message` ordered `role`, `toolCallId?`,
   `content`, then `source` when the harness wrote it, absent options omitted.
4. **`read` returns a snapshot, not a borrow** — appending while holding one is fine.
5. **Fallible reads.** A transcript line that does not parse fails the load (`SessionError::InvalidLine`),
   so `read`, `count`, `surface` and `append` return `Result`.
