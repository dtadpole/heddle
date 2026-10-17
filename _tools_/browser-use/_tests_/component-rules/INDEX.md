---
title: Browser Use Component Rules
version: 1.0.0
description: The rules the browser tool's helpers implement, judged without a browser.
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
