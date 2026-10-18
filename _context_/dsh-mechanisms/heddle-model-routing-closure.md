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

```
Cycle 2 — where a model lives, not where its endpoint does
  measured:   siblings of cycle 1's class, found by asking "which reader still takes a per-model fact from the
              endpoint?". Three, all silent. The model-list read asked the endpoint's address about the
              endpoint's DEFAULT model, so any other model's answer was undefined — and undefined is what a
              caller reads as "text only". Measured with a two-host double: inputModalitiesFromModelList for a
              model living on the second host returned undefined, where the host that serves it declares
              ['text','image']. The same read used fetch, which cannot take a forwarding hop, so on a gateway
              that requires one it could only ever fail. And the catalogue the page reads dropped each model's
              own contextWindow: meta-codex showed (none) for all five while the configuration declares 272000
              and 1000000.
  brainstorm: (a) pass a model argument to the readers — smallest, but leaves the address wrong because the
              reader still builds the URL from the endpoint. (b) resolve the model's own baseUrl inside
              model-info and take the model to ask about as an option — chosen. (c) have the caller pass a
              fully-resolved {url, model} pair — correct but makes every caller repeat the resolution.
              (d) drop discovery and require contextWindow/inputModalities in configuration — removes a
              convenience that exists because providers publish the facts, and makes every machine restate
              them. (e) keep fetch and configure a global proxy env — a process-wide setting for a per-endpoint
              fact. chosen: (b)  discarded: (a) address stays wrong, (c) duplication at every call site,
              (d) loses published facts, (e) wrong scope
  step back:  widen once more, and the widening paid: the cache was keyed by endpoint alone, so a second model's
              question would have been answered by the first model's capabilities. A per-request fact needs a
              per-request key. Also the endpoint's window was still the only one the catalogue exposed, so a 1M
              deployment was measured against 272k — the same class, one layer up.
  changed:    src/llm/model-info.ts — askAbout, addressOf (a model's own baseUrl), a per-endpoint-and-model
              cache key, and the read now goes through wire() so the hop works; src/llm/service.ts — the
              modality lookup is cached and invalidated per endpoint AND model, and the request's own model is
              passed; src/endpoints.ts — describeModel carries the model's window, inheriting the endpoint's
              when it declares none; test/model-info-per-model.test.ts — a two-host double where model b exists
              only on the second host.
  delivered:  not restarted; the owner gated it. The build is in ~/heddle-deploy/dist.
  evidence:   before → after: the two-host probe returned undefined for model b and returns ['text','image'];
              describeEndpoint for meta-codex shows (none) for every model and now shows 272000, 272000,
              1000000, 272000, 272000. Assertions shown to fail without the fix: three of the five new checks
              (own-address, cache-separation, catalogue window) went red against the reverted sources; the
              other two are regression guards on behaviour that was already correct (default address, refusal
              becomes undefined).
  reds:       one, and not mine: test/page-contract.test.ts caught a duplicate top-level `const FOLLOW_SLACK_PX`
              in src/server/page.html — a SyntaxError that leaves the WHOLE page module without behaviour. Found
              by the suite while cycle 2 ran; fixed in the working tree and fixed independently by the concurrent
              session as CHAT_FOLLOW_SLACK_PX (commit abe7ced), which is what main carries. Verified after: no
              duplicate among 356 top-level declarations, page-contract 16/16.
  coverage:   the per-model address, the per-model cache key, the refusal path, and the catalogue window. Not
              covered: a real provider that publishes per-model windows differently per host (the double speaks
              one listing shape), and an image turn end to end against meta-codex, because no model there is
              known to accept images and a false claim would be worse than an untested one.
  invariants: 455 unit checks green; one real turn on meta-codex with a non-default model (gpt-5.6-sol-ptu)
              answers, so routing a model to its own host did not break the ordinary path.
  landed:    pushed as 0aaff60 (the concurrent session committed this cycle's working tree as found, with the
              loop credited). Provenance is recorded rather than claimed: the code is on main and the evidence
              above was taken from it.
  lessons:    a fact that varies per model must be keyed per model everywhere it is cached, resolved and
              displayed; three readers had taken it from the endpoint and none of them failed loudly.
```

```
Cycle 3 — the denominator a person reads
  measured:   the last reading site of cycle 2's class, one layer out: the page. Three places chose a denominator
              with `endpoint?.contextWindow` — the status bar's gauge, its popover, and the popover's rows — while
              the catalogue the server sends already carries each model's own window. Measured from the built
              server: meta-codex's endpoint declares 272000 and gpt-5.6-sol-ptu declares 1000000, so selecting
              that model and sending a long conversation drew the gauge against 272k — "nearly full" for a
              conversation nowhere near it. The same reading is what the popover printed as "used / window".
  brainstorm: (a) divide by the largest window the endpoint offers — cheap, and wrong in the safe-looking
              direction: it would understate every small model. (b) a page-side resolver that asks the catalogue
              for the selected model's window and falls back to the endpoint's (chosen). (c) have the server send
              a single `effectiveContextWindow` per session — right for the gauge, but the page also needs it
              before a session exists (the composer, a fresh seat), so it cannot be the only source.
              (d) remove the endpoint-level window from the payload so the mistake is unrepresentable — would break
              the settings list, which legitimately describes an endpoint rather than a model.
              chosen: (b)  discarded: (a) understates small models, (c) not available before a turn, (d) the
              endpoint is still a fact worth showing
  step back:  keep — this closes the class rather than adding a fourth fix to it. The three readers were the last
              of them: a sweep for `endpoint?.contextWindow` and for `endpoint.model` in the page and the server
              finds no other reading site that should have asked about the model, and the remaining
              `request.model ?? endpoint.model` uses are correct (the request's model, falling back to the
              default).
  changed:    src/server/page.html — `windowFor(option)` resolves the selected model's window from the catalogue
              and falls back to the endpoint's, and the three reading sites use it; src/server/page.html's
              `window` in the status bar, the popover rows and the popover header no longer read the endpoint
              directly. test/page-contract.test.ts — a removal detector that fails if a reading site goes back to
              `endpoint?.contextWindow`.
  delivered:  not restarted; the owner gated it. The built server's catalogue was read to confirm the data the
              page now uses is present in ~/heddle-deploy/dist.
  evidence:   before → after: the built catalogue reports gpt-5.6-sol-ptu at 1000000 while the endpoint says
              272000, which is the number the page now divides by. The assertion shown to fail without the fix:
              the new page-contract check went red against the reverted page.html and green against the fix; the
              extracted module still parses under `node --check`.
  reds:       none.
  coverage:   the three reading sites and the catalogue data they consume. Not covered: the gauge's pixels, because
              that is the browser's job and the verifier that judges the status bar needs a running daemon; and the
              case of a model that declares a window the endpoint does not, which the resolver handles by
              construction but no fixture exercises.
  invariants: 456 unit checks green; page-contract 17/17; the page module parses, so a rename did not leave the UI
              without behaviour — which is exactly what cycle 2's red taught.
  landed:    committed in this cycle; the push and the deployment stay open until the owner allows the restart.
  lessons:    the same fact has a reading site in the page as well as in the server. Sweeping one layer is not
              sweeping the class, and a denominator that is wrong quietly is still wrong.
```

## Read next

[`../../_skills_/full-loop-goal/INDEX.md`](../../_skills_/full-loop-goal/INDEX.md) for the procedure this follows,
and [`../../_conventions_/landed-and-deployed/INDEX.md`](../../_conventions_/landed-and-deployed/INDEX.md) for the
landing rule cycle 3 must satisfy.
