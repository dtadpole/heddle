---
title: DSH sandbox backends, and the plan for heddle
version: 1.0.0
description: How DeepSeek Harness confines shell and file effects on each platform, read from the installed packages and probed on this machine, with a phased plan for heddle's own sandbox backend.
grounded_in:
  - source: packages
    detail: the installed DSH packages read on 2026-10-17 — dsh-sandbox, dsh-sandbox-local, dsh-sandbox-policy, dsh-bash-sandbox, dsh-fs-sandbox, dsh-tool-bash, dsh-tool-fs, dsh-sandbox-windows-acl
  - source: machine
    detail: macOS Seatbelt probed directly on this Mac on 2026-10-17 with the profile forms DSH generates
---

# DSH sandbox backends, and the plan for heddle

Two questions: what DSH actually runs to confine a shell, and what heddle should build to close the same
gap without importing a platform it cannot verify. The reading is from the installed packages; the
machine facts are from running the profiles here.

## What DSH does

DSH splits the mechanism in four, and each split is a fact heddle can reuse:

| Layer | Package | Owns |
|---|---|---|
| **seam** | `dsh-sandbox` | the `SandboxMode` vocabulary, a `SandboxPolicy` carried **per call**, enforcement completeness, the denial/hint markers, the strictly-wider ladder, and the fail-closed `SANDBOX_UNAVAILABLE` error |
| **backend** | `dsh-sandbox-local` (+ `dsh-sandbox-windows-acl`) | picks a platform runner, builds its profile from the policy, probes it once, wraps one argv and reports the runner's denial and failure dialects |
| **policy** | `dsh-sandbox-policy` | the deployment default, the per-session `sandbox/mode` event, `effective = explicit grant ?? fold(events) ?? default`, and the model-visible `sandbox:policy` context |
| **consumers** | `dsh-bash-sandbox`, `dsh-fs-sandbox` | the shell executor (kernel confinement) and the filesystem backend (in-process fence), both resolving the same policy |

An approval layer (`dsh-user-approval`) is the only way a call widens, driven by the tool layer
(`dsh-tool-bash`, `dsh-tool-fs`), never by the backend.

### The three modes, per consumer

| Mode | Shell (`dsh-bash-sandbox`) | Files (`dsh-fs-sandbox`) |
|---|---|---|
| `read-only` | the whole process tree runs under a kernel profile that denies every write except `/dev/null` | every mutation is refused; **reads stay unconfined** |
| `workspace-write` | the profile allows writes only under the writable roots (workspace, `/tmp`, `tmpdir()`, canonicalized) | mutations allowed only when the canonical target is under those same roots |
| `danger-full-access` | the provider is never consulted; the original argv runs | the fence returns the caller's target untouched |

`writableRoots(policy)` is **one function** shared by the Seatbelt profile and the fs fence
(`dsh-sandbox` `src/roots.ts`), so the kernel boundary and the in-process check cannot drift. It
returns `[]` outside `workspace-write`, otherwise the canonical set
`{workspaceRoot, /tmp, tmpdir()}`. (`/dev/null` is a separate literal allow in every profile.)

### The platform runners

Selection is by platform first, probes second, and cached for the provider's lifetime:
`linux: bwrap → landlock`, `darwin: seatbelt`, `win32: windows-acl`. No runner means
`SANDBOX_UNAVAILABLE` — never a silent unconfined run.

The profiles, verbatim from `dsh-sandbox-local/lib/index.js`:

- **bubblewrap (Linux, full)** — `--ro-bind / /`, `--dev /dev`, `--unshare-pid`, `--proc /proc`,
  `--die-with-parent`; `workspace-write` adds `--tmpfs /tmp` (so temp writes are ephemeral) and
  `--bind <workspaceRoot> <workspaceRoot>`.
- **Landlock (Linux, full or partial by ABI)** — read-only `/`, read-write `/dev/null` plus, for
  `workspace-write`, `/tmp` and the workspace root; the launcher self-reports partial enforcement on
  older ABIs.
- **Seatbelt (macOS, full)** — `sandbox-exec -p` with
  `(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null"))` and, when
  `writableRoots` is non-empty, one `(allow file-write* (subpath "<canonical root>"))` per root.
