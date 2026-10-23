---
title: Live health
version: 1.1.0
description: The monitor's pass over the team's live address — the gate on 8082, the deployed server's token door on 3082, the build marker, a streamed turn, a clean console, and the DSH reference — run every 20 minutes and pinned in _context_/rust-port/.
grounded_in:
  - source: [hd] Live Monitor responsibilities, 2026-10-22, "drive 127.0.0.1:8082 with browser-use on a schedule, pin evidence, alert the owners of what breaks"
  - source: heddle-web-gate INDEX (dsh-web-ops), measured 2026-10-22, which names 8082 as the gate over heddle's 3082 and ~/.heddle/web.log as the token source
  - source: _verifiers_/90-web-ui-token and _verifiers_/96-deployment, the claims the pass reuses rather than restates
---

# `live-health`

Instance of [`_tools_`](../INDEX.md). **One pass per invocation** over the deployment the team shows:
`http://127.0.0.1:8082/`. It judges the four things the owner asked the monitor to judge — load with
the token, the build marker, a streamed turn, a clean console — and records the DSH reference beside
them. It is the monitor's instrument, not a verifier: a verifier asks whether a claim holds, this asks
**whether the deployment is healthy right now**, and it answers with numbers a person can act on.

## What answers on 8082, measured

`8082` is the **heddle Web Gate**, an operator tool outside this repository (dsh-web-ops), not one of this
team's. It
holds no page of its own: it reads the deployment's current launch token from `~/.heddle/web.log`,
exchanges it for heddle's authority-bound cookie, and forwards to the deployed server on **3082**. So
the pass judges two doors, because they fail differently:

| Door | What it must answer | Where the failure shows |
|---|---|---|
| gate `8082` | the app shell | `502` and `heddle-proxy: the upstream did not answer` when the deployment is down — the page the owner would see |
| server `3082` | `401` + token form bare; `303` + `HttpOnly SameSite=Strict` cookie with the current token | a heddle that is up but not behind its token door |

The token is **read from the same log the gate reads** (`~/.heddle/web.log`, mode 600, the last
`heddle web: http://…?token=…` line). That is deliberate: it is the credential the owner's own URL is
served with, it needs no file of its own, and it never lands in the deployment checkout (which
`96-deployment` requires to stay clean).

## The checks

| Check | The claim | How it is read |
|---|---|---|
| `gate` | `8082/` serves the app shell | HTTP status and body; a proxy error keeps the gate's own sentence |
| `door` | the deployed server refuses a bare request and exchanges the current token | `fetch` with `redirect: 'manual'`, cookie flags read by hand |
| `load` | the app renders in a real browser through the gate | `#log`, `#prompt textarea`, `#send` must exist |
| `marker` | the served page is the deployment checkout's build | served `meta[name=heddle-page]` vs the first 12 hex of the sha256 of `~/heddle-live/dist/server/page.html`; HEAD vs `origin/main` is staleness, recorded not failed |
| `turn` | one short turn streams | trusted `click_at` + `type_text` into the composer, then the deployment's own `assistant/chunk` count for that prompt and the page's assistant-row lengths as they grow; a scripted answer that lands between two DOM polls is judged by the chunk count, not by what a poll happened to see |
| `console` | the console is clean | error-level messages fail; warnings and verbose kept; read on load **and** after the turn |
| `dsh` | the reference is the reference | `127.0.0.1:8080/`: title, `window.__DSH_BOOT__` keys, composer, console errors |

Exit `0` pass, `1` fail, `3` unjudged. A **dead address is a failure**, not an unknown: a live
deployment that stops answering is exactly what the monitor exists to catch. `3` is for a check that
cannot be decided even though the deployment answered — no built page to compare the marker against, or
a console that cannot be read. A pass that could not be judged is never pinned as healthy.

## The rules, and their tests

The judgments are pure functions in [`rules.mjs`](rules.mjs): the door (`doorVerdict`), the gate
(`gateVerdict`), the shell (`shellVerdict`), the marker (`markerVerdict`), the console
(`consoleVerdict`), the turn (`turnVerdict`), the pass (`passVerdict`), the launch-URL reader and the
argument parser. They take numbers and strings and decide what the reading means, which is why they can
be tested without a browser:

```bash
node --test _tools_/live-health/_tests_/pass-rules/unit.test.mjs
```

The reading itself — a real page, a real deployment — stays an integration step. `probe.mjs` does the
reading and calls these rules; a rule that is wrong fails a test before it can fail a quiet deployment.

## What the pass leaves alone

- **One health session, not one per pass.** A turn creates a session in the deployment's store, so the
  pass continues the newest session whose title starts with `live health check` (`--turn` only; the
  tree row is clicked when it is drawn, and the page's own `showSession` selects it when the tree does
  not). Only a deployment with no health session yet gets a new one.
- **No session ids and no home paths in the record.** The repository is public: the pinned JSONL
  states paths under `~` and never a session id, and both are checked by the repository's
  public-hygiene gate before main.
- **The browser is closed at the end of every pass** (`--keep-browser` is for a debugging session):
  this Mac runs twelve seats on 16 GB, and a browser left open is the swap the coordinator measured.

## Run it

```bash
_tools_/live-health/probe.mjs                 # summary, exit 0/1/3
_tools_/live-health/probe.mjs --json --pin    # append the pass to _context_/rust-port/live-health.jsonl
_tools_/live-health/probe.mjs --no-turn       # do not spend a turn (a scripted endpoint makes one free)
```

It drives `_tools_/browser-use` as a **library** in this seat's own headless session
(`hd-live-monitor`), not as a shell command, so the same browser and its console history serve every
call of one pass. `--json` prints the whole record; `--pin` appends it to the JSONL; `--no-turn` judges
the page without spending a turn; `--keep-browser` leaves the browser open for a debugging session. It reads `~/heddle-live` and `~/.heddle/web.log`; it writes nothing into either, and
the only file it writes is the pinned JSONL in this seat's worktree.

## Pinned results

`_context_/rust-port/live-health.jsonl` — one JSON object per pass, append-only, and
`_context_/rust-port/live-health.md` reads the current state of the deployment from it. This tool's own
runs are not a substitute for the record: the record is the file.

## Read next

[`_context_/rust-port/live-health.md`](../../_context_/rust-port/live-health.md) for the pinned state;
[`../browser-use/INDEX.md`](../browser-use/INDEX.md) for the driver;
[`../../_verifiers_/96-deployment/INDEX.md`](../../_verifiers_/96-deployment/INDEX.md) and
[`../../_verifiers_/90-web-ui-token/INDEX.md`](../../_verifiers_/90-web-ui-token/INDEX.md) for the
claims the marker and door checks reuse.
