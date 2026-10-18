---
title: Attachments, as DSH delivers them
version: 1.0.0
description: The full-loop goal that makes a file attached through (+) File reach the model the way DSH does, with three cycles, a worktree branch, and a deployment verified at the owner's address.
level: L2
status: cycle-0-baseline
grounded_in:
  - owner statement 2026-10-17 asking to implement what DSH does after learning that the upload stores the bytes but the model receives only a path
  - DSH 0.2.0-rc.2 packages under ~/.volta read on 2026-10-17, and the DSH client at http://127.0.0.1:8080 measured the same day
  - heddle at 5b2a586, measured in a browser and from its source on 2026-10-17
---

# Attachments

The owner's job: **implement what DSH does** with a file attached through the composer's `+`. The
previous loop made the upload real — the browser posts the bytes, the server stores them under
`$HEDDLE_HOME/uploads`, and the draft receives the stored path — but the *model* still receives only
that path. DSH's composer keeps pending attachment cards and delivers the file to the model as typed
content: an image for a vision route, a text handle naming the saved read-only copy for any other
file, and a deterministic placeholder when the route is text-only.

This is the loop's memory across goal rounds. A cycle counts only when its block below is filled, its
suite is green, and the owner's address serves this round's build.

## Done is measured

The job is finished when, at `http://127.0.0.1:8082/`:

1. Choosing a PNG through `+ → File` leaves a **pending attachment card** (name, type, size, a ✕ that
   removes it), and the draft is not polluted with a path;
2. sending that draft delivers the image to the provider as **image content** — asserted with a
   provider double that records the exact request body — for a route whose model declares image input;
3. a text-only route receives DSH's **placeholder** for the same image, not an error and not silence;
4. a non-image file is delivered as DSH's **file handle** text naming the stored read-only path and its
   sha256-prefixed identity;
5. `_verifiers_/96-deployment` reports 3 of 3: the live service runs the deployment checkout's
   `dist/cli.js`, the page it serves is that build byte for byte, and the checkout is committed `main`.

Each of 1–4 has a failing-first assertion in `_verifiers_/80-web-ui/check-composer.mjs` (or its
sibling) and a screenshot from the owner's address, not from a spawned copy.

## Instruments

| Instrument | What it measures |
|---|---|
| DSH at `http://127.0.0.1:8080/` | the live reference: `+` menu, pending cards, what the composer sends |
| DSH packages under `~/.volta/.../dsh/node_modules/@deepseek-ai/` | the wire truth: upload route, attachment refs, content projection, limits |
| `~/.dsh/attachments/v1/` | what a real DSH attachment is stored as (content-addressed, normalised images, verbatim files) |
| heddle source in this worktree | the substrate: `src/llm/types.ts`, `src/llm/adapters.ts`, `src/server/page.html`, `src/server/web.ts`, `src/server/uploads.ts`, `src/session/*` |
| `_tools_/browser-use/` via `_tools_/verify-runner/browser.mjs` | a fresh headless browser per check, and the deployed-address probe |
| `_verifiers_/96-deployment/` | the deployment half, read from the installed agent's plist |

## The address the person opens

`http://127.0.0.1:8082/` → a token-supplying gate → `127.0.0.1:3082` → the **deployment checkout**
`/Users/zhenc/heddle-deploy`, whose launchd agent runs `/Users/zhenc/heddle-deploy/dist/cli.js`. The
deployment checkout tracks committed `main` and is never edited in place; after a merge,
`git -C /Users/zhenc/heddle-deploy pull --ff-only origin main`, `npm run build` and
`sh _tools_/web-daemon/install.sh --restart` switch the served build. The revert is the same three
commands at the previous merge commit. A fresh browser profile (or a hard reload) is used for every
delivery measurement.

## Budget

**Three cycles**, each a full research → understand/step-back → plan → implement → deliver → verify →
fix pass; **100 goal rounds** is the hard cap (`max_goal_rounds: 100`, the harness default). A cycle
that ends with a green branch but an undeployed build is a checkpoint; the next round lands it.