- **Windows ACL restricted token (partial)** — a deterministic write SID and standing ACE per
  workspace, a random private temp directory and revocable SID per live session; `partial` because
  NTFS hard links alias files across paths, reads stay unconfined, and one AppContainer's ACL can
  make a tree unreadable to the low-integrity child.

Each wrap also carries its **denial dialect** (`read-only file system` for bwrap,
`permission denied` for Landlock, `operation not permitted` for Seatbelt, four strings for Windows)
and **runner-failure rules** (bwrap `bwrap: ` on stderr, Landlock exit 125 plus `landlock-run: `,
Seatbelt `sandbox-exec: `, Windows exit 127 plus `windows-acl-run: `). Classification order is the
kernel's: a runner failure outranks a denial, because a failed runner means the command never ran.

### Fail-closed and honest facts

- `confine()` rejects with `SANDBOX_UNAVAILABLE` when no runner is usable, and the executor reports it
  instead of running. The error names the platform's options.
- Every confined result carries `enforcement: full | partial` plus `sandbox: { mode, denied }`; the
  model sees `[sandbox: file access denied under <mode> mode]` and, when escalation is advertised, a
  same-turn hint.
- The fs fence is a **policy check in trusted code over a model-controlled path**, not a kernel
  boundary; it re-canonicalizes immediately before the mutation to narrow the TOCTOU window.
  Kernel-grade isolation of untrusted code is `ctx.shell`'s job alone.
- Modes govern **file effects only** — no network, process-visibility or credential claims.
- Seatbelt rides Apple's deprecated `sandbox-exec`; a functional probe is what fails closed if it
  disappears.

### Escalation (the only widening path)

The tool layer advertises `sandbox_permissions` + `justification` (a non-empty sentence, both or
neither). The ladder is execution-time, not schema-time: `read-only → workspace-write |
danger-full-access`, `workspace-write → danger-full-access`; repeating the effective mode returns it
without approval, narrower targets are invalid. `approveEscalation` asks the human through
`ctx.approval`, and the outcome (`allowed-once` / `rejected` / `cancelled`) becomes the call's result;
a grant applies to **one call**. The session's own mode is a separate `sandbox/mode` event, changed
through the UI or `/permission`, surviving restart by replay.

### DSH's known limits, stated by DSH

Same-world confinement only; file effects only; Windows partial; Landlock possibly partial; Seatbelt
deprecated; runner selection cached until reload; a `runnerCommand` override is an operator
assertion; bwrap's `/tmp` is ephemeral while Landlock and Seatbelt write the host's temp.

## Measured on this machine (2026-10-17)

`sandbox-exec` is at `/usr/bin/sandbox-exec`. Running DSH's own profile forms directly:

| Probe | Result |
|---|---|
| read-only profile, `echo hi > /tmp/heddle-sb-probe.txt` | `Operation not permitted`, exit 1, no file |
| read-only profile, `echo hi > /dev/null` | exit 0 |
| workspace-write profile with `(subpath "<workspace>")`, write inside | exit 0, file written |
| same profile, write to `/tmp` | `Operation not permitted`, exit 1, no file |
| same profile, a **grandchild** shell writing to `/tmp` | `Operation not permitted`, no file — the confinement follows descendants |

So the macOS rung DSH uses works here, including the `/dev/null` exception and descendant coverage.

## Heddle today, and the gap

Heddle's `src/sandbox/service.ts` is the **fs fence** row of the table above: canonical-path
containment for `write_file` / `read_file` / `list_dir`, per-call mode resolved at the tool registry
and recorded as a per-session event. It is deliberately stricter than DSH in one respect — reads are
confined too — and weaker in one that matters:

- **`bash` is not confined.** The tool spawns `sh -c <command>` with the workspace as cwd, so under
  `workspace-write` it can write anywhere; `read-only` refuses the shell entirely rather than
  confining it.
- There is no backend seam, no enforcement fact, no denial classification, and no fail-closed
  error — because there is no kernel boundary to report.
- There is no per-call escalation; widening is only the owner's session-level switch (which the UI
  gates and the server enforces).
- `danger-full-access` and `workspace-write` therefore differ for the file tools but not for the
  shell.

That is the honest state after the permission-mode cycle. This document plans the missing row.

## Plan

### Goal and the claim it must satisfy

`workspace-write` must mean the same thing for a shell as for `write_file`: a write outside the
writable roots is refused, and the refusal is reported, not silent. `full access` is the only bypass.
`read-only` must be able to keep a shell without granting writes. And when no backend is usable the
harness must **refuse to run the command**, not run it unconfined.

