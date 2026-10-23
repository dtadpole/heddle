---
title: The heddle-sandbox crate
version: 0.2.0
description: The Rust port crate for the permission modes, their enforcement backends, escalation and approvals — its public API and its port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/sandbox/*.ts and src/approvals/service.ts, read 2026-10-22
  - source: _verifiers_/75-permission-sandbox and _verifiers_/80-web-ui/check-approval.mjs, read 2026-10-22
---

# `rust/crates/heddle-sandbox`

The Rust port of the permission modes, their enforcement backends, escalation and approvals.

| | |
|---|---|
| Ported from | `src/sandbox/` (policy, paths, backend, seatbelt, linux, escalation, service), `src/approvals/service.ts` |
| Judged by | `_verifiers_/75-permission-sandbox`, `_verifiers_/80-web-ui` (check-approval), through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |
| Depends on | no heddle crate; `serde`, `serde_json`, `thiserror`, `tokio` from the workspace |

## The public API

Landed first, so dependent crates build against it, and implemented behind it; `cargo doc -p
heddle-sandbox` renders it. Everything below is re-exported at the crate root.

| Item | Who calls it | TypeScript |
|---|---|---|
| `SandboxMode` (`ReadOnly < WorkspaceWrite < DangerFullAccess`, serde kebab-case, `parse`, `rank`) | everyone; the session log's `permission/mode` event | `SandboxMode`, `isSandboxMode`, `sandboxModeRank` |
| `SandboxExecutionPolicy`, `writable_roots`, `host_temp_dir` | the fence, the kernel profiles | `writableRoots` |
| `policy_statement(&policy)` | the agent loop's `sandbox:policy` runtime-context section | `sandboxPolicyStatement` |
| `canonical`, `contains`, `paths::resolve` | the fence, the profiles | `paths.ts` |
| `SandboxConfig` / `ApprovalsConfig` (serde, camelCase, unknown keys ignored) | boot, from the `sandbox` and `approvals` profile rows | the two `Config` schemas |
| `SandboxHost { cwd, harness_home, platform }` | boot (the harness home comes from the config crate) | `process.cwd()`, `heddleHome()` |
| `SandboxService::{new, with_backend, mode, workspace_root, policy, backend_name, escalation_targets, resolve_path, confine, assert_writable, assert_readable, writable}` | the tool registry and built-in tools; the server (`mode`, `workspace_root`) | `SandboxService` |
| `SandboxDenial` (code `SANDBOX`), `SandboxUnavailableError` (code `SANDBOX_UNAVAILABLE`) | the tools, reported as tool results | the two error classes |
| `classify_outcome`, `SandboxOutcome`, `shell_denial_message`, `runner_failure_message` | the `bash` tool | `classifyOutcome`, the bash tool's sentences |
| `SandboxBackend` trait, `ConfinedArgv`, `select_backend`, `seatbelt::*`, `linux::*` | the service; tests inject doubles | `backend.ts`, `seatbelt.ts`, `linux.ts` |
| `validate_escalation_args`, `approve_escalation`, `EscalationRequest`, `EscalationRefusal` (code `ESCALATION_REFUSED`), `EscalationApproval`, `ESCALATION_TARGETS`, `wider_modes` | the tool registry's one gate | `escalation.ts` |
| `permission_transition`, `FULL_ACCESS_CONFIRMATION`, `ModeChange`, `TransitionRefusal` | `POST /api/sessions/<id>/permission` | `permissionTransition` |
| `ApprovalService::{new, check, attach_answerer, can_answer, pending_requests, subscribe, request, answer, history}`, `ApprovalRequest` (JSON `{id, tool, reason, displayReason, session?, at}`), `Answer`, `ApprovalOutcome`, `is_approval_id` | the registry (`check`, `request`); the server (`attach_answerer`, `subscribe` for the SSE `approval` event, `GET /api/approvals`, `POST /api/approvals/<id>`) | `ApprovalService` |

**Three Rust shapes differ from the TypeScript on purpose.** Every check takes the call's mode explicitly (no
"default to the deployment mode" parameter; pass `service.mode()`); an approval's cancellation is any
`Future<Output = ()>` (a Stop's cancellation token, or `std::future::pending()`), not an `AbortSignal`; and a
published question is a `tokio::sync::broadcast` receiver from `subscribe()`, not a Cordis event — boot may bridge
it onto the event bus as `approval/request`. `contains` compares by path component, so an entry named `..cache`
is inside its root (the TypeScript prefix test refuses it).

## What the other crates must do with it

The verifiers judge the binary, so the checks pass only when these land beside this crate:

| Crate (seat) | Obligation |
|---|---|
| `heddle-tools` (developer-five) | per call: `approvals.check(name)` → `DENIED`; escalation args → `validate_escalation_args` (`BAD_ARGS`) and `approve_escalation` with the call's Stop as `cancel` (`ESCALATION_REFUSED`); the mode is never read from `args`. `write_file` / `read_file` / `list_dir` go through `assert_writable` / `assert_readable` (`SANDBOX`); `bash` spawns `confine(["/bin/sh","-c",cmd], mode)` in `workspace_root()` and reports `classify_outcome` with the two message helpers; advertise `sandbox_permissions` / `justification` only when `escalation_targets()` is non-empty |
| `heddle-agent` (developer-five) | the runtime-context snapshot's `sandbox:policy` section is `policy_statement(&sandbox.policy(effective_mode))` |
| `heddle-session` (developer-eight) | the `permission/mode` event and the effective-mode fold use `SandboxMode` |
| `heddle-server` (developer-ten) | hold an `AnswererGuard` while serving; forward `subscribe()` as SSE `event: approval`; `GET /api/approvals` → `{requests: pending_requests()}`; `POST /api/approvals/<id>`: `is_approval_id` else 400, `Answer::parse` else 400, `answer` false → 409; the permission route runs `permission_transition(effective, body.mode, body.confirm)` and refuses with 409 |
| `heddle` boot (developer-two) | build both services from the profile rows (`sandbox`, `approvals`) and share them as `Arc` |

## Port plan

Test-driven, one task per row, each landing with its unit tests (`cargo test --manifest-path rust/Cargo.toml -p
heddle-sandbox`); each task is a commit on `hd/developer-seven`.

| # | Task | Files | The claims its tests can fail |
|---|---|---|---|
| 1 | modes and paths | `mode.rs`, `paths.rs` | the ladder order and exact-word parse; `host_temp_dir_from` follows TMPDIR→TMP→TEMP→`/tmp`, trailing slash stripped; `writable_roots` empty outside workspace-write, canonical, de-duplicated; `policy_statement` byte-for-byte for all three modes; `resolve` normalises `..`; `canonical` resolves a symlink out of the workspace, keeps a missing tail under a resolved ancestor; `contains` refuses the `ws-extra` sibling |
| 2 | the owner's transition and the escalation vocabulary | `transition.rs`, `escalation.rs` (validation, refusal sentences) | unknown word refused with the JavaScript `String()` of the value; no-op is `changed: false`; narrowing free; full access only with `"full-access"`; the three pairing errors in order |
| 3 | backends and classification | `backend.rs`, `seatbelt.rs`, `linux.rs` | runner failure outranks denial; a denial needs a non-zero exit; Landlock's rule only at exit 125; golden argv for the SBPL, bwrap and Landlock profiles (including the SBPL escape and the tmpfs skip); probes against stand-in runner scripts (exit 0, exit 1, hang past the timeout, `partially enforced`), cached; the Linux chain order with injected probes; the unavailable sentence |
| 4 | the service | `service.rs` | the three modes against an inside write, an outside write, an outside read; the prefix sibling, the temp area, a symlink out, the harness home readable; the three refusal sentences verbatim; `confine` bypasses only in full access and fails closed with no backend or a failed probe; `escalation_targets` empty without a usable backend |
| 5 | approvals | `approvals.rs` | the `check` table, including deny-by-name over allow-mode; the counted guard survives an overlapping reload; `request` with no answerer answers from `unanswered` and publishes nothing; publish → `pending_requests` → `answer` settles once and a second `answer` is false; an already-resolved cancel, a cancel while waiting, and the timeout each give `cancelled` and empty the pending list; an accepted answer wins a race with a cancel; ids match `is_approval_id`; the request's JSON field names |
| 6 | the ladder | `escalation.rs` (`approve_escalation`) | the same mode needs no ask; not-wider and malformed refusals; the ask's reason and display reason carry the justification verbatim; each outcome maps to its refusal sentence; it runs with `ApprovalService` as the channel |
| 7 | judged through the binary | none here | once tools, server, session and boot compose it: `75-permission-sandbox` and `80-web-ui` check-approval through `HEDDLE_BIN`, recorded with the command and date |

**Landed so far:** tasks 1 to 6 are implemented, with their unit tests (103 tests at 2026-10-22, `cargo test -p
heddle-sandbox`), including the task 6 ladder through `ApprovalService` as its channel. Task 7 is the judged-through-
the-binary row, which needs the tools, server, session and boot crates. The real Seatbelt profile was checked on
macOS: the read-only profile accepts `/usr/bin/true`, a write under it is denied with `Operation not permitted`, and
the canonical `/private/tmp` subpath admits the same write.

## Risks, stated now

- **On Linux the verifier cannot pass as written.** `check-shell-confinement.mjs` skips its three kernel checks
  off macOS, and the shared runner (`_tools_/verify-runner/run.mjs`) reports any skip as unjudged (exit 3). The
  Linux rungs are ported here, but the build host has no `bwrap` (measured 2026-10-22: not on `PATH`, unprivileged
  user namespaces work) and no Landlock (absent from `/sys/kernel/security/lsm`). Passing needs a Linux branch in
  that check (the bwrap dialect is `read-only file system`) and `bwrap` on the host — the backend verifiers'
  integrator and the host's owner decide, not this crate.
- The verifiers' profiles name TypeScript module paths (`src/sandbox/service.ts`) for each row; mapping a row to
  this crate is the configuration and boot crates' job.
- Adding the four dependencies changes `rust/Cargo.lock`, which this seat does not commit; it regenerates on merge.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
