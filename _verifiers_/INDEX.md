---
title: Verifiers
version: 2.9.0
description: The ultimate verifications — one folder each, named after the capability the owner named, every one keeping the project's 0/1/3 verdict contract.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, listing the ten verifiers
  - source: ULTIMATE_GOAL.md table of parts
---

# `_verifiers_`

Instance of the `_verifiers_` type. **One folder per verification**, named after the capability
the owner stated rather than after the layer that happens to decide it. Each is a thin entry point over
the check files beside it, and each check file states in its own header what it judges and what it
deliberately does not.

| # | Folder | The claim | Surface |
|---|---|---|---|
| 0 | [`05-config-system/`](05-config-system/INDEX.md) | a run composes its tree from profiles and layers, resolves environment references, and fails loudly | — |
| 1 | [`10-llm-backends/`](10-llm-backends/INDEX.md) | heddle connects to backend model servers and runs agent loops over them | — |
| 2 | [`20-streaming/`](20-streaming/INDEX.md) | streaming text and reasoning arrive as separate deltas, with no Web UI involved | — |
| 3 | [`30-context-management/`](30-context-management/INDEX.md) | context and prompt are composed with retention, a budget and compaction | — |
| 4 | [`40-pluggable-tools/`](40-pluggable-tools/INDEX.md) | tools are configurable and pluggable | — |
| 5 | [`50-agentic-loop/`](50-agentic-loop/INDEX.md) | the agentic loop runs with tool calls | — |
| 6 | [`60-hooks/`](60-hooks/INDEX.md) | hooks intercept a model or a tool call | — |
| 7 | [`70-workspaces-sessions/`](70-workspaces-sessions/INDEX.md) | a workspace names a target folder, sessions are bound to folders under it, and those folders form a recursive tree | headless |
| 8 | [`75-permission-sandbox/`](75-permission-sandbox/INDEX.md) | a permission sandbox distinguishes read-only, workspace write and full access | — |
| 9 | [`80-web-ui/`](80-web-ui/INDEX.md) | a Web UI on localhost, on a documented default port, carrying the live stream | headless |
| 10 | [`90-web-ui-token/`](90-web-ui-token/INDEX.md) | the Web UI and its event stream are protected by a token | — |
| 11 | [`85-trajectory-view/`](85-trajectory-view/INDEX.md) | one session read two ways: the conversation, and the ledger of what the harness did | headless |
| 12 | [`87-resizable-panels/`](87-resizable-panels/INDEX.md) | the sidebar's width is the reader's choice, by pointer or keyboard, and is remembered | headless |
| 13 | [`88-file-preview/`](88-file-preview/INDEX.md) | one preview surface: a file clicked in the left panel, rendered by the library its type calls for | headless |
| 14 | [`95-web-daemon/`](95-web-daemon/INDEX.md) | a launchd agent keeps the Web UI running at the documented port | — |
| 15 | [`96-deployment/`](96-deployment/INDEX.md) | the page the owner sees is the main checkout's build, served by a process running that checkout | — |

### The surface each one runs on

Every verifier states in its own `INDEX.md` — and in the last column above — whether it runs **headless**,
**headed**, or **needs no browser**. The distinction is not decoration: a headed verifier needs a seat, takes
the focus of the machine it runs on and cannot be run unattended, while a headless one can run in a terminal
with nobody watching. A reader planning a run has to know which kind they are about to start before they start
it, and a reader in an unattended context has to know which ones they must skip.

Today every browser-driven verifier here runs **headless**; the window is judged by the browser tool's own
`browser-surface` verifier (`_tools_/browser-use/_verifiers/`), whose headed run checks that a window really
was opened. That is deliberate: the repository's verifications judge heddle, and none of them claims anything
about a window; a check that needs one belongs beside the thing whose window it is.

## Where each stands, 2026-10-11