The verifier claim, in `_verifiers_/75-permission-sandbox/` terms: the same command writes inside a
workspace and is denied outside it under `workspace-write`; the same denial under `read-only`; the
same command succeeds outside under `danger-full-access`; a forced-missing backend yields
`SANDBOX_UNAVAILABLE`; a command that merely prints a denial signature is not misclassified.

### Phase 0 — the seam and the one root list (no behaviour change)

1. `src/sandbox/policy.ts`: move `SandboxExecutionPolicy` and a new `writableRoots(policy)` helper out
   of the service, mirroring DSH's `roots.ts` — `[]` outside `workspace-write`, else the canonical set
   of workspace + extra roots + the configured temp root.
2. `src/sandbox/backend.ts`: the backend contract —
   `confine(argv, policy): { argv, enforcement, denialSignatures, runnerFailureRules }` plus a cached
   `probe()`. No runner yet; the fs fence becomes its first consumer by using `writableRoots`.
3. Unit tests: the root list per mode, canonicalization, and the fence/profile parity (a path the fence
   permits is a path the profile will contain, for the same policy).

**Acceptance:** existing suites and all verifiers unchanged; the helper is the only place the writable
set is computed.

### Phase 1 — macOS Seatbelt, and a confined shell (the cycle that matters here)

1. `src/sandbox/seatbelt.ts`: build the profile exactly as measured —
   `(version 1)(allow default)(deny file-write*)`, the `/dev/null` literal, and one
   `(allow file-write* (subpath "<canonical root>"))` per writable root, quoted. Probe once with the
   real read-only profile around `true`; cache the verdict.
2. Chain selection: `darwin → seatbelt`; other platforms report `unavailable` until their phase. A
   forced `HEDDLE_SANDBOX_BACKEND=none` exists for the fail-closed test.
3. `builtin.ts` `bash`: resolve the call's policy, then
   - `danger-full-access`: spawn as today, no provider consulted;
   - confined mode **with a backend**: spawn the wrapped argv
     `sandbox-exec -p <profile> -- /bin/sh -c <command>`, keep the workspace cwd and timeout;
   - confined mode **without a backend**: return `SANDBOX_UNAVAILABLE` and do not run (fail closed);
   - `read-only` then keeps the shell, confined, instead of refusing it — a better answer than today,
     and one the kernel makes true.
4. Classify the result: runner fatal signature or gated exit → "the runner failed, the command did not
   run"; else denied-signature match on stderr → `sandbox: { mode, enforcement, denied: true }` with
   the marker; else ordinary exit. Runner failure outranks denial.
5. Extend `ToolResult.data.sandbox` with `{ mode, enforcement, denied }` and append the marker to the
   model-visible output; the page's closed tool row already shows the result text.
6. Verifier `_verifiers_/75-permission-sandbox/` gains shell checks driven by the same scripted
   endpoint: inside/outside under `workspace-write`, `read-only`, `danger-full-access`, fail-closed
   with the backend forced off, a descendant-write case, `/dev/null` in read-only, and the
   false-positive case (a command that prints `Operation not permitted` but exits 0 must not be
   reported as denied).
7. Docs: `_context_/dsh-mechanisms/dsh-sandbox-backends.md` (this file) plus the sandbox/verifier
   INDEX updates, and the limitation note in `src/sandbox/service.ts` shrinks to "same-world, macOS
   rung shipped".

**Acceptance:** the shell checks above are red before the wire-up and green after; every existing
verifier still passes; `read-only` no longer needs to refuse the shell on a machine with a backend.

### Phase 2 — Linux bubblewrap, same seam

`bwrap` backend behind the same contract (`--ro-bind / /`, `--dev /dev`, `--unshare-pid`,
`--proc /proc`, `--die-with-parent`; `workspace-write` adds an ephemeral `/tmp` and the workspace
bind), with the probe arbitrating bwrap against a later Landlock rung. Only worth shipping when a
Linux machine judges it; the seam and the verifier already exist by then. Landlock stays deferred
because its launcher is a versioned external binary.

### Phase 3 — per-call escalation and the approval card (separate cycle)

