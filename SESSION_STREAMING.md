---
title: Streaming, from the plugboard route to the page a person opens
version: 1.0.0
description: The full-loop goal that makes a DeepSeek answer arrive at the owner's Web UI incrementally instead of in one burst, with three cycles and the deployment at 8082 as the last measurement.
level: L2
status: cycle-1-verified
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
