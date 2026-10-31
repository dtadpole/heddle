---
title: Sandbox
version: 1.2.1
description: The permission sandbox — the per-call policy, the in-process file fence, and the platform backends that confine a shell.
grounded_in:
  - source: human-authored
  - source: the DSH sandbox packages read on 2026-10-17, recorded in _context_/dsh-mechanisms/dsh-sandbox-backends.md
---

# `sandbox`

The permission sandbox, which decides where a file effect may land — for the harness's own file tools and, as
of the backend cycle, for a shell's whole process tree.

This is a source folder rather than a type folder: it carries code, not instances of a
registered content type. Its entry point exists so that a reader who opens it learns
what belongs here and what to read next, which is the same duty every `INDEX.md` in
this tree carries.

## What belongs in it

| File | What it is |
|---|---|
| [`service.ts`](service.ts) | `SandboxService` — the per-call policy, the `confine()` seam, the file fence, and the `read-only`/`workspace-write`/`danger-full-access` vocabulary |
| [`policy.ts`](policy.ts) | the mode vocabulary and the one `writableRoots(policy)` the fence and every kernel profile share |
| [`backend.ts`](backend.ts) | the backend contract, platform selection, the fail-closed `SandboxUnavailableError`, and the runner-failure-before-denial classifier |
| [`seatbelt.ts`](seatbelt.ts) | the macOS Seatbelt rung — DSH's SBPL profile, a functional probe, and the denial dialect |
| [`linux.ts`](linux.ts) | the Linux rungs — bubblewrap's profile, Landlock's grants and launcher probe, and DSH's chain order |
| [`process-group.ts`](process-group.ts) | `killProcessGroup` — a Stop, a timeout or a job kill (`SIGTERM` first, by the jobs row) reaches every process a command started, as DSH signals a detached child's group (twin of `heddle_sandbox::kill_process_group` and `signal_process_group`), and `trackGroup` / `untrackGroup`, the process-exit backstop every launcher of a detached group registers with (issue #6) |
| [`escalation.ts`](escalation.ts) | the one-call wider-retry ladder and the approval ask, checked at execution rather than in a schema |
| [`paths.ts`](paths.ts) | `canonical` and `contains`, one home for the comparison the fence and the profiles both make |

## What it is not

- **Not a container.** Same-world confinement only; the shell shares the host kernel and filesystem, and network
  and process visibility are outside the vocabulary.
- **Not every platform yet.** macOS Seatbelt is shipped and judged here; the Linux chain is the next cycle of the
  loop document; the Windows ACL rung is a separate external runner in DSH and fails closed here by design.
- **Not a claim about reads.** `danger-full-access` and the shell's own reads are unconfined by the kernel; the
  file fence confines reads only because heddle's `read_file`/`list_dir` call it, which is stricter than DSH.

## Read next

[`../../README.md`](../../README.md) for how the layout fits together,
[`../../_context_/dsh-mechanisms/dsh-sandbox-backends.md`](../../_context_/dsh-mechanisms/dsh-sandbox-backends.md)
for the reference and the loop record, and [`../../_verifiers_/INDEX.md`](../../_verifiers_/INDEX.md) for the
claims that decide whether what lives here works.