## Baseline — measured before cycle 1

### DSH (reference)

- **Composer.** `+` opens a menu whose first entry is `File`; choosing it clicks a hidden
  `<input type="file" multiple>`. A chosen file becomes a **pending card above the editor** —
  `div.JVDQca_item > div.gSkjMW_card[title="<name>"]`, a 28px type icon, `span.gSkjMW_body[aria-label="Pending files"]`
  with the name and `MD 34B`-style type/size meta, and `button.gSkjMW_remove[aria-label="Remove file <name>"]`;
  several files give several cards; the draft text stays untouched (measured 2026-10-17, 1400x900).
- **Upload.** The host route is `POST /api/session/uploadFileBinary?sessionId=…&name=…`, content type
  must be `application/octet-stream`, the body is streamed
  (`dsh-client-file-upload/lib/index.js:18-73`). A base64 RPC path also exists
  (`dsh-attachment/lib/index.js`, `admitEncodedImages`/`admitEncodedFile`).
- **The durable reference.** `ImageAttachmentRef` carries `attachmentId, mediaType, bytes, width, height,
  name?`; `FileAttachmentRef` carries `attachmentId` (sha256 of the bytes), `name`, `bytes`
  (`dsh-attachment/lib/types/types.d.ts:7-52`). Storage is content-addressed under
  `~/.dsh/attachments/v1/` (`request-images/<prefix>` for normalised images).
- **The message.** Model messages carry typed blocks `{type:'image', attachment: ImageAttachmentRef}`
  and `{type:'file', attachment: FileAttachmentRef}` (`dsh-llm/lib/index.js` content helpers).
- **The provider projection** (`dsh-llm/lib/index.js`):
  - non-image files are replaced with a stable **handle** naming the verbatim read-only path and the
    sha256 prefix — `[File "<name>" (<bytes> bytes, sha256:<id>): verbatim read-only copy saved at
    "<path>" …]` (`fileHandleText`, line 614; `projectFilesToText`, line 636);
  - images are sent as image content when the route accepts them, with per-request limits and
    oldest-first offload when over budget (`offloadedImagePrefixCount`, line 692; `offloadedImageText`,
    line 581);
  - a route that declares no image input receives
    `[image omitted because this model accepts text only; attachment sha256:<prefix>]`
    (`projectImagesForTextModel`, line 745; `textOnlyImageText`, line 558);
  - image limits are declared as `maxImageBytes, maxImagesPerMessage, maxMessageImageBytes,
    maxImagePixels, maxImageDimension, mediaTypes` (`dsh-attachment/lib/types/types.d.ts:64-71`).

### heddle (target, baseline)

- **Content vocabulary is text only:** `ContentPart = text | reasoning | tool-call`
  (`src/llm/types.ts:24-27`); no image or file block exists, and every adapter projects only text
  (`toChatMessage`, `src/llm/adapters.ts:231`; the Responses shape maps `input_text`,
  `src/llm/adapters.ts:292-293`).
- **The turn body is a prompt string:** `POST /api/turn` validates `body.prompt` and calls
  `ctx.session.user(handle, prompt)` (`src/server/web.ts:1638-1664`).
- **The composer posts the bytes and receives a path:** `addPickedFiles` POSTs each `File` to
  `/api/uploads?name=…` and inserts the returned path at the cursor
  (`src/server/page.html:5854-5862`); there is no pending-card state.
- **The upload route stores content:** `saveUpload` writes the buffered bytes under
  `$HEDDLE_HOME/uploads` with a 50 MiB ceiling and returns `{path,name,bytes}`
  (`src/server/web.ts` `/api/uploads`, `src/server/uploads.ts:31-95`).
- **What the model sees today:** a plain path string in the user prompt. No attachment store, no typed
  content block, no vision payload, no file-handle convention.

### The gap, in one line

The content already reaches the server; the missing mechanism is the **message layer** from server to
model — an attachment store/ref, a typed user-message block, and the provider projection DSH defines.

