---
title: Browser Use
version: 1.0.0
description: A browser this repository drives over the Chrome DevTools protocol, with the harness browser's tool surface, one command per tool and one long-lived session behind them.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-17, asking for a browser tool under _tools_ that replicates the DSH browser MCP
  - source: owner statement in the dsh session, 2026-10-17, choosing the name browser-use
  - source: the DSH browser MCP as configured in the web profile, read on 2026-10-17
  - source: the reading recorded in _context_/dsh-browser-mcp
---

# `browser-use`

Instance of [`_tools_`](../INDEX.md). Holds a **browser an agent or a check can drive**: a
dependency-free Chrome DevTools Protocol client, the tool surface the harness's browser exposes, and a
command line that keeps one browser alive between commands.

The name is the owner's choice (2026-10-17) and is unrelated to the third-party project that happens to
share it: this is this repository's own driver, and everything here was written against the protocol.

## Why it exists

The harness's browser tools are one long-lived MCP server: a page is opened, snapshotted, clicked and
its console read, and every call is about the same browser. This repository had a **read-only** browser
helper — enough to prove a page rendered — and no way to *act*: to fill the composer, click a control,
follow what the page logged, or look at the request it made. That is the difference between judging
that a page appears and judging that it works.

The tool is deliberately modelled on the harness's own browser tools, so a model that has used them
needs no new vocabulary: the same `take_snapshot` with `uid`s, the same `click`/`fill`/`drag`, the same
`list_console_messages` and `list_network_requests`. What it is not is a copy of the server: the
mechanism here is the protocol itself, and the reading that grounds the surface is beside this
repository in [`_context_/dsh-browser-mcp/`](../../_context_/dsh-browser-mcp/INDEX.md).

## What belongs in it

| File | What it is |
|---|---|
| [`cdp.mjs`](cdp.mjs) | the WebSocket client and the protocol envelope — fragmented frames, pings, error replies, sessions |
| [`chrome.mjs`](chrome.mjs) | finding, starting and stopping Chrome; the profile it keeps; the no-sandbox retry |
| [`page.mjs`](page.mjs) | one page — navigation, execution contexts, dialogs, console and network collection, screenshots |
| [`browser.mjs`](browser.mjs) | the browser and its pages, attached flattening, page ids and browser contexts |
| [`snapshot.mjs`](snapshot.mjs) | the accessibility snapshot, the uid contract, and the text form |
| [`actions.mjs`](actions.mjs) | click, fill, type, press, hover, drag, upload, dialogs, script evaluation |
| [`emulate.mjs`](emulate.mjs) | viewport, colour scheme, media features, network conditions, geolocation, CPU throttling |
| [`format.mjs`](format.mjs) | the text forms — pages, console messages, network requests, pagination |
| [`tools.mjs`](tools.mjs) | the tool table: one handler per tool, the surface the CLI and the host share |
| [`host.mjs`](host.mjs) | the session host — one browser, one socket, commands serialized |
| [`client.mjs`](client.mjs) | the command side — is a host alive, start one, call a tool, stop it |
| [`lib.mjs`](lib.mjs) | the library face, including the one-page API the repository's checks use |
| [`cli.mjs`](cli.mjs) | the command line |
| [`_tests_/component-rules/`](_tests_/component-rules/INDEX.md) | the **component tests** — frame codec, keys, viewport syntax, snapshot text, pagination, the tool table |
| [`_verifiers_/`](_verifiers_/INDEX.md) | the claims this tool must keep, one folder each, checked against real browsers |

## Run it

```bash
node _tools_/browser-use/cli.mjs start            # a visible browser, kept open for later commands
node _tools_/browser-use/cli.mjs new_page '{"url": "https://example.com"}'
node _tools_/browser-use/cli.mjs take_snapshot
node _tools_/browser-use/cli.mjs click '{"uid": "1_3"}'
node _tools_/browser-use/cli.mjs take_screenshot '{"fullPage": true}'
node _tools_/browser-use/cli.mjs stop
```

Any tool call starts the session when none is running; `start` is only needed when the first call
should be able to be watched from the beginning. Arguments are one JSON object or `--name=value` pairs.
`cli.mjs tools` lists the surface and the tools it deliberately does not replicate.

