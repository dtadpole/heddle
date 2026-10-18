---
title: DSH Browser MCP
version: 1.1.0
description: A reading of how DeepSeek Harness exposes the Chrome DevTools MCP server as browser tools, taken from the installed packages.
grounded_in:
  - source: chrome-devtools-mcp 1.11.0 under ~/.npm/_npx/15c61037b1978c83, read on 2026-10-17
  - source: dsh-mcp-client 0.2.0-rc.2 under ~/.volta, read on 2026-10-17
  - source: the live profile at ~/.dsh/profiles/web/cordis.patch.yml, read on 2026-10-17
---

# `dsh-browser-mcp`

**Status: the server this folder reads was removed from the Web profile on 2026-10-17.** The harness's
browser tools were replaced by [`_tools_/browser-use/`](../../_tools_/browser-use/INDEX.md) once that
tool had been verified against the same surface (30 of 32 advertised tools implemented, 2 named as
excluded, delivery verifier 26/26 headed and headless). This reading is kept because it is what the
tool was built and judged against, and because a future version of either needs the same evidence.

Instance of [`_context_`](../INDEX.md). Holds the reading behind the browser tool surface
this harness mirrors: how a page is identified and selected, how the accessibility tree
becomes uids an action can name, what each of the 67 tools takes and returns, and which
parts are plain Chrome DevTools Protocol rather than Puppeteer, the DevTools frontend or
Lighthouse.

## What belongs in it

- [`dsh-browser-mcp.md`](dsh-browser-mcp.md) — the complete tool inventory under the DSH configuration
  (32 advertised of 67 defined), page identity and page ids, the accessibility snapshot and
  its uid contract, every interaction and observation tool, emulation, pagination and
  truncation limits, the error-message conventions, the DSH `mcp__browser__<tool>` bridge,
  and an honest feasibility note per capability for a dependency-free CDP driver.

The report is **gathered, not authored**: it quotes or cites the installed JavaScript
(`file:line`) and does not state what this project should build. The conclusions belong in
the code and in [`_verifiers_/`](../../_verifiers_/INDEX.md); a reading that disagrees with
them is evidence that one of the two is wrong.

## Versions read

| Source | Version |
|---|---|
| `chrome-devtools-mcp` | 1.11.0, built under `build/src/`, bundling Puppeteer 25.14.0, the DevTools frontend models and Lighthouse 13.5.0 |
| `@deepseek-ai/dsh-mcp-client` | 0.2.0-rc.2 |
| DSH profile row | `mcp-browser` in `~/.dsh/profiles/web/cordis.patch.yml`, command `npx -y chrome-devtools-mcp@1.11.0 --userDataDir=...` |

The package ships no tests or snapshot fixtures, so response shapes in the report are
read from the formatters and the response builder rather than from recorded transcripts.

## Read next

[`dsh-browser-mcp.md`](dsh-browser-mcp.md) for the material; [`../INDEX.md`](../INDEX.md) for the `_context_`
type and its two rules (record the version, keep the material whole); and
[`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts this reading grounds.