## Candidate approach space (to be narrowed by cycle 1's measurement)

1. Keep the verbatim upload and add only the **provider projection**: `/api/turn` carries the uploaded
   file's path+mime; the server reads the bytes at send time and builds an image block for vision
   routes, a DSH-style handle for text routes. No composer change beyond cards.
2. Full DSH shape: content-addressed **attachment store** (sha256 ids, normalised images), attachment
   refs in the session log, and a projection layer; the composer keeps cards and posts ids.
3. Inline everything into the prompt as text/base64 — rejected in advance as token-hostile and unlike
   DSH.
4. Cards only (composer fidelity without model delivery) — rejected: the owner asked for what the model
   receives.
5. Composer-free API attachments (`@path` syntax) — rejected: the job is the `+` File gesture.

Cycle 1 must measure DSH's live message shape and heddle's session/event schema before choosing.

## Cycle 1 — the delivery mechanism

```
Cycle 1 — make the model receive the attachment as typed content, not a path
  measured:   DSH's attachment vocabulary and projection, read from the packages (dsh-llm/lib/types/types.d.ts:61-88,
              dsh-llm/lib/index.js:558-745, dsh-client-file-upload/lib/index.js:18-73, dsh-attachment/lib/types/types.d.ts:7-71);
              the live composer's pending cards re-read at 8080 on 2026-10-17; heddle's content vocabulary
              (src/llm/types.ts:24-27), adapters (src/llm/adapters.ts:231-292, 485-516), turn body
              (src/server/web.ts:1880-1930), context assembly (src/context/service.ts:430),
              request projection (src/llm/types.ts:327-333) and upload store (src/server/uploads.ts:31-95).
  brainstorm: (a) path-based attachment ref in the log + DSH's projection at request time — chosen;
              (b) DSH's content-addressed attachment store with opaque ids — deferred to a later cycle, since the
                  uploads directory already gives a durable read-only path and the model's view is what is missing;
              (c) inline bytes/base64 into the session log — discarded: a 50 MiB file would enter the JSONL;
              (d) send every file as text only — discarded: it is not what DSH does and drops vision;
              (e) composer-only cards without model delivery — discarded: already ruled out by the owner.
  step back:  the gap is a mechanism (typed user-message content + provider projection), not a value; keep the
              objective, narrow cycle 1 to the delivery path (types, projection, adapter mapping, turn body,
              minimal pending cards). Composer fidelity (queue/steer, limits, transcript cards) is cycle 2.
  changed:    src/llm/types.ts — image/file content parts, endpoint inputModalities, sha identity, describeContent;
              src/llm/attachments.ts (new) — DSH's file handle, text-only placeholder, vision materialisation;
              src/llm/service.ts — project attachments before the adapter;
              src/llm/adapters.ts — image parts for chat/responses/anthropic, and a newline between text blocks;
              src/endpoints.ts — carry inputModalities to the page;
              src/server/attachments.ts (new) — a path is read into a typed block, contained to the upload root;
              src/server/web.ts — /api/turn and /steer accept attachment paths, record them, and show them in a
              transcript as named parts;
              src/session/service.ts — userContent() records typed content and titles from the text part;
              src/agent/loop.ts — a turn records its attachments beside the prompt;
              src/server/page.html — pending cards, send/queue/steer carry attachments, live rows name them;
              tests, _verifiers_/80-web-ui/check-composer.mjs, and this document.
  delivered:  landed on main in merge e50b257 (attachments) and deployed on top of the main tip 9eef059, which
              also carries 8631b30 — the missing `ended` return a main-side transcript change had left the build
              red without. The deployment checkout /Users/zhenc/heddle-deploy is at 9eef059 with a clean tree;
              launchd agent PID 61622 runs /Users/zhenc/heddle-deploy/dist/cli.js; the served page is that
              checkout's dist/server/page.html (it contains #attach-cards); _verifiers_/96-deployment is 3/3.
              At http://127.0.0.1:8082/, a fresh browser attached an 80-byte PNG through (+) File: the card read
              `landed-image.png`, `PNG 80 B`, `Remove file landed-image.png`, the draft stayed empty; sending
              recorded a user message whose image block names the same stored path, with the server-measured
              sha256, and the turn completed with the answer "ok". The evidence JSON is
              _context_/add-file/cycle-1-e2e.json, the screenshot cycle-1-landed-8082.png, the script e2e-8082.mjs.
  evidence:   failing first, in order: test/attachments.test.ts (ERR_MODULE_NOT_FOUND, then 10/10);
              test/server-attachments.test.ts (module absent, then 5/5, including the outside-the-upload-root
              refusal and the batch bound); test/page-contract.test.ts (the old page wiring assertion failed
              against the new cards, amended with the card wiring); the composer contract (the pending-card test
              failed while the page still typed a path into the draft; the vision test failed while messages were
              text-only; the text-only and file-handle tests assert the exact recorded provider request body).
              Final: `npx tsc --noEmit` clean, `npm test` 404/404 on the landed tip, the composer verifier 20
              checks with 19 passing and one unrelated load-flake (the stats dock read `0 steps` while the machine
              ran three other sessions' sweeps; it passes alone), 96-deployment 3/3, and the deployed-address run
              above.
  reds:       (1) the stats-dock check flaked under parallel load — not this cycle's code; measured alone, green.
              (2) main did not build at b322aec: web.ts read `result.ended` while the loop never returned it;
              fixed in 8631b30 on main, which this deployment includes. (3) the shared deployment checkout was
              reset by another session between the first merge and its push; the merge was replayed and pushed as
              e50b257 immediately, which is the landing order now recorded in the convention.
  coverage:   visited: image on a vision route (typed parts with a data URL); image on a text-only route (DSH's
              placeholder, no image bytes); non-image file (DSH's handle, contents never sent); missing, unreadable,
              outside-root and directory paths (refused, or degraded to text for a stored image that vanished);
              the batch bound; cards, per-file remove, clean draft; submit, queue and steer carrying paths.
              Not yet visited (cycle 2 candidates): the owner's route does not declare `inputModalities`, so the
              deployed provider received the placeholder — capability discovery is the first fix row; DSH's
              per-message image count/byte budgets and oldest-first offload for earlier images in a long
              conversation; transcript rendering of an attached image as a card; several images in one message;
              editing a queued message that carries attachments.
  invariants: the session log holds references, never file bytes (asserted: no `base64` in the recorded message);
              a text-only route never receives image content (asserted on the provider request); an image reference
              is canonical and contained to the upload root; tool-call and reasoning blocks pass the projection
              untouched; text-only messages keep their existing string wire form.
  landed:     merge e50b257 (attachments), deployment tip 9eef059 (main, includes 8631b30), checkout clean,
              agent PID 61622, 96-deployment 3/3, owner address observed as above.
  lessons:    (1) a shared deployment checkout is not a private one: another session reset it between merge and
              build, so the merge must be pushed before anything is measured, and the landing line names the
              pushed commit rather than the local one. (2) `node --test` against a stale dist hangs on a missing
              module in a test-owned promise; build before running browser checks, and read the path in the
              TypeError. (3) the first deployed E2E picked the newest session row, which was not this run's —
              find the session by the evidence it must contain (the card's path) and read the newest user message
              from it.
```

