---
title: Status of the Rust port
created: 2026-10-24T05:50:00Z
modified: 2026-10-31T06:31:00Z
level: L3
version: 1.27.0
description: The per-part status of the Rust port, written only from a verifier run against the binary, with its command.
status: unverified
grounded_in:
  - source: lane gate runs in ~/heddle--int-backend on the owner's Mac, 2026-10-22 to 2026-10-23, through _tools_/verify-runner/lane.mjs
  - source: the ui lane's readings, _verifiers_/80-web-ui/readings.md at 709bee6
---

# Status

Written only from a verifier run **against the binary**, with the command and the date
([`ULTIMATE_GOAL.md`](ULTIMATE_GOAL.md), *How the state is maintained*). Unjudged (exit 3) is not passing. The checks
behind these figures are in [`status-notes.md`](status-notes.md).

**Run 2026-10-30, in `~/heddle--int-backend`, on `main` at `a76749be` (the first message on a fresh install names how to configure a model; before it, on `ea2eab09`, a run that names no profile boots the shipped default, and the shipped session root follows HEDDLE_HOME; a stopped request is not offered to agent/request-error; before them, on `9dd1533e`, a failed read_file names its file with DSH's codes; write_file reports UTF-8 bytes; an outside tool may declare itself concurrency-safe; a preview cut inside a character keeps the whole characters before it; session titles are cleaned as DSH cleans them; before them, on `820c9d31`, a fork is seeded with its source's log; the Rust preview carries its HTML sanitiser; a model or effort switch made during a turn reaches its next request, with the request hooks run once; before them, on `2dbe2dcb`, every turn ends in the log, a failed or stopped one included; an Anthropic route caches the prompt; the compaction summary is a structured checkpoint; the Web API's tree lists only what is under a workspace root; before them, on `1a49107d`, a prompt sent to a busy session waits for the running turn, on `cb69f420`, a turn's answer is its last non-empty round; a Chat Completions stream asks for its usage; a Stop or the bash wall time kills the command's whole process group, and timeoutMs follows DSH's rule, capped; before them, on `170d773d`, a whitespace-only prompt is refused, on `0f0e9db0` a mid-step message is placed when the step closes and content search, on `5e257430` the summary budget, and on `24d250f3` six backend merges; part 70's browser checks under the integrators' browser slot), with the machine's endpoint file validated, against the previous `main`'s per-check baseline:**

```bash
_tools_/local-build/run build --release --manifest-path rust/Cargo.toml    # exit 0
HEDDLE_BIN="$PWD/rust/target/release/heddle" node _tools_/verify-runner/lane.mjs --baseline <main's baseline> \
  05-config-system 10-llm-backends 20-streaming 30-context-management 40-pluggable-tools 50-agentic-loop \
  60-hooks 70-workspaces-sessions 75-permission-sandbox 98-model-endpoints
```

**203 checks: 202 pass, 0 fail, 1 unjudged; none that passed on the previous `main` stopped passing.** Part 0
gained `check-unscripted-fixture.mjs` (three checks); on `ea2eab09` it gained `check-default-profile.mjs` (five). On `9dd1533e`, part 4
gained `check-read-errors.mjs` (three checks) and `check-write-report.mjs`. Part 5's `check-parallel-tools.mjs` was
rewritten without named pipes: its two old claims are retired, and three take their place (a bounded handshake that
forces completion order, the serial run, read_file batching). Part 70 gained a preview-cut check and two title checks.
On `820c9d31` part 70 gained two fork checks. On `2dbe2dcb`
part 1 gained `check-prompt-cache.mjs` (two checks), part 3 `check-compaction-directive.mjs`, part 5
`check-turn-end.mjs` (two), and part 70 the Web API tree check. On `1a49107d` part 5 gained
`check-turn-queue.mjs`. On `cb69f420`, part 1
gained `check-chat-usage.mjs` (two checks), part 4 `check-bash-timeout.mjs` (four), part 5 `check-final-text.mjs` (two), and
part 8 `check-stop-kills-group.mjs` (seven). Part 5's `check-goal-tool.mjs` failed once under load and passed on its re-run
and three runs alone. Earlier today part 5 gained `check-blank-prompt.mjs` and `check-steer-step.mjs`, part 3
`check-summary-budget.mjs`, part 1 three checks and part 70 five.

**Failing:** none in the backend lane. Part 98 reads the machine's recorded validation, so it judges the configuration:
every configured model now passes it. For the Claude models that means several text deltas, not arrival as they are
generated: the local gateway sends them in one burst at the end, which heddle does not cause (a chat-completions
turn through the same server arrives over time). Part 80 as the lane selects it, run on the same binary, passes 86 of 87 (the TypeScript build's part 80 on `9dd1533e`, 87 of 87); flaky checks that failed once and passed on their re-run are named in the review log; its one failure, the default-port
check, also fails on the previous `main`'s binary, because the live server holds that port ([`status-notes.md`](status-notes.md)).

**Unjudged:** part 1's publisher-route live check needs a publisher-route endpoint, which the machine's file does not
list.

| Part | Verifier, in `_verifiers_/` | On the binary |
|---|---|---|
| 0 configuration | `05-config-system` | **passes** — 22 of 22 |
| 1 LLM backends | `10-llm-backends` | 17 pass, 1 unjudged (publisher route, live) |
| 2 streaming | `20-streaming` | **passes** — 5 of 5 |
| 3 context | `30-context-management` | **passes** — 11 of 11 |
| 4 tools | `40-pluggable-tools` | **passes** — 18 of 18 |
| 5 agentic loop | `50-agentic-loop` | **passes** — 35 of 35 |
| 6 hooks | `60-hooks` | **passes** — 6 of 6 |
| 7 workspaces and sessions | `70-workspaces-sessions` | **passes** — 62 of 62 |
| 8 sandbox | `75-permission-sandbox` | **passes** — 24 of 24 |
| 9 Web UI | `80-web-ui`, `85`, `87`, `88` | **met** by the ui lane on `33407a4`: 80 passes 75 of 75 twice, 85, 87, 88 in full |
| 10 token | `90-web-ui-token` | **passes** — 9 of 9 |
| 11 daemon | `95-web-daemon` | read by the ui lane; it restarts the live server (D-045) |
| model endpoints | `98-model-endpoints` | **passes** — 2 of 2 |