From the library, `openPage()` is the one-browser-one-page shape the verifiers use, and
`openBrowser()` plus `createTools()` is the session shape the CLI uses — both run this same driver, so
a check that passes through `openPage` has exercised what the command line runs.

## Using it in heddle

There are three ways this tool is used, and they share the one driver:

| Who | How | Why that way |
|---|---|---|
| a **check or verifier** | import the one-page wrapper, [`_tools_/check-helpers/browser.mjs`](../check-helpers/browser.mjs): `openBrowser()` returns `goto`, `evaluate`, `waitFor`, `screenshot`, `close` | the wrapper opens a browser and a temporary profile per call, headless by default, so a check that opens a window steals no focus and leaves no login behind |
| a **person** | the command line, `node _tools_/browser-use/cli.mjs …` | headed by default, one browser kept between commands, a snapshot's uids drive the next click |
| an **agent in a heddle session** | the same command line, through the shell (`bash`), or the library imported from a script | the tool is **not registered as a heddle tool**: it is repository tooling, not part of the shipped harness. An agent that needs it runs it, and `cli.mjs tools` is how it discovers the surface |

A check that needs a page looks like this — the pattern every browser check in `_verifiers_/` follows:

```js
import { browserAvailable, openBrowser } from '../../_tools_/check-helpers/browser.mjs'

const browser = await openBrowser({ width: 1400, height: 900 })
try {
  await browser.goto(server.url)
  assert.ok(await browser.waitFor('document.getElementById("prompt") !== null', 20_000), 'the page is up')
  await browser.evaluate('document.querySelector("#send").click()')
} finally {
  browser.close()
}
```

**Prerequisites and state.** The only requirement is Chrome or Chromium: discovery tries the usual
locations, and `HEDDLE_BROWSER=/path/to/chrome` names one that is elsewhere. Nothing is installed by
npm. The profile and the session record live under `.heddle-tmp/browser/` in this checkout;
`HEDDLE_BROWSER_HOME` moves them, and removing the profile forgets every login. `cli.mjs status` says
what is running, `cli.mjs stop` ends it.

**Watching it work.** The command line is headed by default, so a person can watch and sign in; a check
is headless by default. The tool's own surface verifier runs headed with
`HEDDLE_BROWSER_HEADED=1 _tools_/browser-use/_verifiers/browser-surface/verify.sh`, and a library caller
asks for a window with `openPage({ visible: true })`.

**Two agents at once.** Give each a session name: `cli.mjs --session=NAME …` or
`HEDDLE_BROWSER_SESSION=NAME`. Each gets its own browser, profile and tabs, so neither can name the
other's pages.

## The decisions worth knowing

- **A browser per session.** `--session=NAME` (or `HEDDLE_BROWSER_SESSION`) gives the commands a
  browser, profile and set of tabs of their own, under `.heddle-tmp/browser/sessions/NAME/`. Two
  agents driving a browser at once are then two sessions rather than two writers of one `list_pages`,
  and the page ids one session hands out never name a page in the other. Within one session,
  `new_page`'s `isolatedContext` gives a clean-slate tab (cookies and storage apart) without a second
  browser.
- **A session, not a launch per command.** Console messages and network requests are events that only
  exist while someone is listening, so a command that attaches, acts and detaches would see an empty
  history. The host is a small detached process that owns the connection; commands talk to it over a
  Unix socket and are serialized.
- **Headed by default.** The point of a browser here is partly that a person can watch it and sign in
  once, and the profile persists under `.heddle-tmp/browser/` (`HEDDLE_BROWSER_HOME` moves it). A
  login done in the visible window is reused by every later call. `start --headless` for a machine
  with no seat.
- **The uid contract.** `take_snapshot` numbers the accessibility tree; `click`/`fill` resolve a uid
  to the DOM node the snapshot read. Uids survive further snapshots of the same document and die with
  a navigation, because the elements they named are gone. A stale uid is refused, never guessed.
- **An action is a person's action.** A click is a real mouse event at the element's centre after
  scrolling it into view; a fill goes through the input prototype's setter and fires `input`/`change`,
  because `element.value = …` leaves a framework's state stale.
