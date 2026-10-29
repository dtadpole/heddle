---
title: The heddle-sandbox crate
created: 2026-10-23T00:55:27Z
modified: 2026-10-29T13:14:16Z
version: 0.7.2
description: The Rust port crate for the permission modes, their enforcement backends, escalation and approvals — its public API, the recorded approval fixture and its port plan.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md at 5c113e8
  - source: src/sandbox/*.ts at 8047667 and src/approvals/service.ts at 4d4075f (each one's last change), read 2026-10-22
  - source: rust/crates/heddle-sandbox/src/service.rs at 58baa89d (root_for and rooted_at, developer-eight, D-055), read 2026-10-29
  - source: _verifiers_/75-permission-sandbox at f473854 and _verifiers_/80-web-ui/check-approval.mjs at b71a1f0, run 2026-10-23
---

# `rust/crates/heddle-sandbox`

The Rust port of the permission modes, their enforcement backends, escalation and approvals.

| | |
|---|---|
| Ported from | `src/sandbox/` (policy, paths, backend, seatbelt, linux, escalation, service), `src/approvals/service.ts` |
| Judged by | `_verifiers_/75-permission-sandbox`, `_verifiers_/80-web-ui` (check-approval), through the `heddle` binary |
| Sources | [`src/`](src/INDEX.md) |
| Fixtures | [`fixtures/`](fixtures/INDEX.md), the recorded approval question the Web UI checks compare against |
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
| `SandboxService::{new, with_backend, mode, workspace_root, root_for, rooted_at, policy, backend_name, escalation_targets, resolve_path, confine, assert_writable, assert_readable, writable}` | the tool registry and built-in tools; the server (`mode`, `workspace_root`); through `heddle-tools`' gate adapter, the agent turn (`root_for` its session's folder, then `rooted_at` that root, so a session's calls are confined to its own folder unless the operator named a root) and the built-in tools (`rooted_at` the call's folder) | `SandboxService` (`rootFor`) |
| `SandboxDenial` (code `SANDBOX`), `SandboxUnavailableError` (code `SANDBOX_UNAVAILABLE`) | the tools, reported as tool results | the two error classes |
| `classify_outcome`, `SandboxOutcome`, `shell_denial_message`, `runner_failure_message` | the `bash` tool | `classifyOutcome`, the bash tool's sentences |
| `SandboxBackend` trait, `ConfinedArgv`, `select_backend`, `seatbelt::*`, `linux::*` | the service; tests inject doubles | `backend.ts`, `seatbelt.ts`, `linux.ts` |
| `validate_escalation_args`, `approve_escalation`, `EscalationRequest`, `EscalationRefusal` (code `ESCALATION_REFUSED`), `EscalationApproval`, `ESCALATION_TARGETS`, `wider_modes` | the tool registry's one gate | `escalation.ts` |
| `permission_transition`, `FULL_ACCESS_CONFIRMATION`, `ModeChange`, `TransitionRefusal` | `POST /api/sessions/<id>/permission` | `permissionTransition` |
| `ApprovalService::{new, check, attach_answerer, can_answer, pending_requests, subscribe, request, answer, history}`, `ApprovalRequest` (JSON `{id, tool, reason, displayReason, session?, at}`), `Answer`, `ApprovalOutcome`, `is_approval_id` | the registry (`check`, `request`); the server (`attach_answerer`, `subscribe` for the SSE `approval` event, `GET /api/approvals`, `POST /api/approvals/<id>`) | `ApprovalService` |
| `fixture::{QUESTION_JSON, STREAM_FRAME, ANSWER_ALLOWED_ONCE, ANSWER_REJECTED, question, question_json, stream_frame, recorded_answer}` | the Web UI checks read the data files under [`fixtures/`](fixtures/INDEX.md); the crate's tests pin its serialiser to them | recorded from `ApprovalService::request` and the page's `showApproval`/`answerApproval` |

The recorded approval fixture is a **sample, not a contract**: `fixtures/approval-stream-frame.txt` is the exact
SSE frame (`event: approval`, one `data:` line, a blank line). A check compares a live frame's envelope byte for
byte and its payload as parsed JSON, after replacing only the `id`, `session` and `at` of the run it came from.
Key order is not compared: the page uses `JSON.parse`, and a server forwarding through `serde_json::Value` keeps
insertion order only with `preserve_order`, which this workspace gets from `heddle-llm` by feature unification.
[`fixtures/INDEX.md`](fixtures/INDEX.md) states the facts the page depends on and how to consume the files.

**Three Rust shapes differ from the TypeScript on purpose.** Every check takes the call's mode explicitly (no
"default to the deployment mode" parameter; pass `service.mode()`); an approval's cancellation is any
`Future<Output = ()>` (a Stop's cancellation token, or `std::future::pending()`), not an `AbortSignal`; and a
published question is a `tokio::sync::broadcast` receiver from `subscribe()`, not a Cordis event — boot may bridge
it onto the event bus as `approval/request`. `contains` compares by path component, so an entry named `..cache`
is inside its root (the TypeScript prefix test refuses it).

## What the other crates must do with it

These obligations have landed, and both verifiers pass through the binary (task 7 below). The table stays as the
contract a change to any of these crates has to keep:

| Crate (seat) | Obligation |
|---|---|
| `heddle-tools` (developer-five) | per call: `approvals.check(name)` → `DENIED`; escalation args → `validate_escalation_args` (`BAD_ARGS`) and `approve_escalation` with the call's Stop as `cancel` (`ESCALATION_REFUSED`); the mode is never read from `args`. `write_file` / `read_file` / `list_dir` go through `assert_writable` / `assert_readable` (`SANDBOX`); `bash` spawns `confine(["/bin/sh","-c",cmd], mode)` in `workspace_root()` and reports `classify_outcome` with the two message helpers; advertise `sandbox_permissions` / `justification` only when `escalation_targets()` is non-empty |
| `heddle-agent` (developer-five) | the runtime-context snapshot's `sandbox:policy` section is `policy_statement(&sandbox.policy(effective_mode))` |
| `heddle-session` (developer-eight) | the `permission/mode` event and the effective-mode fold use `SandboxMode` |
| `heddle-server` (developer-ten) | hold an `AnswererGuard` while serving; forward `subscribe()` as SSE `event: approval`; `GET /api/approvals` → `{requests: pending_requests()}`; `POST /api/approvals/<id>`: `is_approval_id` else 400, `Answer::parse` else 400, `answer` false → 409; the permission route runs `permission_transition(effective, body.mode, body.confirm)` and refuses with 409 |
| `heddle` boot (developer-two), and its web file (developer-ten, D-047) | build both services from the profile rows (`sandbox`, `approvals`) and share them as `Arc`; `web` gives the server the approvals service with the server attached as its answerer |

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

**Landed so far:** tasks 1 to 6 are implemented, with their unit tests (121 tests at 2026-10-22, `cargo test -p
heddle-sandbox`), including the task 6 ladder through `ApprovalService` as its channel and the recorded approval
fixture, which a live `approve_escalation` call is proven to reproduce byte for byte up to the run's `id` and `at`.
Task 7 is judged: both verifiers pass through the binary, as the section below records.

**The shell seam is judged on the real macOS runner, not only with doubles.** `service::seatbelt_end_to_end`
(macOS only) spawns exactly what the `bash` tool spawns, `confine(["/bin/sh", "-c", cmd], mode)` in the workspace.
It classifies the real exit code and stderr, one test per claim `check-shell-confinement.mjs` makes:
- `workspace-write` admits the inside write and denies the outside one, including from a descendant shell;
- `/dev/null` stays writable, and a command that only prints `Operation not permitted` is not a denial;
- `read-only` runs a shell but denies every write;
- `danger-full-access` is the only bypass;
- `backend: none` fails closed without running anything.
A mutation that turns the profile's `(deny file-write*)` into `allow` fails the `workspace-write` and `read-only`
cases, so the tests can fail.

## Task 7, judged through the binary

**Both verifiers pass through `HEDDLE_BIN`.** The binary is the backend lane's release build of candidate `e9a0836`
(23:42 PDT on 2026-10-22, sha256 prefix `eb58b7447519ee38`). That candidate is `main` `b7bfb32` plus `7d52ad0`, which
advertises `web` and `--turn` under D-048. No shim was involved, and the verifiers were at `f473854` (75) and
`b71a1f0` (check-approval).

| Runner | 75-permission-sandbox | check-approval |
|---|---|---|
| `node _tools_/verify-runner/run.mjs <check> --json`, each file | 17 pass, 0 fail, 0 skipped | 3 pass |
| `sh _verifiers_/75-permission-sandbox/verify.sh` | verdict 0 on all 6 files | — |
| `node _tools_/verify-runner/lane.mjs 75-permission-sandbox` | "17 checks: 17 pass, 0 fail, 0 unjudged", lane green | — |
| `run.mjs` again | — | 3 pass |

It is kept judged: every change on `main` to this crate, approvals, the turn or `web.rs` is re-run. The team's
status table in `rust/INDEX.md` carries the current count. The rehearsals that led here follow.

### Rehearsals before the capability was advertised

Not yet a verdict: `main`'s binary advertises neither `--turn` nor `web` (`usage::SERVED`), so the lane's status run
reports 75 as unjudged. All three runs below are rehearsals, with
`HEDDLE_BIN=<binary> node _tools_/verify-runner/run.mjs <check> --json`. The first two ran on 2026-10-22 with
the verifiers at `d649349` (75) and `5ed8deb` (check-approval). The third and fourth ran on 2026-10-23 UTC with them at
`d649349` and `b71a1f0`.

| Binary | 75-permission-sandbox | check-approval |
|---|---|---|
| The backend lane's release build of candidate `e5f2e80`. A shim adds only the `--turn` help line and passes every other call through | 10 pass (`check.mjs` 5, `check-shell-confinement` 4, unattended `check-escalation` 1), 7 unjudged | not run |
| Debug build of `hd/developer-two` `f45993a` with `hd/developer-two-web` `b6995b6` and `hd/integrator-two` `7d26c6b` merged in. Scratch-only edits: `SERVED` gains `Turn`, and the web branch's sandbox port takes `Option<&Value>` as the server's trait does | 10 pass, 7 fail | 3 fail |
| The backend lane's release build of 22:40 PDT, after `heddle web` was served on `main` in `e3f9d91` (sha256 prefix `934f4604699ca7b7`). A shim adds only the `--turn` and `web` help lines | 13 pass, 4 fail | 3 fail |
| A debug build of unmodified `main` `97f7435`, which has the approvals service (`5e431f6`) and the session-log route (`c93d2f4`) (sha256 prefix `436ce3c2f569f4d1`). The same help-line shim. Run twice | **17 pass, 0 fail, twice** | **3 pass, twice** |

**On `main` `97f7435` both verifiers pass in full**, apart from the advertisement. `usage::SERVED` still lacks `Turn`
and `Web`, so the lane's probes skip. Adding them is the binary owner's switch. The failures of the earlier runs were
all outside this crate:
- In the second run, the `web` command gave the server only the models and sandbox services, so `POST /api/turn`
  answered `400 {"error":"this service is not loaded yet"}` (reproduced by hand).
- In the third run, sessions and turns are served, and the two `check-session-mode` checks pass. Two gaps remain:
  - the server is given no approvals service, so `check-escalation`'s two web cases and all three `check-approval`
    checks never see an approval question;
  - the server has no `GET /api/sessions/<id>/log` route (TypeScript serves it at `src/server/web.ts:1203`), so
    one `check-policy-context` and one `check-runtime-context` check read `not found`.

**Run 75 from a checkout outside the host temp areas.** Its "outside" paths are folders under
`<checkout>/.heddle-tmp/`. From a checkout under `/tmp` those folders are inside a root `workspace-write` admits.
With the same binary, three checks failed from `/tmp` and none from `~/heddle--developer-seven`.

## Risks, stated now

- **Off macOS the verifier cannot pass as written.** `check-shell-confinement.mjs` skips its three kernel checks
  off macOS, and the shared runner (`_tools_/verify-runner/run.mjs`) reports any skip as unjudged (exit 3). The team
  judges on macOS, where all four checks run and pass. The Linux rungs are ported here, but the Linux build host
  used before had no `bwrap` (measured 2026-10-22: not on `PATH`, unprivileged user namespaces work) and no Landlock
  (absent from `/sys/kernel/security/lsm`). Judging there would need a Linux branch in that check (the bwrap dialect
  is `read-only file system`) and `bwrap` on the host. The backend verifiers' integrator decides that, not this crate.
- Resolved: the verifiers' profiles name TypeScript module paths (`src/sandbox/service.ts`) for each row, and the
  binary's boot recognises a name ending in `src/<module>.ts` as the built-in row (`rust/crates/heddle/src/builtins.rs`).
  75's profiles were validated through the binary on 2026-10-22.
- Adding the four dependencies changes `rust/Cargo.lock`, which this seat does not commit; it regenerates on merge.

## Read next

[`../INDEX.md`](../INDEX.md) for the other crates; [`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts.
