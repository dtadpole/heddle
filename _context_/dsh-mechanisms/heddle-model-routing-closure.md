---
title: Closing the model-routing work — a full-loop review
version: 1.0.0
description: The memory of a three-cycle loop that reviews the Meta endpoint and per-model-gateway work for anything left open, fixes what it finds, and does not call the job done until the daemon the owner opens serves the fixed build.
grounded_in:
  - owner statement 2026-10-18 asking for a full loop goal to review the current work and fix anything that has not closed
  - owner statement 2026-10-18 that defects are fixed first and only then is the daemon restarted, so the restart is gated on the owner
  - _skills_/full-loop-goal, whose cycle, evidence and landing rules this document follows
  - the topology measured 2026-10-18 — http://127.0.0.1:8082/ (token gate) to 127.0.0.1:3082 (launchd com.dtadpole.heddle-web running ~/heddle-deploy/dist/cli.js)
---

# Closing the model-routing work

This document is the loop's memory. A later round — or a restarted session — resumes from the cycle blocks
below, not from anyone's recollection.

## What "finished" is measured as

- **Every adapter reports an end the loop understands.** The loop treats `stop` and `tool_calls` as healthy and
  reports anything else as a stop notice on the answer. So a healthy turn on any endpoint kind must produce
  `ended: null` in its `assistant/completed` event, measured by running one real turn per kind and reading the
  session log.
- **An abnormal end says why.** A reply cut by its budget must carry the reason (for example
  `max_output_tokens`), not an empty answer reported as success.
- **No endpoint in the owner's catalogue is unreachable or misreported.** Each model listed under `meta-codex`
  and `meta-claude` answers a turn, with the gateway and the window its configuration declares.
- **The work is landed and delivered.** Merged into `main`, pushed, and the daemon the owner opens
  (`127.0.0.1:3082`) serving a build that carries the fixes — its PID from `/Users/zhenc/heddle-deploy`, with a
  page marker and one real turn through it.
- **The record is complete.** Action-log and input-log entries for every commit, and this document's cycles.

## The instruments

| Instrument | What it is |
|---|---|
| `npm run check` | types, source and tests — 0 errors is the bar |
| `npm test` | the unit suite (`node --test test/*.test.ts`) |
| a real turn | `node dist/cli.js --endpoint <name> --new -q --json --turn …`, then read `assistant/completed` out of the session log with `zstd -dc` |
| the verifiers | only the ones a change touches, because the owner asked that long verifier runs be avoided |
| the owner's address | `http://127.0.0.1:8082/` → `127.0.0.1:3082`, whose process and checkout are recorded per cycle |

## Budget

**Three cycles**, which is the skill's default and what this job should need. **Round cap 100**, the harness
default, stated here because a goal that quietly runs out of rounds looks exactly like one that finished.

## Baseline, measured 2026-10-18 before cycle 1

| Fact | Measurement |
|---|---|
| types and suite | `npm run check` 0 errors; `npm test` 446 pass, 0 fail |
| `meta-codex` (Responses) healthy turn | `text='ok' finish=stop ended=None` — **fixed** at `2a08853` |
| `meta-codex` budget cut | `text='' finish=max_output_tokens ended=['round 1: max_output_tokens']` — **fixed** |
| `meta-claude` (Anthropic) healthy turn | `text='ok' finish=end_turn ended=['round 1: end_turn']` — **open**, same class of defect |
| the owner's daemon | serving a build from before `2a08853`; restart **gated on the owner** |
| `_verifiers_/INDEX.md` | its counts predate the parts this work added; not re-measured, because whole-suite runs were ruled out |
| leftover session backups | 15 `.bak-*` files under `~/.heddle/sessions/`; `sessions list` shows none of them, so they are inert but undecided |

## Cycle blocks

```
Cycle 1 — one vocabulary for three wire shapes
  measured:   one real turn per endpoint kind, reading assistant/completed out of the session log.
              meta-codex (Responses) 'ok' ended=None after 2a08853; plugboard-x the same;
              meta-claude (Anthropic) 'ok' finish=end_turn ended=['round 1: end_turn'] — a stop
              notice on a healthy answer. The loop treats only stop and tool_calls as healthy
              (src/agent/loop.ts:369).
  brainstorm: (a) map end_turn/tool_use inside the Anthropic adapter — smallest, but leaves the
              class: the next provider leaks the same way. (b) one alias table in types.ts that every
              adapter calls — chosen. (c) a typed FinishReason union each adapter returns — stronger
              typing, but the loop reports a string and the providers are external, so the union is
              ceremony. (d) let each endpoint configure its healthy words — pushes a wire fact into
              configuration every machine must restate. (e) drop the notice and trust the text —
              loses the signal for a genuinely cut reply, which is the defect cycle-0 just fixed.
              chosen: (b)  discarded: (a) class not fixed, (c) churn without a reader, (d) config is
              the wrong home for a wire fact, (e) loses a real signal
  step back:  widen. Two adapters were wrong in the same way, so the job is the mechanism, not two
              values. Also siblings: the buffered Chat Completions path shared the streaming defect,
              and 'length'/'max_tokens' were both being reported as opaque words rather than as the
              one fact they name. The promotion rule (a round that produced tool calls ended in
              tool_calls whatever the provider called it) belongs in the same place, because the
              Responses shape reports 'completed' whether or not it asked for tools.
  changed:    src/llm/types.ts — HEALTHY_FINISH_REASONS and canonicalFinishReason, the one owner of
              the vocabulary; src/llm/adapters.ts — all three adapters call it, and
              responsesFinishReason now delegates for the incomplete case.
  delivered:  not restarted; the owner gated the restart. The build carrying this cycle is in
              ~/heddle-deploy/dist and no daemon is running it yet. Revert: git revert <cycle commit>.
  evidence:   before → after, one real turn per kind: meta-claude 'ok' finish=end_turn ended=['round 1:
              end_turn'] → finish=stop ended=None; plugboard-d, plugboard-x and meta-codex all
              ended=None; and a four-round tool turn on meta-claude still runs the tool and answers
              (tool_use → tool_calls), which is the behaviour the promotion rule protects.
              The assertion that fails without the fix: test/finish-reasons.test.ts, four checks, all
              re-run against a reverted canonicalFinishReason and all four red. It drives the real
              adapters against doubles rather than the table alone, because a correct table an adapter
              forgets to call is how this defect would return.
  reds:       one, and it was the fix speaking: test/anthropic-vertex.test.ts pinned finishReason
              'tool_use', the provider's word — the defect itself. Updated to 'tool_calls' with the
              reason recorded in the test, not loosened.
  coverage:   all three wire shapes on the healthy path, the tool path and the budget-cut path;
              buffered Chat Completions (no server needed) via the alias unit check. Not covered: the
              Responses 'stream_ended' path against a real route, because no live route closes a
              stream that way on purpose.
  invariants: the loop still continues a tool round (the four-round runtime turn above), and
              reasoning/content deltas still fold (450 unit checks green, including the fold tests).
  landed:    commit in this cycle; push and deployment are cycle 3's job, and the restart is the
              owner's call.
  lessons:    a provider's word is not the loop's word. The mechanism is one function plus one const,
              and the check that keeps it is per-adapter rather than per-table.
```

## Read next

[`../../_skills_/full-loop-goal/INDEX.md`](../../_skills_/full-loop-goal/INDEX.md) for the procedure this follows,
and [`../../_conventions_/landed-and-deployed/INDEX.md`](../../_conventions_/landed-and-deployed/INDEX.md) for the
landing rule cycle 3 must satisfy.