- **The no-sandbox retry.** A machine whose outer confinement forbids Chrome's own sandbox gets a
  second start with `--no-sandbox`, and `status` says which start it was. Silently weakening a browser
  would be wrong; failing on every confined machine would be useless.

## Coverage of the DSH browser surface

The harness profile advertises **32 tools** from `chrome-devtools-mcp`. The tool replicates the
protocol-callable ones and names the rest rather than leaving them to be discovered.

| Group | State |
|---|---|
| pages, navigation, interaction, screenshot, script, console, network, emulation | **implemented** (24 tools) |
| `get_css_styles` | **implemented** — `CSS.getMatchedStylesForNode`, with the pagination the DSH tool always applies |
| `take_heapsnapshot` | **implemented** — the `HeapProfiler` stream, written as a `.heapsnapshot` file |
| `screencast_start`, `screencast_stop` | **implemented** — `Page.startScreencast` frames written as JPEGs, acknowledged per frame |
| `performance_start_trace`, `performance_stop_trace` | **implemented** — `Tracing` events written as the file the Performance panel opens, with a summary |
| `lighthouse_audit` | **excluded** — it is the Lighthouse engine, not a protocol call; running it means shipping or requiring Lighthouse, which this tool deliberately does not |
| `performance_analyze_insight` | **excluded** — it interprets a trace with the DevTools frontend's insight model; the trace is captured by the start/stop tools, the analysis is not a protocol call |

**Measured coverage: 30 of the 32 advertised tools implemented, 2 named as excluded**, and the
component test `every advertised DSH tool is implemented or named as excluded` fails if that stops
being true.

`click_at` is implemented as well although DSH advertises it only under `--experimentalVision`.

## Component tests and delivery verifiers

The two kinds of check are kept apart, and the split is a rule rather than a filing decision.

- **`_tests_/component-rules/` is the component suite.** It runs with no browser and no session: the frame codec,
  the key names, the viewport syntax, the snapshot's text form, pagination, and the table of tools. A
  rule that can be stated about one function belongs here, because it is fast, deterministic, and can be
  read next to the function it judges.
- **`_verifiers/` holds the delivery claims.** They open a real browser or drive the command line, they
  are judged with the project's `0`/`1`/`3` contract, and each states the surface it needs. A verifier
  answers "does the delivered tool do what it promises when someone uses it", not "is this helper
  right".

The boundary is: **a static fact about the code (a list of names, a parser's output) is a component
test; a fact about a browser, a page, or a command boundary is a delivery claim.** Keeping the two
apart is what stops a verifier from certifying a delivery on the strength of a table lookup, and stops
a component suite from being mistaken for evidence that the tool works.

## How it is checked

The verifiers live beside the tool, in [`_verifiers_/`](_verifiers_/INDEX.md), because they judge the
tool rather than heddle's ultimate goal:

```bash
node --test _tools_/browser-use/_tests_/component-rules/unit.test.mjs          # no browser
_tools_/browser-use/_verifiers/browser-surface/verify.sh                      # headless
_tools_/browser-use/_verifiers/browser-session/verify.sh                      # headless
HEDDLE_BROWSER_HEADED=1 _tools_/browser-use/_verifiers/browser-surface/verify.sh   # watch it
```

Each serves its own fixture page on loopback, so a run spends nothing and needs no network. They judge
the claims a demo hides: that a uid is the element the next click hits, that a fill reaches a
framework's state, that a dialog blocks the tools that must not run through it until it is answered,
that a console message and a network request survive a command boundary, that a screenshot is a real
image, and that a navigation invalidates the uids of the page it left. Each verifier's index states
whether it runs headless or headed.

## Read next

[Browser modes](../../../reflection/shared/_conventions_/core-conventions/browser-modes.md) for when this
tool runs headed and when headless, [`_context_/dsh-browser-mcp/`](../../_context_/dsh-browser-mcp/INDEX.md) for the reading of the surface
this mirrors, [`_verifiers_/INDEX.md`](_verifiers_/INDEX.md) for the claims it must keep,
[`../check-helpers/INDEX.md`](../check-helpers/INDEX.md) for the one-page wrapper the heddle verifiers
import, and [`../../_verifiers_/INDEX.md`](../../_verifiers_/INDEX.md) for those heddle claims.
