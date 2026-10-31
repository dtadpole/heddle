---
title: Status of the Rust port
created: 2026-10-24T05:50:00Z
modified: 2026-10-31T15:25:00Z
level: L3
version: 1.37.0
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

**Run 2026-10-31, in `~/heddle--int-backend`, on `main` at `1031116f` (the terminals replay test reads by snapshot; browser-use bounds its DevTools handshake; a stopped check file names where it stood, and part 5's harnesses are stopped within a bound; before them, on `a7f960c6`, a shutdown records each background job's job/settled in the Rust build, and a timed-out check file leaves no orphans; part 80 was not re-run, since nothing web-facing changed; before them, on `fc632e16`, one unreadable session log is left out and no longer stops a restart; markdown is rendered off the TypeScript server's event loop; a session's interactive terminals, confined like bash; before them, on `334aa313`, the background-jobs control, and an archive a running job refuses or stops; slash commands, plan mode and feedback, with the new heddle-commands and heddle-plan crates; GET /api/settings answers DSH's form projection, and Rust judges a built-in row's config by it; the open blank is reused and shown alone, and first use initializes the default workspace; an unreadable folder and an unwritable New session are refused with codes; the run is on `d76da66d`, and `334aa313` adds only a part-80 test fix; before them, on `6a22d650`, the live stream follows a cursor and replays on reconnect; before them, on `8fd4154d`, a wrongly typed settings write is refused with 422 and writes nothing; a turn into an archived session is blocked before any model request, and a goal round it refuses blocks its goal; a turn asked for during the shutdown grace is refused with 503; a background job's process group ends with the harness; before them, on `65de2219`, sessions are dated by a person's latest prompt and Manual order joins Last updated, and a turn for an unknown session is 404; before them, on `f630fd4e`, the plugin inventory at GET /api/plugin-inventory; a shutdown stops the running turns and lets them settle, so a command in flight ends its process group and is recorded as interrupted; a JSON body that is not an object is refused with 400; before them, on `16adc48c`, a turn its writer never finished is closed at the next write-open and read closed until then; the page is served in the person's stored language, else the browser's; a `~` workspace path is stored as the folder under the home; these three merges ran on `b78bb671`, over `87dacfba`, and `main` then took `2691d362`, which changes only the page and the checks of parts 80 and 85, so the stack was replayed onto it with the unit suites and the TypeScript build's part 80 re-run; before them, on `a6deddaa`, background jobs, with promotion on timeout and output spill; a symlinked folder lists as the folder it resolves to; settings writes apply live, and the settings routes are mounted in both servers; a conversation started through the turn route or the CLI is titled by its own model; part 5 was re-run after `a6deddaa`'s fix to `check-blank-prompt.mjs`'s double, and the rest ran on `e53e4af2`, whose binary is the same; before them, on `8f192cb1`, a fork is named from its source's title alone; an invalid file's error stays visible after an HTML preview; before them, on `4bb459ec`, a session records its agent preset, a turn and a teammate run under it, and GET /api/presets lists them; the page draws DSH's reminder views and the todo_write card; before them, on `570e200b`, a served file is read before its head, a refused write is not listed as edited, and the flat list orders pins like the tree; before them, on `9d740add`, bash output decodes a character split across chunks, keeps its end and names a file with all of it; a failed tool result keeps its output below the error line; a command's stdin ends at once; Stop reaches goal rounds, a stopped round pauses its goal, and a failed or cut turn disarms continuation; before them, on `a76749be`, the first message on a fresh install names how to configure a model; before it, on `ea2eab09`, a run that names no profile boots the shipped default, and the shipped session root follows HEDDLE_HOME; a stopped request is not offered to agent/request-error; before them, on `9dd1533e`, a failed read_file names its file with DSH's codes; write_file reports UTF-8 bytes; an outside tool may declare itself concurrency-safe; a preview cut inside a character keeps the whole characters before it; session titles are cleaned as DSH cleans them; before them, on `820c9d31`, a fork is seeded with its source's log; the Rust preview carries its HTML sanitiser; a model or effort switch made during a turn reaches its next request, with the request hooks run once; before them, on `2dbe2dcb`, every turn ends in the log, a failed or stopped one included; an Anthropic route caches the prompt; the compaction summary is a structured checkpoint; the Web API's tree lists only what is under a workspace root; before them, on `1a49107d`, a prompt sent to a busy session waits for the running turn, on `cb69f420`, a turn's answer is its last non-empty round; a Chat Completions stream asks for its usage; a Stop or the bash wall time kills the command's whole process group, and timeoutMs follows DSH's rule, capped; before them, on `170d773d`, a whitespace-only prompt is refused, on `0f0e9db0` a mid-step message is placed when the step closes and content search, on `5e257430` the summary budget, and on `24d250f3` six backend merges; part 70's browser checks under the integrators' browser slot), with the machine's endpoint file validated, against the previous `main`'s per-check baseline:**

```bash
_tools_/local-build/run build --release --manifest-path rust/Cargo.toml    # exit 0
HEDDLE_BIN="$PWD/rust/target/release/heddle" node _tools_/verify-runner/lane.mjs --baseline <main's baseline> \
  05-config-system 10-llm-backends 20-streaming 30-context-management 40-pluggable-tools 50-agentic-loop \
  60-hooks 70-workspaces-sessions 75-permission-sandbox 98-model-endpoints
```

**266 checks: 265 pass, 0 fail, 1 unjudged; none that passed on the previous `main` stopped passing.** No check was
added. On `a7f960c6` part 5's `check-jobs.mjs` gained the shutdown-settle claim. On `fc632e16` part 8 gained
`check-terminal.mjs` (nine checks), and part 70 an unreadable-log check and a long-answer liveness check. On `334aa313`
part 0 gained
`check-settings-forms.mjs`, part 5 an archive claim in `check-jobs.mjs`, and part 70 four checks (first use's default
workspace, New session never landing in another client's blank, two clients' separate blanks, an unreadable folder).
On `8fd4154d` part 0 gained
`check-settings-validate.mjs`, part 8 four shutdown-grace checks in `check-shutdown-kills-group.mjs`, and part 70 two
archived-session checks and a Last-updated check; its pin-order check was renamed for the two orders ("pins follow DSH in
both orders"), as `65de2219`'s order modes change that rule on purpose. On `f630fd4e` part 0 gained
`check-plugin-inventory.mjs`, and part 8 `check-shutdown-kills-group.mjs` (four checks). The figures are now the lane's own
count: earlier ones read its JSON, where two same-named checks of `check-stop-kills-group.mjs` share one key, so part 8
read one short. On `16adc48c` part 0 gained
`check-locale.mjs` (three checks), and part 70 a turn-closers check and a `~`-path check. On `a6deddaa` part 5 gained
`check-jobs.mjs` (ten checks), and part 70 two symlink checks and a turn-route title check. On `8f192cb1` part 1's
`check-backends.mjs`, which asks the machine's live endpoint for one short answer, was unjudged on its re-run; it passes
again here. Part 5 gained `check-presets.mjs` (two checks) and part 70
a fork-title check; on `570e200b` part 70 gained the pin-order check. On `9d740add` part 4
gained `check-failed-output.mjs` (two checks), `check-stdin-eof.mjs` (two), `check-utf8-chunks.mjs` and a tail check in
`check-output-limit.mjs`; part 5 gained `check-goal-stop.mjs` (three). On `a76749be` part 0
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
turn through the same server arrives over time). Part 80 as the lane selects it, run on the same binary, passes 150 of 151 on `1031116f` (the TypeScript build's part 80, 151 of 151 with `check-access.mjs`'s risk gate passing on its re-run); flaky checks that failed once and passed on their re-run are named in the review log; its other failure, the default-port
check, also fails on the previous `main`'s binary, because the live server holds that port ([`status-notes.md`](status-notes.md)).

**Unjudged:** part 1's publisher-route live check needs a publisher-route endpoint, which the machine's file does not
list.

| Part | Verifier, in `_verifiers_/` | On the binary |
|---|---|---|
| 0 configuration | `05-config-system` | **passes** — 28 of 28 |
| 1 LLM backends | `10-llm-backends` | 17 pass, 1 unjudged (publisher route, live) |
| 2 streaming | `20-streaming` | **passes** — 5 of 5 |
| 3 context | `30-context-management` | **passes** — 11 of 11 |
| 4 tools | `40-pluggable-tools` | **passes** — 24 of 24 |
| 5 agentic loop | `50-agentic-loop` | **passes** — 52 of 52 |
| 6 hooks | `60-hooks` | **passes** — 6 of 6 |
| 7 workspaces and sessions | `70-workspaces-sessions` | **passes** — 78 of 78 |
| 8 sandbox | `75-permission-sandbox` | **passes** — 42 of 42 |
| 9 Web UI | `80-web-ui`, `85`, `87`, `88` | **met** by the ui lane on `33407a4`: 80 passes 75 of 75 twice, 85, 87, 88 in full |
| 10 token | `90-web-ui-token` | **passes** — 9 of 9 |
| 11 daemon | `95-web-daemon` | read by the ui lane; it restarts the live server (D-045) |
| model endpoints | `98-model-endpoints` | **passes** — 2 of 2 |