## Cycle 2 — capability discovery and the request image budget

```
Cycle 2 — a vision route is found by what it publishes, and a request's images are bounded the way DSH bounds them
  measured:   DSH declares input modalities per model in its provider catalog and defaults an undeclared model to
              text (dsh-llm-deepseek/lib/index.js:46,274,303,349-371; dsh-llm-pi-ai/lib/index.js:1806,1825), and
              bounds one request's images instead of failing it: `requiredImageOffload`/`offloadedImagePrefixCount`
              remove the oldest occurrences until the encoded bytes and count fit (dsh-llm/lib/index.js:692-745),
              replacing each with `offloadedImageText` — `[image omitted to fit request image limits; <identity>. ...]`
              where identity is `"name" (sha256:<hex>)` (dsh-llm/lib/index.js:538-548,571-584).
              The owner's providers publish the fact heddle was not reading: on 2026-10-18, plugboard-d's model list
              says deepseek-flash `input_modalities:["text","image"]` and deepseek-v4-pro `["text"]`; plugboard-x says
              gpt-6.1-sol `["text","image"]`; anthropic-vertex publishes no model list at all. heddle already carries a
              declared `inputModalities` per endpoint (cycle 1) but nothing discovers it, and a request has no image
              budget. Measured at the owner's address before the change: a solid-red PNG attached through (+) File
              produced the answer `NO IMAGE` — the provider had received DSH's text placeholder — while the same
              provider answers `red` when the same image is sent as image content (direct wire probe, 2026-10-18).
  brainstorm: (a) discover modalities from the provider's own model list, cached per endpoint+model, with the declared
                  configuration winning — chosen: it is a declaration the provider publishes, not a guess;
              (b) declare `inputModalities` in the machine's ~/.heddle/heddle.json for these three routes — kept only as
                  the explicit override it is; on its own it fixes one machine and leaves the mechanism missing;
              (c) infer vision from the model's name (deepseek-flash is vision-capable, deepseek-v4-pro is not) —
                  discarded: a name is not a declaration, and the same rule would send images to a text-only model;
              (d) copy DSH's per-provider catalog table into heddle — discarded for now: the table would drift from
                  the provider that already publishes the fact in its model list;
              (e) declare every Anthropic route vision-capable because Claude models accept images — discarded: the
                  publisher route publishes no per-model fact, so the honest path there is configuration.
              Budget: (a) DSH's oldest-first offload with deterministic placeholders — chosen; (b) refuse a turn that
              exceeds the budget — discarded: DSH offloads rather than failing a person's message; (c) no budget —
              discarded: a conversation that keeps attaching images would grow the request without bound.
  step back:  still a mechanism, not a value: the capability source is a learned fact, and the budget is a rule about
              a whole request rather than one message. The objective is unchanged; cycle 2 adds these two rows and
              leaves the transcript card, several-image UX and queue edits for cycle 3.
  plan:       src/llm/model-info.ts — one cached model-list read shared by the context-window and modality readers,
              with a parser for the field spellings providers use (`input_modalities`, `inputModalities`,
              `modalities` array/object, `architecture.input_modalities`);
              src/llm/service.ts — resolve the endpoint lazily, only when a request carries an image and the endpoint
              declares nothing; the declared configuration always wins;
              src/llm/attachments.ts — the request budget: count and encoded-byte ceilings, oldest-first offload with
              DSH's placeholder;
              tests written first for the parser, the discovery, the configured-override rule and the budget;
              _verifiers_/80-web-ui/check-composer.mjs — a vision route that only *publishes* its modalities and a
              text-only one that publishes `["text"]`, both without configuration;
              the deployed address — the same red-square probe answers a colour after the change.
  changed:    src/llm/model-info.ts — one cached model-list body shared by the context-window and modality
              readers, with the modality parser and the rule that a failed read is not cached;
              src/llm/service.ts — lazy capability discovery for image-bearing requests (declared configuration
              wins; a successful answer is cached, a failed one is retried), and withDiscoveredModalities();
              src/llm/attachments.ts — the request image budget (20 images / 20 MiB encoded), oldest-first
              offload with DSH's deterministic placeholder;
              test/model-info.test.ts, test/attachments.test.ts, test/model-discovery.test.ts — failing-first
              tests for the parser, discovery, override, budget and the retry;
              _verifiers_/80-web-ui/check-composer.mjs — two published-modality checks (a discovered vision
              route and a published text-only route), both without any configuration.
  delivered:  landed on main as merge 56e9b69 (the retry fix f0168d4/354c9cf included) and deployed from
              /Users/zhenc/heddle-deploy with the launchd agent running that checkout's dist/cli.js (PID 16271
              at the time of the measurement); _verifiers_/96-deployment is 3/3. At http://127.0.0.1:8082/ the
              same red-square probe that answered `NO IMAGE` before the change answered `red` twice in a row
              (cycle-2-after.json), and the composer path showed `red-square.png`, `PNG 132 B`, a clean draft,
              the same stored path recorded as the message's image block, and the answer `red`
              (cycle-2-e2e.json, cycle-2-landed-8082.png).
  evidence:   failing first: the new unit tests failed on the missing exports; the published-vision browser
              check failed with `[image omitted because this model accepts text only; ...]` in the recorded
              provider request until the stream resolved the discovered modalities; the retry test failed on
              its second turn until both caches stopped remembering a failed read. Unconfigured discovery is
              covered in both shapes the providers use (chat and responses) and both answers (image and text).
              Final: `npx tsc --noEmit` clean, `npm test` 415/415, the full composer verifier 22/22, and
              96-deployment 3/3; the before/after probes are the files beside this document.
  reds:       (1) the merge of the two sessions' `ended` changes produced duplicate identifiers, so main did not
              build; fixed in f0168d4 on main by keeping the later documented field and one write per place.
              (2) the shared deployment checkout was written by another session's install.sh between merge and
              measurement, so 96-deployment caught the agent running the shared checkout's cli; the deploy
              checkout's install.sh and a check of the plist + live PID restored it — the race is real and the
              verifier is what sees it. (3) the deployed address itself found a code red: after one transient
              /models failure the endpoint was remembered as text-only and every later image turn got the
              placeholder (probe answered NO IMAGE repeatedly); fixed in 354c9cf by caching only an answer, and
              the deployed probe then answered `red` twice.
  coverage:   visited: discovery for chat and responses rows; the declared configuration winning; the parser's
              field spellings; a failed read degrading to text and being retried; a successful read being
              reused; count budget and byte budget; oldest-first order; a text-only route never receiving an
              offload; files untouched; the deployed address before and after.
              Not yet visited (cycle 3): transcript cards for an attached image, several images in one message,
              editing a queued message that carries attachments, per-model budget declarations.
  invariants: the declared configuration wins over discovery; a text-only route never receives image content; a
              failed capability read never fails the turn and is retried; a successful one is read once per
              endpoint; the budget is deterministic for the same request and replaces only image parts; the
              stored reference and its digest are unchanged by offloading.
  landed:     merge 56e9b69 (main; includes f0168d4 and 354c9cf), deployment checkout /Users/zhenc/heddle-deploy
              built and served, agent PID 16271, 96-deployment 3/3, owner address answered `red` for the
              red-square probe and through the composer path.
  lessons:    (1) a capability lookup is not a value to remember when it fails: at the owner's address one
              provider hiccup silently disabled images for the life of the process, and only the address showed
              it. (2) the deployment checkout is shared; another session's install.sh can repoint the agent
              between merge and measurement, so measure the plist and the live PID, not the intent. (3) two
              sessions fixing the same red produced duplicate identifiers on main — verify the landed main with
              tsc, not only the branch.
```