Port DSH's widening path only after an approval prompt exists: `sandbox_permissions` +
`justification` on the mutating tools, the closed ladder, one-call grants, and a page card with
Reject / Allow once fed by a new approval SSE. Until then the session-level switch stays the only
widening action, which is the current, tested behaviour.

### Phase 4 — optional, only on evidence

Windows ACL rung (DSH itself reports it `partial`), enforcement display in the UI/trajectory, and a
`/sandbox` command that reports the selected runner and the last denial. Not planned until something
needs them.

### Choices deliberately kept or dropped

- **Keep heddle's narrower temp policy.** DSH grants `/tmp` + `tmpdir()` to `workspace-write`; heddle
  measured that this is a large shared tree and made it opt-in (`tempRoot`). The backend will use the
  same `writableRoots` as the fence, so the shell gains exactly what the fence has — no wider.
- **Keep reads confined.** DSH's fs fence leaves reads unconfined; heddle's confines them in the two
  confined modes. That is stricter and already tested; the plan does not relax it.
- **Keep `workspace-write` as the deployment default.** DSH defaults to `read-only`; heddle's choice
  is documented and is the owner's, not a sandbox fact.
- **No container/microVM.** DSH calls it out of scope for this seam too; it replaces the whole
  environment rather than adding a backend.
- **No `runnerCommand` override** in the first phases: an operator-supplied runner is an assertion
  that skips probes, and the value is unclear before there is a second platform.

### Risks and how the plan answers them

| Risk | Answer |
|---|---|
| `sandbox-exec` disappears (Apple deprecation) | probe at start, fail closed with `SANDBOX_UNAVAILABLE`, never run unconfined |
| profile matches unresolved paths (`/tmp` is `/private/tmp`) | every root canonicalized by the one helper; measured above |
| wrapper startup escapes confinement | wrap the exact argv and spawn it directly; never a shell-script runner whose interpreter starts before the profile applies |
| a denied command read as a command failure (or the reverse) | runner-failure rules checked before denial signatures; false-positive case in the verifier |
| fence and runner drift | one `writableRoots` function, asserted by a unit test |
| the model believes it has write access it lacks | the denial marker gives the mode; the existing `sandbox:policy` context can be added in phase 1's docs pass |
| `danger-full-access` accidentally wrapped | the provider is not consulted at all in that mode, and a unit test pins it |

## Cycle 1 — the seam and the macOS rung

### measured

The gap was measured, not read: a scripted turn under a `workspace-write` profile ran
`bash` with `echo escaped > <outsidePath>`, and the file landed **outside** the workspace
(the turn reported the tool `ok`). That is the baseline this cycle removes. The reference
facts re-measured while writing this: macOS `/usr/bin/sandbox-exec` applies DSH's exact
profile forms here — read-only denies a `/tmp` write with `Operation not permitted` while
`/dev/null` stays writable; a `(subpath "<workspace>")` grant allows the inside write and
denies the outside one, including from a **grandchild** shell.

### brainstorm

