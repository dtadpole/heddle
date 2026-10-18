---
title: Streaming, from the plugboard route to the page a person opens
version: 1.0.0
description: The full-loop goal that makes a DeepSeek answer arrive at the owner's Web UI incrementally instead of in one burst, with three cycles and the deployment at 8082 as the last measurement.
level: L2
status: complete
grounded_in:
  - owner statement 2026-10-17 asking whether heddle can run with the DeepSeek models behind the plugboard interface and receive streaming
  - owner statement 2026-10-17 that the message must be seen arriving in the Web UI in a streaming manner, not only in the log
  - the running daemon measured on 2026-10-18 at http://127.0.0.1:8082 -> 127.0.0.1:3082, and the session logs under ~/.heddle/sessions
  - _skills_/full-loop-goal/INDEX.md for the cycle this document follows
---

# Streaming

The owner's job, in two sentences: **can heddle run turns against the DeepSeek models behind the
plugboard interface, and does the answer show up in the Web UI they actually open while it is still
being written?** The first half is a claim about an adapter; the second is a claim about a delivered
page, and this document treats them as two claims because the loop has already been wrong once by
measuring a spawned copy instead of the address a person opens.

## Frame, before cycle 1

- **Done is measured as**: a long answer's deltas observed at `http://127.0.0.1:8082/` spread over
  seconds rather than landing in one burst, with the same deltas' timestamps in the session log, a
  page-level build marker present in the bytes served at that address, and an assertion that has been
  watched failing without the fix.
- **Instruments**: `curl -sN` against `/api/turn` on the delivered address (timestamping every SSE
  line as it lands), a real Chrome driven by `_tools_/browser-use/`, a `MutationObserver` on the page's
  `#log` sampling the live row's length, the adapter driven directly from a script, and the session
  logs at `$HEDDLE_HOME/sessions`.
- **The address a person opens, and what answers there**: `http://127.0.0.1:8082/` is a token-supplying
  gate (`_tools_/heddle-web-gate/heddle-gate.mjs`, launchd `com.dtadpole.heddle-proxy`) forwarding to
  `127.0.0.1:3082`, which is launchd `com.dtadpole.heddle-web` running
  `/Users/zhenc/heddle-deploy/dist/cli.js web` from the deployment checkout `/Users/zhenc/heddle-deploy`.
- **The models**: endpoint `plugboard-d`, kind `openai-chat`, models `deepseek-flash` and
  `deepseek-v4-pro`, both listed by the route's own `/models`. Configuration is read from
  `$HEDDLE_HOME/heddle.json`; no URL, key or token is written into this document or the repository.
- **Cycles**: three. **Round cap**: 100.

### The baseline, measured before any change

| Measurement | Instrument | Result |
|---|---|---|
| Does the **route** stream? | `curl -sN` at the wire, every SSE line timestamped | Yes — 30+ `data:` chunks over ~2s, `reasoning_content` first then `content` |
| Does the **adapter** stream? | `openAiChatAdapter` driven directly with `stream: true` | Yes — 46 chunks, first at 1221ms, `done` at 1568ms |
| Does the **adapter** stream with the request a turn actually builds? | same, no `stream` field | **No** — 3 chunks, all at 1419ms: one reasoning delta, one text delta, `done` |
| Does the **delivered address** stream? | `curl -sN` on `8082/api/turn`, a 25-line answer | **No** — `model/request` at 07:19:00.919, then seq 5–9 all inside 20ms at 07:19:14.66 |
| Does the **page** render deltas progressively? | `MutationObserver` on `#log` in Chrome at 8082 | Unjudged — the probe's answer arrived as one delta, so it could not tell a staircase from a jump |

The fourth row is the defect and the third row is its cause: the delivered page waits the whole 13.7s
the model spends thinking and then receives everything at once.

## Cycle 1 — the request never asks to be streamed