## Cycle 3 — the transcript and queue carry the file, not a marker

```
Cycle 3 — an attached file is visible where a person reads it, and several files survive the queue
  measured:   DSH's historical message images (dsh-client-ui-attachment/lib/client.js:691-897): a wrapping
              gallery (gap 10px, flex-start/end alignment), a lone image at a 240px long edge with its aspect
              clamped to [0.25,4] and never upscaled, several images as 64px tiles, a 48px thumbnail variant, a
              zoom-in frame that opens a lightbox, a loading state and a retryable load failure, and labels
              ("Image", "View original"). DSH's queue dock rows carry the queued message's own attachments: 24px
              image thumbnails and 180×24 file chips with a 16px icon, a 13px name and a 10px size, in a strip
              capped at 55% of the row (dsh-client-ui-conversation/lib/client.js:15215).
              heddle today: the transcript shows `[image name]` / `[file name]` text — cycle 1's honest minimum —
              and there is no route that serves an upload's bytes, so a thumbnail is impossible; the queue row
              shows only `· N files`; several images already reach the provider (projection and budget carry
              them) but no check proves it; the queue editor preserves an item's attachments because they live
              on the item, but nothing shows that, so an edit looks like it might drop the image.
  brainstorm: (a) a dedicated read-only `GET /api/uploads/<leaf>` (contained to the upload root, inline only for
                  embeddable bytes, token-gated like every route), structured attachment metadata on the
                  transcript turn, and a gallery on the user row plus a small queue strip — chosen;
              (b) embed data URLs into the transcript JSON — discarded: one reloaded conversation would carry
                  megabytes per image, and the page already has a URL to fetch;
              (c) serve uploads through the existing `/api/raw` workspace route — discarded: an upload may live
                  outside any registered workspace, and the route's containment rule is the wrong one; the upload
                  root is the directory that owns these bytes;
              (d) keep the cycle-1 name markers — discarded: DSH shows the image and opens the original, and the
                  owner's reference is the contract;
              (e) render the queue's thumbnails by parsing the stored path in the page — discarded: the page would
                  re-derive name and size the server already measured; the queued item carries them.
  step back:  still a mechanism, not a value: a serving route, a structured fact on the turn, and the presentation.
              The objective is unchanged; cycle 3 also closes the checks the earlier cycles left open — several
              images in one message, the queue's attachment survival across an edit, and the full matrix at the
              owner's address.
  plan:       src/server/web.ts — `GET /api/uploads/<leaf>` (upload-root containment, inline types only, no
              directory listing), and user transcript turns carry `attachments` (name, kind, media type, bytes,
              url) instead of only text markers;
              src/server/page.html — the DSH gallery on a user row (lone 240px / several 64px tiles, dialog
              lightbox, alt text), a queue strip with 24px image thumbs and file chips, and the composer's queue
              items carry the measured file facts so editing cannot lose them;
              tests written first: the transcript fold's attachment metadata, the serving route's containment,
              the browser matrix (sent image card, two images as two tiles and two wire parts, queued image
              survives an edit and still reaches the provider), and the deployed address with two images.
  changed:    pending — the cycle is at its plan.
  delivered:  pending.
  evidence:   pending.
  reds:       none yet.
  coverage:   to visit: the uploads route (a real file, a traversal attempt, an unknown leaf), lone vs several
              images, the lightbox, a file chip, the queue strip, an edited queued message, and the owner's
              address with two images.
  invariants: a served upload is contained to the upload root; a non-embeddable type is served as a download;
              the transcript remains usable when an upload was deleted (the card shows a failed state, the turn
              still reads); the queue carries the same measured facts as the composer; sending an image never
              changes its stored bytes.
  landed:     pending.
  lessons:    pending.
```

## Cycle status

| Cycle | Aim | Phase | Evidence committed | Landed |
|---|---|---|---|---|
| 1 | delivery mechanism: typed user content + DSH projection + provider mapping + pending cards | completed | test/attachments.test.ts, test/server-attachments.test.ts, check-composer (5 attachment checks) | e50b257, deployed at 9eef059 |
| 2 | capability discovery so a vision route receives image content; DSH's image budgets/offload | completed | test/model-info.test.ts, test/model-discovery.test.ts, check-composer (2 published-modality checks) | 56e9b69, deployed and observed |
| 3 | transcript and queue carry the file; several images; queue-edit survival; full matrix at the owner's address | implement in progress | — | — |

## Read next

[`../../_skills_/full-loop-goal/INDEX.md`](../../_skills_/full-loop-goal/INDEX.md) for the procedure this
document follows; [`../landed-and-deployed/INDEX.md`](../../_conventions_/landed-and-deployed/INDEX.md) for
the landing rule; [`../../_context_/dsh-browser-mcp/REPORT.md`](../../_context_/dsh-browser-mcp/REPORT.md)
for the browser driver the measurements use.
