---
title: Session
version: 1.4.0
description: The session store and its service — an append-only event log per session, the surface a request is derived from, and the folder tree a session is found in.
grounded_in:
  - source: human-authored
---

# `session`

The session store and its service — an append-only event log per session.

Four things live here and they are deliberately together, because each is a property of the log. The
**log** is append-only: every event a run produces, in order, on disk before the thing
it describes happens. The **surface** is the positional view of that log which a model request is
derived from — only message-producing events take a position — a `message` a person or a
model produced, a `context/note` the harness wrote, or one node per streamed run — and a rewrite
(`surfaceOp: 'replace'`) shadows a span of positions instead of erasing it. A span is **positional**:
its seqs need not be in order, because a replacement carries a higher seq than what it shadows, and
`start` may be greater than `end`. That is what lets a compaction or a pruning change
what the model sees while `heddle transcript` still shows everything that happened. The **tree**
([`tree.ts`](tree.ts)) is what a store of sessions looks like as folders: it classifies each folder by
the conventions' own rules — a type folder, an instance of one, a plain container, a generated folder —
and answers one level at a time, with a session row only where the type-plus-instance pattern matches.
[`../../SESSION_TREE.md`](../../SESSION_TREE.md) states that model and the owner's decisions behind it. The
fourth is where a log is **filed**: [`layout.ts`](layout.ts) turns a working directory into the workspace
folder a session's log lives under — `~/.heddle/sessions/<workspace>/<session-id>.v2.jsonl.zstd`, the
owner's ruling of 2026-10-11 — and the store reads that layout and the one before it, writing only the new
one, because a session keeps the shape it was born with.

The log also carries the session's **inbox** ([`inbox.ts`](inbox.ts)): what a person steered into a running
turn that the turn has not taken yet. It is DSH's agent inbox, recorded with DSH's `agent/inbox/spliced` event.
A steer is queued in the next-step list, the loop writes it at its next step boundary (after any tool result
still due), a stop keeps it, and the next turn writes it before its own prompt (R-developer-two-5).

[`activity.ts`](activity.ts) names the **running work** a plain archive is refused for, in DSH's
`workspace/session-activity` shape: the session's own turn, and its running subagent descendants found by
lineage (parent plus subagent origin, any depth). The Web route's `409` carries it and the page's
stop-and-archive dialog lists it (R-developer-eight-13). DSH's jobs have no runtime here; its reminders landed on
main (`src/schedule/`) after this walk, and reporting them is a follow-up.

Everything built on top of it — the meter, the pruner, the compaction, `heddle context` — reads
`deriveMessages()` rather than filtering the log, and [`../context/INDEX.md`](../context/INDEX.md) is
where that happens.

Two things about how it is stored are worth knowing before reading the code.

**One zstd frame per event** ([`transcript.ts`](transcript.ts)). Appending to a compressed file is
only possible at a frame boundary, so an event *is* a frame: the bytes before an append are never
touched, and a crash that tears the last frame loses that frame alone. Node decodes one frame and
stops, so the reader walks the frames itself; that walk is the module's whole reason for existing.
Plain `session.jsonl` transcripts are still read and still appended to in plain text — a session
keeps the format it was born with.

A frame torn by an interruption is **cut back to the last whole frame when the session is opened**,
and the session records `transcript/repaired` with how many bytes went. This is not cosmetic: the
frame walk stops at the first incomplete frame, so appending past one writes events nothing can ever
read. Measured before the repair existed: a torn file plus one appended frame read back as one event
instead of two, with the new event silently gone.

**The file is read once per process** (`SessionStore.load`). Events are kept in memory and advanced
on append, because a single turn used to re-read and re-parse the whole transcript twenty-one times:
five `read` calls and sixteen `count` calls, and `count` read the file too. That made a turn's cost
grow with the square of the session's length, and it is also what made decompression affordable —
it now happens once per session per process. The trade is stated in the code rather than hidden: a
second process appending to the same session while this one holds it open would not be seen, and
heddle runs one process per session.

This is a source folder rather than a type folder: it carries code, not instances of a
registered content type. Its entry point exists so that a reader who opens it learns
what belongs here and what to read next, which is the same duty every `INDEX.md` in
this tree carries.

## Read next

[`../../README.md`](../../README.md) for how the layout fits together, and
[`../../_verifiers_/INDEX.md`](../../_verifiers_/INDEX.md) for the claims that decide
whether what lives here works.