```
Cycle 1 — a Chat Completions call asks the route not to stream, so the page can only ever show a burst
  measured:   the wire streams (curl, 30+ chunks/2s); the adapter streams when handed `stream: true`
              (46 chunks, 1221ms..1568ms); the same adapter given the request a turn really builds returns
              3 chunks all at 1419ms; the delivered 8082 returns seq 5..9 inside 20ms after a 13.7s wait.
              Instrument: curl -sN with per-line timestamps, plus src/llm/adapters.ts driven directly.
  brainstorm: (a) default the Chat adapter to streaming, as the other two adapters already are;
              (b) set `stream: true` on every endpoint in the machine's heddle.json;
              (c) make the agent loop pass `stream: true` in every request;
              (d) leave the wire alone and make the page show a spinner until the answer lands;
              (e) buffer-free streaming by polling the log on a timer instead of the SSE stream.
              chosen: (a). discarded: (b) is the same defect fixed per machine, so a fresh clone stays
              broken and the fix has to be rediscovered; (c) fixes the loop and leaves `model.generate`,
              the subagent path and every other caller non-streaming; (d) hides the defect behind an
              animation and makes a burst look intentional; (e) throws away the event stream the server
              already writes, to re-read a compressed log on a timer.
  step back:  keep, and narrow. `types.ts` states "every call is a stream" and both other adapters force
              `stream: true`; the Chat adapter is the one outlier, so this is a value, not a missing
              mechanism. The objective does not change. The sibling question the loop asks: who else
              reads `request.stream`? Only this adapter — so the class of defect is "one adapter invented
              a default the design denies", and the mechanism that prevents a repeat is the assertion.
  changed:    src/llm/adapters.ts — the Chat adapter streams unless the endpoint or the request says
              otherwise, which is the default the other two adapters already had.
              src/llm/http.ts — a streaming request answered without `text/event-stream` decides on its
              first bytes: `{` is one JSON body, anything else is the unlabelled stream it is.
              Both landed on main as cc9c576 by a concurrent session working the same defect (see
              "Two sessions, one defect" below); this session's own version is preserved verbatim on
              fe70410 and was not merged, because cc9c576's peek is the one that does not hang.
  delivered:  http://127.0.0.1:8082/ (heddle-gate) -> 127.0.0.1:3082, launchd com.dtadpole.heddle-web,
              PID 49198, running /Users/zhenc/heddle-deploy/dist/cli.js with --config
              /Users/zhenc/heddle-deploy/cordis.yml. Build marker served at 8082:
              `heddle-page=365a714a1743`, equal to the first 12 hex of sha256(dist/server/page.html)
              computed in the checkout — so the page a person opens is this checkout's build.
              dist/llm/adapters.js line 132 carries `request.stream ?? true`.
              Revert: `git revert cc9c576 && npm run build && launchctl kickstart -k
              gui/$(id -u)/com.dtadpole.heddle-web`.
  evidence:   Instrument 1, the delivered SSE (python urllib on 8082/api/turn, every data: line timed):
                deepseek-flash   2178 deltas (1763 reasoning, 415 text), first 1.373s, last 10.568s,
                                 span 9.195s, all before assistant/completed at 10.568s
                deepseek-v4-pro  2350 deltas (1944 reasoning, 406 text), first 1.433s, last 16.433s,
                                 span 15.000s, all before assistant/completed at 16.468s
              Before: the same address returned seq 5..9 inside 20ms after a 13.7s wait.
              Instrument 2, the page itself (fresh headless Chrome profile `goalfresh`, created after the
              daemon restart, MutationObserver on #log while the composer sent one turn):
                1860 mutations; 413 distinct lengths of the live assistant row and 1426 of the reasoning
                row; the assistant row climbed 1 -> 2 -> 6 -> 13 -> 17 -> 20 -> 24 -> 33 -> 42 -> 48 -> 55
                characters across 29.88s..29.95s and kept climbing to 1926 at 32.32s. A burst would be one
                jump from 0 to the final length.
              Screenshot from 8082: _context_/streaming-delivery/cycle-1-streamed-answer-8082.png.
              Assertion shown to bite: test/stream-arrival.test.ts with the default reverted to `false`
              fails 3 of 4 (asks-to-stream, deltas-while-writing, unlabelled-stream-not-buffered) and the
              fourth, the JSON-body invariant, passes either way by design; restored, 4 of 4 pass.
  reds:       none. npm run check: 0 errors. npm test: 474 tests, 474 pass, 0 fail (the four sandbox
              EPERM failures seen earlier in this session do not occur under danger-full-access; they
              were the outer sandbox refusing a nested fence, not a regression).
  coverage:   both models, reasoning and text deltas, at the wire, the adapter, the delivered SSE and
              the page. Not visited: a tool-calling turn's live render (cycle 2's cell), the CLI's
              --stream printer against the live route, and the Responses/Anthropic routes, which force
              streaming on their own and were outside this defect.
  invariants: a provider that ignores `stream` and answers one JSON body still yields its text — the
              fourth assertion; an unlabelled event stream still streams rather than buffering — the
              third; an endpoint configured `stream: false` still decides.
  landed:     cc9c576 on main (pushed); the deployment at 8082 serves it, measured above. This
              document lands with the next commit.
  lessons:    A check that supplies the condition it is testing cannot see the default: every existing
              chat check passed `stream: true` itself. The mechanism is test/stream-arrival.test.ts, which
              never names `stream`, and a double that honours the request instead of always streaming —
              the first version of this session's own test passed with the defect restored for exactly
              that reason.
```

### What the fix is, exactly

`const streaming = endpoint.stream ?? request.stream ?? false` was written in the first harness commit
and never revisited. The three wire shapes disagreed from that day: the Responses adapter sends
`stream: true` unconditionally, the Anthropic publisher adapter does the same, and the Chat adapter —
the shape the DeepSeek route speaks — defaulted to **not** streaming. A person running `heddle --stream`
against it got a printer that had nothing to print until the turn ended, and a Web UI that could only
ever draw the finished answer, which is exactly the report this loop started from.

The ordering the fix keeps: an endpoint that says `stream: false` in its own configuration still wins,
because that field exists to force the wire either way, and an endpoint that says nothing now streams.

### Two sessions, one defect

This loop's goal was lost once mid-cycle (its rounds were interrupted and the goal record vanished), and
while it was being rebuilt from its own trajectory a concurrent session working in the same deployment
checkout found the same defect, preserved this session's in-flight work verbatim on `fe70410` — so the
deployment checkout held only committed `main`, as the landing rule requires — and landed its own fix
as `cc9c576`. The two fixes agree on the adapter default and on deciding by the first bytes. They differ
on how to peek: this session's version paused the response after the first chunk, and `cc9c576` records
that a pause-based peek was **measured leaving a JSON-body provider pending forever**. So `cc9c576` is
the one kept, and this cycle's job became verifying it at the address the owner opens rather than
landing a second copy of it.

## Cycle 2 — a tool call's arguments are written live and shown at once

```
Cycle 2 — the page goes silent while the model writes a tool call's arguments
  measured:   Instrument 1, a tool turn at 8082 (python urllib, every data: line timed), "run echo, then write
              12 sentences about it":
                deepseek-flash   round 1: 85 reasoning deltas over 0.54s, one tool-call chunk at 2.384s,
                                 done tool_calls; round 2 requested 2.438s, 340 deltas (312 text) over 3.07s,
                                 done stop; turn/completed 6.994s with 2 rounds
                deepseek-v4-pro  round 1: 53 reasoning deltas, tool-call at 3.650s; round 2: 537 deltas (279 text)
                                 over 5.16s; 2 rounds
              Instrument 2, the page (fresh Chrome profile `goalc2`, MutationObserver on #log): the new tool card
              appeared at 13731ms in state `running`, settled `ok` at 13766ms, and the second round's answer row
              then climbed 1 -> 2 -> 6 -> 14 -> 22 -> 26 -> 33 -> 38 ... over 15313..16481ms (316 distinct lengths).
              Screenshot: _context_/streaming-delivery/cycle-2-tool-turn-8082.png.
              So a short tool call streams around itself, and the loop continues. The gap is in the long one:
              Instrument 3, the wire with a tool whose argument is long ("write_file with 40 sentences"): 793
              argument fragments, 4060 characters, arriving 8.255s..10.986s — the provider streams them.
              Instrument 4, the same turn at 8082: the longest silence between two SSE events is
                deepseek-flash   3.683s, from the last reasoning delta (9.981s) to the tool-call chunk (13.664s)
                deepseek-v4-pro 14.112s, from the last reasoning delta (3.537s) to the tool-call chunk (17.649s)
              Nothing reaches the page during that time; then a finished card appears in one step.
  understand: a mechanism this project lacks, not a value. `src/llm/adapters.ts` folds `delta.tool_calls[]` into a
              map and yields one `tool-call` chunk at `finish_reason`; the chunk union in `src/llm/types.ts` has
              no variant a partial call could travel in. DSH's union has `tool-call-delta` (index, id, name?,
              argumentsDelta) for exactly this (`_context_/dsh-mechanisms/dsh-streaming.md` section 1).
  brainstorm: (a) add a `tool-call-delta` chunk, emitted by the Chat adapter per fragment, keeping the final
              `tool-call` chunk unchanged so every existing consumer still reads one complete call;
              (b) replace `tool-call` with deltas only, and let every consumer assemble;
              (c) emit a synthetic "a tool call is being written" status event from the loop, with no content;
              (d) keep the adapter and show a generic spinner on the page whenever a round is open;
              (e) send a progress counter (characters so far) instead of the fragments.
              chosen: (a). discarded: (b) moves the assembly into five consumers (loop, store, ledger, printer,
              page) and every one of them becomes a place the defect can return; (c) and (d) say "something is
              happening" without showing it, which is the burst this loop exists to remove, renamed;
              (e) is (a) with the content thrown away, and saves nothing — the fragments are already in memory.
  step back:  widen, once. The objective says "the answer shows up incrementally"; a tool call is part of the
              answer, and a 14-second silence on the owner's page is the same symptom cycle 1 removed. Scope for
              this cycle: the Chat adapter (the plugboard route's shape) and the page's live tool card. Not this
              cycle: the Responses and Anthropic adapters' equivalents (their routes are outside this objective;
              recorded as siblings), and persisting deltas in the log — the durable record keeps one complete
              call, as DSH's does.
  changed:    src/llm/types.ts — a `tool-call-delta` chunk (index, id?, name?, argumentsDelta), live only.
              src/llm/adapters.ts — the Chat adapter yields one per provider fragment, and still the one complete
              `tool-call` at the finish.
              src/session/store.ts — a delta is published with `transient: true` and the next seq, never appended,
              so the transcript, the trajectory and the surface never see a fragment and the seq has no hole.
              src/llm/service.ts — `generate()` named `done` instead of taking every unnamed chunk as the finish.
              src/server/page.html — the card grows in place and the complete call settles it (ad7aff6), and the
              card is drawn with `addBlock` at the first fragment (3bb7dc2).
  verify (1): ad7aff6 alone was delivered and measured, and it was **not** enough. The SSE instrument at 8082 saw
              825 (flash) and 953 (pro) transient fragments arriving before the call — the server half worked. The
              page instrument saw no live card at all: an EventSource tap on the page's own `/api/events` counted
              1092 `tool-call-delta` events arriving, while the page drew nothing until the finished call. Cause:
              the live card was drawn through `add()`, which returns early on empty text, and a call's first
              fragment usually carries only the tool's name — so there was never a card for later fragments to
              grow. The two instruments disagreed, which is exactly the case the objective names.
  fix:        3bb7dc2 draws the card with `addBlock`, which has no empty-text guard.
  delivered:  http://127.0.0.1:8082/ -> 127.0.0.1:3082, launchd com.dtadpole.heddle-web restarted with
              `launchctl kickstart -k`: PID 4973 -> 63375, started 02:55:54, running
              /Users/zhenc/heddle-deploy/dist/cli.js with --config /Users/zhenc/heddle-deploy/cordis.yml. dist was
              built from the clean committed tree at 3bb7dc2 (no uncommitted file in the checkout). Build marker
              served at 8082 and read by the fresh browser: `heddle-page=dd6d45d28567`, equal to
              sha12(dist/server/page.html). Revert: `git revert 3bb7dc2 ad7aff6 && npm run build && launchctl
              kickstart -k gui/$(id -u)/com.dtadpole.heddle-web`.
  evidence:   Instrument 1, the delivered SSE (8082/api/turn, a write_file call with a ~4000-character argument):
                deepseek-flash   951 transient tool-call-delta events, 16.164s..19.207s, tool-call at 19.327s;
                                 longest silence anywhere in the turn 1.414s (model/request -> first text)
                deepseek-v4-pro  981 transient fragments, 26.982s..33.056s, tool-call at 33.223s; longest
                                 silence 1.587s
              Before: 3.683s (flash) and 14.112s (pro) of silence from the last reasoning delta to the tool-call.
              Instrument 2, the page (fresh Chrome profile `goalc2v` created after the restart, New session, the
              composer, a MutationObserver on #log): the card appeared at 24272ms **live** and titled
              `write_file`, its arguments took 806 distinct lengths over 2385ms (0 -> 1 -> 2 -> 6 -> 7 -> 9 ...
              -> 4024 -> 4025), and the complete call settled that same card at 26675ms with 4025 characters, state
              ok, one card total. Before: no live card; one finished card in one step.
              Screenshot from 8082 mid-stream, the card live at 1615 characters:
              _context_/streaming-delivery/cycle-2-live-tool-card-8082.png.
              Assertions shown to bite: test/tool-call-delta.test.ts — adapter half reverted fails "each fragment
              reaches the caller as it lands"; store half reverted fails "the store publishes a fragment and never
              writes it to the log". _verifiers_/80-web-ui/check-chat-view.mjs "a tool call being written is drawn
              at its first fragment" — with 3bb7dc2 reverted in dist it fails "a card was on screen while the call
              was still being written (41 samples)"; restored it passes.
  reds:       none. npm run check 0 errors; npm test 478/478; check-chat-view.mjs 18/18. (The four sandbox EPERM
              tests seen early in this session do not occur under danger-full-access; they were the outer sandbox
              refusing a nested fence.)
  coverage:   both models, a long tool argument, at the wire, the delivered SSE, the page's event stream, the
              page's DOM and the log. Not visited: the Responses and Anthropic adapters' fragments (siblings, their
              routes are outside this objective); two calls in one round (the slot key handles it; no live
              measurement); a reload mid-call (the live card is not in the log, so a reload draws nothing until the
              call lands — by design, recorded rather than built).
  invariants: the log holds one complete tool-call and no fragment (the store check, and the SSE count of
              transient events vs. the log's single tool-call); every other consumer — loop, ledger, printer,
              transcript — still reads one complete call (the second adapter check); the 17 neighbouring chat-view
              checks still pass.
  landed:     ad7aff6 and 3bb7dc2 on main, fast-forwarded and pushed; 8082 serves 3bb7dc2's build, measured above.
  lessons:    Two instruments that disagree are the finding, not noise: the SSE probe said "streams", the page
              said "nothing". The second fix was found only because the page was sampled at the address the person
              opens. And a guard written for one caller (`add` skipping an empty answer) is wrong for a caller with
              a different meaning of empty — the page check now pins that path. A double that counts every request
              miscounts: the page's `/models` discovery spent the first version's tool call.
```

## Cycle 3 — the cells cycle 2 left unvisited, and the stop condition

```
Cycle 3 — a page that joins mid-answer, the CLI printer, and whether anything is left to fix
  measured:   all at the owner's address, on the build cycle 2 delivered (PID 63375, marker dd6d45d28567), with
              no code changed this cycle.
              (a) Joining mid-answer, server side (python, 8082): a turn was started, and 59 text deltas in a
              second client read the log and opened /api/events. The history held 61 text deltas, the live stream
              delivered 724 more from 2.833s, and the turn's own stream counted 787 — history plus live covers the
              whole answer. The first live event after the history read was seq 3317, contiguous with it.
              (b) Joining mid-answer, the page (fresh Chrome profile `goalc3j`, `showSession` on a running
              session): deepseek-v4-pro joined while it was still reasoning (33 reasoning deltas, 0 text) — the
              answer row then took 196 distinct lengths, first drawn 313ms after the join, and grew to 6575
              characters; the running row was on screen throughout. Joined later (47 text for pro, 95 for flash),
              the row at join already held the recorded prefix and grew from it to the end (276 -> 5165,
              1031 -> 5036 characters).
              (c) After the turn, the live-grown answer and a fresh history render of the same session hold the
              same words: comparing the recorded text with the drawn one, ignoring list numbers and whitespace,
              is equal (5057 recorded characters, 40 lines). The character counts differ only because the
              settled row is drawn as markdown — "1. " becomes an ordered-list marker.
              (d) The CLI's printer (`heddle --stream --json`, deepseek-flash, the deployed dist): 302 text and
              1080 reasoning deltas printed over 5664ms, completed, finish stop.
  brainstorm: (a) build a per-session replay buffer so a joining page gets the chunks between its history read
              and its first live event; (b) add a `since=<seq>` cursor to /api/events; (c) make the history read
              return the last seq so the page can drop duplicates; (d) do nothing. chosen: (d). discarded: (a),
              (b) and (c) each solve a gap that was measured **not to exist** on this server: the live stream is
              opened before the history is read (the page's EventSource is up from load), so the join is already
              covered, and a mechanism built against an unmeasured gap is the "half-built feature" the skill warns
              against.
  step back:  narrow and stop. The skill's stop rule: stop when a full measurement produces no fix row, only
              match and difference-kept-with-its-reason. This cycle's measurements produced none. The one
              observed difference — the live answer's character count vs the fresh render's — is a render
              difference (plain text growing, markdown when settled) with the same words, kept as is.
  changed:    nothing in src/. This document only.
  delivered:  unchanged from cycle 2: http://127.0.0.1:8082/ -> 127.0.0.1:3082, launchd com.dtadpole.heddle-web
              PID 63375 running /Users/zhenc/heddle-deploy/dist/cli.js, marker dd6d45d28567 = sha12 of dist's page,
              dist built from committed main.
  reds:       none.
  coverage:   visited: join-while-reasoning, join-while-answering (both models), history/live agreement, the CLI
              printer. Not visited, with the reason: a reload during a tool call's arguments (the live card is not
              recorded, so the card appears when the call lands — by design, cycle 2); the Responses and Anthropic
              routes (outside this objective).
  landed:     the code of this loop is on main as cc9c576 (cycle 1, the concurrent session's fix verified here),
              ad7aff6 and 3bb7dc2 (cycle 2); the deployment at 8082 serves 3bb7dc2's build — the page marker and
              the PID above. This document lands with its own commit.
  lessons:    Stopping is a measurement too. The cheapest proof that no replay buffer was needed was to join a
              running session from a second client and count: history plus live equalled the turn.
```

## Where it stands

**Done, measured at the address the owner opens.** Both DeepSeek models behind the plugboard interface run turns
in heddle, and their answers reach `http://127.0.0.1:8082/` as they are written: reasoning, text and — since
cycle 2 — a tool call's arguments, each growing on the page before the turn completes, for a page that sends the
turn and for one that joins it midway. Two instruments agree for every claim, and one of them is always the
delivered page.
