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

## Cycle status

| Cycle | Aim | Phase | Evidence committed | Landed |
|---|---|---|---|---|
| 1 | measure DSH's message shape and heddle's substrate; choose the smallest delivery mechanism | not started | — | — |
| 2 | close the fidelity gaps cycle 1 measured (pending cards, placeholders, limits) | pending | — | — |
| 3 | full matrix re-measure at the owner's address; stop when no fix row remains | pending | — | — |

## Read next

[`../../_skills_/full-loop-goal/INDEX.md`](../../_skills_/full-loop-goal/INDEX.md) for the procedure this
document follows; [`../landed-and-deployed/INDEX.md`](../../_conventions_/landed-and-deployed/INDEX.md) for
the landing rule; [`../../_context_/dsh-browser-mcp/REPORT.md`](../../_context_/dsh-browser-mcp/REPORT.md)
for the browser driver the measurements use.