**112 checks, 0 failures, 0 unjudged**, measured by running every verifier after `npm run build` on
2026-10-11. Nothing is left unjudged: the fourteen checks that were waiting on part 7's mechanism —
written ahead of it because the owner asked for the checks first — now pass, and the two that are
allowed to report unjudged (part 1's real-backend probe and the daemon check) both found their subject
on this machine.

This measurement was taken while **another session was working in the same checkout**, so the counts
have moved under it more than once: part 3 grew from five checks to eight, part 10 from nine to ten, and
two new parts arrived — `85-trajectory-view` with two checks and `87-resizable-panels` with one. The
numbers are counts of checks rather than of parts, and the rows below are the current shape rather than
a diff against the previous measurement.

| # | Checks | Verdict |
|---|---|---|
| 0 | 10 | `0` — profiles, layers, includes, references, validation, provenance |
| 1 | 6 | `0` — both wire shapes, the configured default, listing costs nothing, one real endpoint |
| 2 | 5 | `0` — deltas before completion, with no browser, on every turn of a resumed session |
| 3 | 8 | `0` — the surface and its shadowing, the endpoint's window, prune-before-summarise, a balanced cut, a refused summary, overflow recovery, the instruction baseline, and compacting a long conversation more than once |
| 4 | 6 | `0` — allow list, an out-of-repository tool, a replacement, a malformed spec refused |
| 5 | 6 | `0` — multi-round tasks, results fed back, the limit reported, resume, a failed tool |
| 6 | 6 | `0` — the hook points, retarget, refusal, replacement, a refusal that stops, a broken hook named |
| 7 | 24 | `0` — the transcript, resume and a frame torn by an interruption; containment, the segment-wise trap and the nearest root; one session per folder and `--new`; the tree's one level, kinds, badges, laziness, plumbing and the boundary that only an instance carries a session; in a browser, that a folder opens and closes with the same control; an adopted folder reported as ad hoc and promoted into the tree when it is registered; and a root unregistered, refused while it still holds sessions, or removed with its sessions adopted by the root above it |
| 8 | 5 | `0` — the three modes, the sibling prefix, and the temp directory only when admitted |
| 9 | 11 | `0` — port, page, API, the live stream, a composer that fills the panel, the workspace controls, and a source file shown as source |
| 10 | 10 | `0` — fresh token, cookie handshake, the fence, both endpoints refused, the secret's mode, a stale token's recovery page, session history over the API |
| 11 | 2 | `0` — the ledger's fields and rules over the API, and a browser drawing both views with a timeline |
| 12 | 1 | `0` — a divider that is a control, a pointer drag, the limits, the arrow keys, and the width after a reload |
| 13 | 2 | `0` — each file type through the route the panel uses, and a browser where a click opens the one preview, rendered and styled |
| 14 | 3 | `0` — a complete definition, the port answering with the service's name, and a kill it recovers from |

## The verdict contract

Every entry point returns `0` when its claim holds, `1` when it fails, and `3` when it could not be
judged — and a claim that cannot be judged is never reported as holding. The runner that enforces this
is [`_tools_/verify-runner/`](../_tools_/verify-runner/INDEX.md), because `node --test` alone cannot: measured, a suite
where every check is skipped exits `0`, which is the one answer that must never be given for "nothing
was judged".

A folder with more than one check file runs each and keeps the worst verdict, with failure outranking
unjudged. That ordering is deliberate: a broken capability matters more than a missing one.

## What each check may spend

**Nothing, by default.** A check drives a *scripted* endpoint — a JSON file of steps the `scripted`
adapter replays, calling nothing — or a local HTTP double that speaks the provider's real wire shape.
Both are offline by construction, so a check is reproducible and free.

The one exception is inside part 1: a check named for the real backend asks a **configured** endpoint for
one short answer. It reports unjudged when no endpoint is configured or the signer is not running, because
"the gateway was not set up" must never be recorded as "the gateway works".

## Where the code lives, and which code does not

| The claim | Where the assertion lives |
|---|---|
| a wire shape is parsed correctly | the claim's own check, against a local double that streams that shape |
| an endpoint is reachable and configured | the claim's own check, against the machine's own configuration |
| the harness behaves as the goal describes | the claim's own check, driving the built CLI |
| the framework's own primitives — a context, a fiber, an inject gate | [`test/`](../test/), the project's unit suite, which the goal's checks assume rather than re-test |

The line is drawn by **what is being judged**: a claim about the delivered harness belongs here, a claim
about a Cordis primitive belongs in the unit suite. A verifier that re-tested Cordis would be testing a
dependency, and one that tested nothing but its own fixture would be testing the fixture.

## Coverage review, 2026-10-17

A reading of the set as a whole — what each part owns, where the set overlaps itself, and what nothing
judges yet. It is a review rather than a contract; the proposals at the end are marked as not yet made.

**What the set is.** Twelve instances answer the twelve parts of `ULTIMATE_GOAL.md`; three more
(`85-trajectory-view`, `87-resizable-panels`, `88-file-preview`) were asked for by the owner after the
goal was written and are not rows in its table. That gap is itself a finding: a verifier outside the
goal's table still reads as a completed part, and the goal file's prose mentions two of the three.

**Where the set overlaps itself.**

- `80-web-ui` has become the **UI layer** rather than one part: nine check files and about thirty tests,
  of which only `check.mjs` judges its stated claim (a documented port, the page, the API, the live
  stream). The other eight judge views: chat, composer, context, file, goal, model switcher, trajectory
  and workspace controls. Three of those duplicate a part that owns the same subject — `check-file-view`
  against `88-file-preview`, `check-trajectory-view` against `85-trajectory-view`, `check-workspaces`
  against `70-workspaces-sessions` — and `check-goal` is the only judgement of the goal feature at all.
- `90-web-ui-token` used to carry a chat-rendering test duplicating `80-web-ui/check-chat-view.mjs`.
  It was removed in this pass: the token part judges access, and rendering belongs to the part that owns
  how a session is drawn.
- `70-workspaces-sessions` is the widest instance (36 tests) and mixes the mechanism with
  session-management UI (rename, pin, archive, fork, shortcuts). The mix is coherent with its claim but
  makes one instance the size of three.
- `95-web-daemon` re-judges that a restart does not weaken the token. That overlap with
  `90-web-ui-token` is deliberate and stated there.

**What nothing judges yet.**

1. **The goal mechanism.** `src/goal/{service,tool,driver}.ts` is covered by unit tests, but no verifier
   claims it: that a goal is durable across turns and a restart, that the driver advances its rounds and
   stops at the round limit, that only a person may resume a paused goal, and that its completion is
   recorded once. Only the bar's drawing is judged, inside `80-web-ui/check-goal.mjs`.
2. **The approvals policy.** `src/approvals/service.ts` — `allow`, `deny` and `ask`, a per-tool deny
   list with an allow override, and the rule that an `ask` with nobody to answer is a refusal with a
   reason — has no verifier and no unit test. A permission sandbox and an approval policy are different
   claims: one is what may be touched, the other is who decides.
3. **The published package.** `ULTIMATE_GOAL.md` says distribution is where the end-to-end claim is
   judged, and no verifier packs the tarball, installs it and runs the CLI or imports the package from
   it.

**Proposals, in order** (none of these has been made except the token refactor above):

| Priority | Change | Why |
|---|---|---|
| P0 | make `ULTIMATE_GOAL.md` and this table agree — either add the three owner-requested parts to the goal's table, or state plainly that they sit outside it | a set larger than its contract is a contract that under-describes itself |
| P1 | split `80-web-ui`: keep `check.mjs` there, move the view checks into a `82-web-ui-views` instance, and move the trajectory, file and workspace duplications to their owning parts | one part, one claim; today the UI part is a layer and the layer parts are parts |
| P2 | add `77-approvals-policy`, `83-goal-objective`, `99-published-package` | three mechanisms are delivered and unjudged, one of them named by the goal itself |
| P3 | split `70-workspaces-sessions` into the mechanism and the session-management UI, or move its drawing claims to the UI instance | 36 tests in one instance hide which claim failed |
| P4 | extract the server-plus-double-plus-browser setup the `80-web-ui` checks each repeat into `_tools_/verify-runner` | nine copies of one teardown is nine places a leak can hide |

Each proposal is a separate pass; none should be made while another session is editing the same checks,
and each is a change to this contract rather than to a check.


## Read next

[`ULTIMATE_GOAL.md`](../ULTIMATE_GOAL.md) for the parts these decide, and each folder's `INDEX.md`
for what its claim judges and what it deliberately does not.
