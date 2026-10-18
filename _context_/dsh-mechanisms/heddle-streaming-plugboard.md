---
title: Streaming, from the plugboard route to the page a person opens
version: 1.0.0
description: The measured answer to whether heddle's plugboard-d DeepSeek turns arrive incrementally — at the provider wire, the adapter, the server's event stream, the durable transcript and the deployed page — with the defect that made the delivered page a burst, the failing-first checks, and the fix.
grounded_in:
  - owner question 2026-10-18 whether streaming content works when heddle uses plugboard-d's DeepSeek models, and whether they actually stream, asked to be verified and checked again
  - the owner's address measured on 2026-10-18: http://127.0.0.1:8082/ -> 127.0.0.1:3082, launchd com.dtadpole.heddle-web, deployment checkout /Users/zhenc/heddle-deploy
  - the machine-local endpoints in $HEDDLE_HOME/heddle.json: plugboard-d is openai-chat at the loopback signing helper (127.0.0.1:8790/d -> plugboard.tririvia.com), models deepseek-flash and deepseek-v4-pro
  - _skills_/full-loop-goal/INDEX.md for the cycle this document follows
---

# Streaming, from the plugboard route to the page a person opens

**Question.** Does a DeepSeek answer through `plugboard-d` *actually stream* — at the wire, through the adapter,
through the server's `/api/turn` event stream, into the durable transcript and onto the page a person opens — or
does it only appear to because the answer is short?