| # | Candidate | Verdict |
|---|---|---|
| 1 | Inline `sandbox-exec` call inside the `bash` tool | **Discarded** — the profile, selection and classification would live in a tool; the fs fence and any future executor would duplicate them, and there is nowhere to hang the probe or the fail-closed error |
| 2 | A backend seam with pure profile builders, a platform chain, a cached probe, per-call wrap, and a shared `writableRoots` (DSH's shape) | **Chosen** — one policy home, unit-testable profile text, one place to fail closed, and the fence and kernel profile cannot drift |
| 3 | Operator-supplied `runnerCommand`/shell-script wrapper | **Discarded** — an assertion without a probe, and a shell interpreter starts before the profile applies (DSH records the same caveat) |
| 4 | Use a backend when present and silently run unconfined when absent | **Discarded** — the silent widening the whole mechanism exists to prevent; DSH fails closed with `SANDBOX_UNAVAILABLE` instead |
| 5 | Keep refusing the shell in confined modes (status quo) | **Discarded as the end state** — safe but gives up the tool; it remains only as the fail-closed answer when no runner is usable |
| 6 | Container / microVM / remote executor | **Discarded for this seam** — replaces the environment rather than adding a backend; same-world confinement is DSH's stated boundary too |
| 7 | Node's permission model or `chroot` | **Discarded** — neither confines a descendant process tree to a writable-root set without a platform runner; `chroot` needs root |
| 8 | Vendor DSH's packages as dependencies | **Discarded** — heddle does not depend on DSH; the job is the mechanism, and the seam is portable enough to implement here |
| 9 | Landlock first (native addon) | **Discarded for cycle 1** — its launcher is a versioned external binary; the bwrap rung is the Linux phase-2 candidate |

### understand and step back

DSH's split is what makes the mode honest: the policy is a value resolved per call, the
backend turns that value into a kernel profile and reports what it actually governed, and
the consumer reports the model-visible fact. Heddle already has the policy row (the
`permission/mode` event, resolution at the tool registry) and the in-process fence; it has
no backend seam at all, and its `bash` is the unconfined shell.

The step back changed the scope in two ways and kept one:

- **Widened:** the previous cycle's claim "read-only refuses the shell" was a stand-in for
  a confinement heddle did not have. With a backend, read-only can keep the shell and let
  the kernel deny writes — a better answer, and the old checks must be rewritten rather
  than left passing on a claim that is no longer the mechanism.
- **Widened again:** a denied command must be reported as denied (model-visible marker and
  `sandbox: { denied }` fact) and a runner failure must outrank that classification, or the
  model learns the wrong lesson from an ordinary exit code.
- **Kept narrow:** Linux rungs, the model-visible policy context and the escalation ladder
  are cycle 2 and 3 work; the Windows ACL rung stays out because DSH itself ships it as a
  separate external runner with partial enforcement, so heddle will fail closed and name it
  as a remaining difference.

### plan

1. `src/sandbox/paths.ts` — move `canonical`/`contains` to one home used by the fence, the
   policy and the profiles.
2. `src/sandbox/policy.ts` — the mode vocabulary, `SandboxExecutionPolicy`, and the one
   `writableRoots(policy)` the fence and every profile consume.
3. `src/sandbox/backend.ts` — the contract (`ConfinedArgv` with enforcement, denial
   signatures and runner-failure rules), `SandboxUnavailableError`, platform selection, and
   the pure outcome classifier.
4. `src/sandbox/seatbelt.ts` — the measured SBPL profile, probe, and the darwin backend.
5. `src/sandbox/service.ts` — keep the public face, re-export the moved vocabulary, add a
   `backend` config knob (`auto`/`none`, the latter for the fail-closed check) and
   `confine(argv, mode)`.
6. `src/tools/builtin.ts` — `bash` spawns the confined argv, classifies the result, reports
   `sandbox` facts, and keeps the shell under read-only instead of refusing it.
7. Tests: `test/sandbox-backend.test.ts` (roots, profile text, selection, classification,
   fail-closed, full-access bypass) and `_verifiers_/75-permission-sandbox/check-shell-confinement.mjs`
   (inside/outside, read-only, full access, descendant, `/dev/null`, false positive, no-backend).
8. Docs: this block, the sandbox/verifier INDEX entries, and the limitation sentence in the
   service that says the shell is not confined.

### changed

- `src/sandbox/paths.ts` — `canonical`/`contains`, moved out of the service so the fence, the policy and the
  profiles share one comparison.
- `src/sandbox/policy.ts` — the mode vocabulary and `writableRoots(policy)`; **DSH's set for
  `workspace-write`** (workspace, named extra roots, `/tmp`, `tmpdir()`, canonicalised).
- `src/sandbox/backend.ts` — the backend contract, `selectBackend`, `SandboxUnavailableError`, and
  `classifyOutcome` (runner failure outranks denial; a denial needs a failed command).
- `src/sandbox/seatbelt.ts` — DSH's SBPL profile, a functional probe around `true`, and the darwin rung.
- `src/sandbox/service.ts` — re-exports the moved vocabulary, adds `confine(argv, mode)`, the `backend`
  config knob (`auto`/`none`), and uses `writableRoots` for the fence too.
- `src/tools/builtin.ts` — `bash` spawns the confined argv, reports `sandbox: { mode, enforcement, denied }`,
  keeps the shell under read-only instead of refusing it, and fails closed when the deployment has no backend.
- Tests and checks: `test/sandbox-backend.test.ts` (new), `test/permission-mode.test.ts` (the read-only
  shell claim updated), `_verifiers_/75-permission-sandbox/check-shell-confinement.mjs` (new),
  `check.mjs` (the temp claim replaced by the DSH-parity claim), `check-session-mode.mjs` (the shell step
  removed, the write claim kept), and `_verifiers_/80-web-ui/check-model-switcher.mjs` (a boot race fixed —
  it asserted the seat's text before `loadEndpoints` answered; reproduced on a build with no sandbox change).
- `src/sandbox/INDEX.md`, `_verifiers_/75-permission-sandbox/INDEX.md` and the permission-modes document's
  superseded shell claim.

### evidence

**Before.** Measured, not read: a scripted `workspace-write` turn ran
`bash 'echo escaped > <outsidePath>'` and the file landed **outside** the workspace, with the tool reported
`ok`. `read-only` refused the shell rather than confining it, and there was no backend seam, no enforcement
fact and no fail-closed error.

**Failing first.** `test/sandbox-backend.test.ts` was red with the new modules absent
(`ERR_MODULE_NOT_FOUND`); `_verifiers_/75-permission-sandbox/check-shell-confinement.mjs` reported
`verdict 1 — 3 check(s) failed` (the outside write succeeded, read-only had no shell, and the forced-missing
backend ran the command).

**After** (measured on this branch):

| Instrument | Before | After |
|---|---|---|
| `test/sandbox-backend.test.ts` | missing modules | 6 pass, including the real kernel checks on macOS |
| `npm test` | 338 pass | **345 pass / 0 fail** |
| `npm run check`, `npm run build` | green | green |
| `_verifiers_/75-permission-sandbox/` | 7 checks | **11 checks, all pass** (5 three-mode + 2 session-mode + 4 shell-confinement) |
| `_verifiers_/80-web-ui/` | 11 files green (with a flaky model-seat check) | 11 files green after the flake fix |

Kernel facts measured by the new checks: `workspace-write` permits the inside write and denies the outside
one (`Operation not permitted`), **including from a grandchild shell**; `/dev/null` stays writable; a
read-only shell runs and cannot write; `danger-full-access` writes outside; a forced-missing backend refuses
the command and nothing it would have written exists; a command that prints `Operation not permitted` and
exits 0 is not reported as denied.

**Two claims deliberately replaced, not silently dropped:**

1. **The temp area.** DSH's `workspace-write` grants `/tmp` and `tmpdir()`; the previous cycle deliberately
   excluded them and the verifier asserted the refusal. Matching DSH means adopting the set for both the fence
   and the kernel profile, so `check.mjs`'s claim was replaced with "workspace-write admits the host temp area,
   and read-only does not". The earlier concern (a shared, world-writable tree under `/var/folders`) is the
   recorded cost of parity rather than a difference any more.
2. **The read-only shell.** It is no longer refused on a host with a backend: the kernel confines it and denies
   its writes, which is the stronger claim. The permission-mode document marks the old sentence superseded.

### coverage

Measured: the inside/outside write under each mode, descendant confinement, `/dev/null`, a false-positive
denial sentence, a forced-missing backend, the file fence's roots (now including the temp areas), the profile
text and quoting, selection per platform, and the classification order. Not measured this cycle: the Linux
rungs (next cycle), the model-visible policy statement (next cycle), the escalation ladder and its approval
card (cycle 3), and the Windows rung (out of scope, fails closed).

### invariants

The permission control's browser contract still passes (the chip, its menu, the risk gate and the refusal
row); the session-mode checks pass with the shell step removed; the unit suite pins that a delegated child
inherits the parent's mode, so the new kernel boundary is not widened by delegation; `danger-full-access`
never consults a backend, which a unit test asserts.

### lessons

- **The mode had two consumers and heddle implemented one.** The gap was invisible because every check
  exercised the fence; the shell is the consumer that made the mode a claim instead of a preference.
- **Fail-closed is a code path that must be forced in a test.** `backend: none` exists so the refusal is
  measured, not trusted.
- **Classification is part of the boundary.** A denial reported as an ordinary exit teaches the model to
  retry the wrong way; a runner failure reported as a denial teaches it the command failed when it never ran.

## Read next

[`dsh-permission-modes.md`](dsh-permission-modes.md) for the session mode and the UI control this plan
extends; [`../../src/sandbox/INDEX.md`](../../src/sandbox/INDEX.md) for the service the backend plugs
into; [`../../_verifiers_/75-permission-sandbox/INDEX.md`](../../_verifiers_/75-permission-sandbox/INDEX.md)
for the claims that will judge it.
