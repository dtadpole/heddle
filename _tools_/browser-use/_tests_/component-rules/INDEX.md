---
title: Browser Use Component Rules
version: 1.2.0
description: The rules the browser tool's helpers implement, judged without a browser, Chrome's command line and the bounded DevTools handshake among them.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-17, separating component tests from delivery verifiers
---

# `component-rules`

Instance of [`_tests_`](../INDEX.md). Holds [`unit.test.mjs`](unit.test.mjs), the browser tool's
**component suite**: the frame codec, the key names, the viewport and geolocation syntax, the snapshot's
text form, pagination, the console and network formatters, the session-directory rule, and the coverage
claim against the DSH advertised surface.

## Run it

```bash
node --test _tools_/browser-use/_tests_/component-rules/unit.test.mjs
```

## What it does not judge

- **What the tools do to a page.** That is the delivery claim in
  [`_tools_/browser-use/_verifiers/`](../../_verifiers/INDEX.md), which drives a real browser and keeps
  the project's verdict contract.
- **The surface's behaviour.** The coverage test asserts which tools exist, not that they work.

Chrome's command line is tested without a browser: every start, headless or windowed, passes
`--disable-default-apps`, and the caller's own flags come last. Without it a fresh profile downloads Google
Docs Offline and Chrome Web Store Payments into the user TMPDIR, and a killed browser leaves each download
there as a hidden `.com.google.Chrome.XXXXXX` file (30,000 of them, 5.3 GiB, by 31 October 2026).

Chrome output cleanup is tested without a browser: `releaseChromeOutput` destroys only this launch's
read streams and does not signal unrelated processes. A helper retaining inherited descriptors must
not keep a finished verifier alive.

The DevTools handshake is tested against a local socket that plays a busy or dying Chrome: one that takes
the connection and never answers must make `connect` reject within its bound, one that hangs up first must
make it reject at once, and `stopChrome` against the first must reach SIGTERM within seconds. A listening
socket completes a TCP connect whether or not the browser reads it, so before the bound a wedged browser
held `connect` — and the `stopChrome` that connects before it signals — forever.
