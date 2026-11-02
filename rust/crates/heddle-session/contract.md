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
- **Writer lock** (#202, `src/writer_lock.rs`, `src/session/writer-lock.ts`). `<id>.lock` beside the log
  (`session.lock` in an old-layout directory), created with `O_EXCL`, one line:
  `<pid> boot=<boot id> start=<start>\n`, e.g. `46183 boot=A16D6C9D-EDEC-4146-9050-6215AF208215 start=1793563380\n`.
  `boot` is `/proc/sys/kernel/random/boot_id` (Linux) or `kern.bootsessionuuid` (macOS); `start` is field 22
  of `/proc/<pid>/stat` (Linux, clock ticks after boot) or the `ps -o lstart` second under `LC_ALL=C TZ=UTC0`
  as seconds since 1970 (macOS). A writer that cannot read its own start writes the pid-only form, and one
  that cannot read the boot leaves `boot` out; a reader ignores parts it does not know. A lock with identity gets the modification time 2037-12-31T00:00:00Z, which a build from before
  #202 reads as a lock still being written, so it refuses rather than removing it. A pid-only line,
  `<pid>\n`, is what every build before #202 wrote. A lock is **stale**, and taken over, when its pid names
  no process, when its boot is not this boot, when its pid's process started at another time than it
  records, when (pid-only) its pid's process started more than 5 s after the file's modification time, or
  when its pid's process runs as another user than the file's owner (pid 1, `EPERM`); a fact that cannot be
  read never makes it stale. A live holder's refusal is word for word in both builds:
  `session "<id>" is already owned by an active write handle (process <pid>, <name>). Its lock file is
  <id>.lock, beside the session's log; if process <pid> is not heddle, delete that file and try again.`
  `test/session-lock.fixtures.json` holds the lines both suites read. One machine and one pid namespace,
  as before: a pid names a process on the machine that wrote it. A process lets go of every lock it holds
  when it ends, removing each file only while it still names this process by pid and identity (#248): the
  TypeScript build in its `exit` handler, the Rust build in the `heddle` binary's shell after a run returns
  (a server stopped by SIGTERM or SIGINT, a command line done or failed) or a panic unwinds out of it
  (`store::release_held_writer_locks`). Before it removes a file the Rust release ends every write in the
  process: under the lock each log write and lock take holds while it runs, it sets the exiting state, so a
  write in progress finishes first and every later append, record, seed, truncation, lock take or create is
  refused with `SessionError::Exiting` (`the session could not be saved: the process is exiting`,
  `session/exiting`) and writes nothing. A turn that outlives the server's close therefore never writes a log
  whose lock another process may already hold. The TypeScript build needs no such state: its `exit` handler
  runs on the one thread, after which nothing else runs.

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