**Answer in one line.** The plugin route and the deployed page do stream — measured, repeatedly — **but the
committed `main` line still folds the whole answer into one delta**, because the Chat adapter asks the route not
to stream. The fix exists as an uncommitted change in the deployment checkout (another session's WIP) and as
`feat/stream-arrival` in this workstream; it is **not yet landed**, and the deployed process happens to be running
a build that already contains it. That mismatch is the open item, not the streaming behaviour itself.

## The defect, and why it hides

`src/llm/adapters.ts` (committed `main`, measured at `56d4196`/`eccdbc6`):

```ts
const streaming = endpoint.stream ?? request.stream ?? false
```

`types.ts` states the design — *every call is a stream* — and the Responses and Anthropic adapters both force
`stream: true`. The Chat adapter was the single outlier, and every check that drove it passed `stream: true`
itself, so the default was never exercised. On the wire the route honours the flag: asked to stream it writes
hundreds of deltas over the model's own writing time; asked not to, it writes one JSON body at the end. The
delivered page therefore waited ~13.7s once and drew a finished answer — which is what the owner saw.

A second half: once the adapter asks to stream, a provider that **ignores** the flag answers one JSON body, and a
provider that streams an **unlabelled** body (no `text/event-stream` content type, measured on the Codex route)
must not be buffered. The fix decides on the first bytes and replays the peeked chunk, so neither case becomes a
burst or an empty answer.

## The instruments

- **Wire:** `curl -sN` against the signing helper's `/d/chat/completions`, every SSE frame timestamped by a
  byte-reader. (The helper accepts `curl`; a Node `fetch`/`http` request with lowercased `Content-Length` is
  answered `400`, an instrument quirk measured here, not a product defect.)
- **Adapter:** `openAiChatAdapter` driven directly against a double that answers **the way it was asked** — a
  double that always streams cannot tell a streaming client from a non-streaming one.
- **Server:** `POST /api/turn` and timestamp every `assistant/chunk` as it lands.
- **Transcript:** `GET /api/sessions/<id>/log` — the durable `assistant/chunk` events and their `at` timestamps.
- **Page:** a real Chrome at the owner's URL, sampling the live row's length every 80ms, with trusted input.
- **Probe:** `_context_/dsh-mechanisms/streaming-probe.mjs` — repeatable, exits non-zero when a turn arrives as
  fewer than three text deltas or with a span under 150ms.
- **Regression checks:** `test/stream-arrival.test.ts` — default-streaming, pacing, JSON-body, unlabelled-stream.

## Cycle 1 — baseline, and the request that asked not to stream

```
Cycle 1 — measure the four layers before changing anything
  measured:   wire (deepseek-flash): 229 deltas over 773ms, first at 1306ms, largest gap 171ms; pro: 250 over
              1689ms, first 1760ms, largest gap 127ms.
              adapter, given `stream: true`: streams; adapter given the request a turn builds on committed main:
              `stream: false`, so the route answers one body.
              committed main, private server: 1 text delta, 570 chars, first == last at 1899-2435ms, span 0ms.
              deployed 8082: 187 text deltas + reasoning deltas, span 400-1300ms (see cycle 3).
  brainstorm: (a) default the Chat adapter to streaming, matching the design and the other two adapters;
              (b) set `stream: true` per endpoint in the machine-local file; (c) make the loop pass
              `stream: true`; (d) show a spinner until the answer lands; (e) poll the transcript from the page
              instead of using the event stream. chosen: (a) plus a robust unlabelled-body rule. Discarded: (b)
              fixes one machine and leaves a fresh clone broken; (c) leaves the CLI, subagents and every other
              caller non-streaming; (d) disguises the defect; (e) throws away the server's event stream.
  step back:  the defect class is "one adapter invented a default the design denies"; the mechanism that keeps
              it fixed is a check on the **arrival**, not just on the request body. Both are now asserted.
  changed:    src/llm/adapters.ts — Chat streams unless the endpoint or request says otherwise;
              src/llm/http.ts — when no stream is labelled, the first bytes decide: `{` means one JSON body
              (read whole), anything else is replayed as the stream it is. Written after measuring that the
              pause/resume peek leaves a JSON-body provider pending forever.
  evidence:   failing first — on committed main the two new checks fail (default false; one 570-char delta) and the
              JSON-body check passes; with the fix all four pass. The probe is red on the unfixed build (1 delta,
              span 0ms, two failures) and green after (187 deltas, 396ms span). A live turn on the fixed private
              build: 187 text + 203 reasoning deltas, first text 2362ms, last 2793ms, span 431ms, 570 chars.
```

## Cycle 2 — the second model, its levels, and the edges

```
Cycle 2 — pro at every declared level, a long answer, a tool call and an early stop
  measured:   /api/turn, deepseek-v4-pro: low 187 text deltas / span 1067ms; high 187 / 926ms; max 187 / 1281ms;
              reasoning deltas rise with effort (22 / 48 / 240), so the level is a real wire value and the stream
              still arrives while that reasoning is written.
              long answer (flash, 30 sentences): 363 text deltas over 1493ms, 1410 chars, largest gap 370ms.
              tool call (flash, "list files then answer"): 249 reasoning deltas, 2 tool-call fragments, 2 rounds,
              finish `tool_calls` — the tool path is streamed too.
              early stop: a turn stopped mid-stream persisted exactly the 62 characters received so far; the rest
              never appeared in the transcript.
  step back:  nothing here is buffered; the only latency is the model's own reasoning before the first text
              delta, and the page shows the reasoning phase first. The evidence cannot show sub-80ms paint
              jitter (the page is sampled), and cannot judge a provider that rewrites its answer after sending
              deltas; neither was observed.
```

## Cycle 3 — the owner's address, twice, and the state of the deployment

```
Cycle 3 — the deployed page paints incrementally; committed main does not
  measured:   http://127.0.0.1:8082/, real mouse, fresh session, DOM sampled every 80ms:
              deepseek-flash: answer first painted at 2873ms with 33 chars -> 3120ms 246 chars -> 3507ms 564
              chars -> turn ended 3588ms (three growth steps; mid-stream screenshot at 246 chars).
              deepseek-v4-pro: first painted 3755ms (3 chars) -> 11 growth steps -> 555 chars, ended 4841ms.
              Second fresh runs reproduce both. The session log of the flash turn holds 187 text-delta events
              with timestamps spanning 404-702ms and `done` 3-6ms after the last.
              Contrast on a clean build of committed main (private 3087): 1 text delta, span 0ms.
  step back:  the deployed build streams because it is running a **build that already contains the fix**, not
              because main does: the deployment checkout `/Users/zhenc/heddle-deploy` is dirty with another
              session's uncommitted streaming WIP (src/llm/adapters.ts, src/llm/http.ts, an untracked
              test/adapter-streaming.test.ts and SESSION_STREAMING.md), and its checked-out HEAD still has
              `?? false`. Its uncommitted contract currently passes 3 of 4 checks: the JSON-body case hangs.
              So the deployment is ahead of committed main, which violates the deployment-checkout rule; a
              rebuild from HEAD would regress 8082 to a burst. That is why this loop does not call the claim
              landed yet, even though the owner's page behaves correctly now.
  reds:       committed main: the arrival checks fail (expected; this branch fixes them). Pre-existing and
              unrelated: test/page-contract.test.ts's context-gauge resolver assertion fails on main and on the
              deployment checkout (the test landed before the page resolver did).
```

## State at the end of this round

- `feat/stream-arrival` (worktree `/private/tmp/heddle-stream-main`, based on `origin/main 56d4196`): the fix,
  four failing-first arrival checks, the probe and this document. Suites: `npm run check` clean, `npm test`
  468/469 (the one red is the pre-existing page-contract check above).
- Streaming is **verified on the deployed address** with the numbers above, and the deployed build carries the
  fix only because it was built from a dirty WIP tree; **committed main still folds the answer**.
- Landing is blocked by the deployment checkout's uncommitted WIP (another session's): landing now would sweep a
  half-written tree. Next round: once the deployment checkout is committed/clean, merge this branch, rebuild,
  restart the agent from it, re-run the probe at 8082 and mark the loop complete.
- The fix written here is independently derived but converges with that WIP; if the other session lands first,
  this branch's tests and probe still apply and only its code hunks are redundant.

## Lessons

1. A default that contradicts the design is invisible while every check supplies the value it defaults; the
   assertion must drive the default.
2. "Streaming" is five claims — wire, adapter, server, transcript, paint — and a green one does not imply the next.
3. A deployed process can be ahead of `main`: read the serving process's build and the checkout's `git status`,
   not just the page. The deployment-checkout rule exists for exactly this.
4. A peek that pauses the response must replay the peeked chunk; a `pause()` without a matching consumer reads as
   "pending forever" on a provider that answers one JSON body.
