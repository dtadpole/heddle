---
title: Heddle in Rust — Ultimate Goal
level: L2
version: 0.1.0
description: What completes the Rust port of Heddle — one Rust binary that is the same harness the TypeScript build is, judged by the same verifiers through the HEDDLE_BIN seam, with the Web UI checked in a real browser and compared with DSH.
status: unverified
grounded_in:
  - source: owner statement in the dsh session, 2026-10-22, asking to set up an ultimate goal to build or port Heddle with Rust and to set up the dev environment for it
  - source: owner statement in the same session, asking that heddle be verified with the browser-use tool and compared with DSH on localhost 8080 where needed
  - source: ULTIMATE_GOAL.md, the twelve parts of the TypeScript harness and their verifiers
goal_state: pursuing
as_of: 2026-10-22
evidence: rust/INDEX.md section Status
---

# Heddle in Rust — Ultimate Goal

**The port is complete when one Rust binary, `heddle`, is the harness the TypeScript build is** — every part
of [`../ULTIMATE_GOAL.md`](../ULTIMATE_GOAL.md) satisfied by that binary under the same verifiers, and its
Web UI driven with [`_tools_/browser-use`](../_tools_/browser-use/INDEX.md) and compared with DSH
(`http://127.0.0.1:8080`) wherever the page follows DSH.

## The rule

**The verifiers are the contract**, so the port is a second implementation of it, not a new contract. The
checks run the harness through `heddleCommand` in
[`_tools_/verify-runner/lib.mjs`](../_tools_/verify-runner/lib.mjs): `node dist/cli.js` by default, the binary
named by `HEDDLE_BIN` otherwise. The Rust binary therefore keeps the TypeScript build's command line, HTTP
routes and session log, and serves the same `src/server/page.html`, which makes the Web UI parts a server port.

## The parts

What satisfies each part is stated once, in [`../ULTIMATE_GOAL.md`](../ULTIMATE_GOAL.md). A part ports
unchanged unless it names a TypeScript mechanism; those get a Rust shape here.

| # | Part | Rust shape | Verifier, run with `HEDDLE_BIN` |
|---|---|---|---|
| 0 | configuration system | the same YAML layers and profiles; a row names a built-in or an outside component, not a module path | `05-config-system` |
| 1–3 | backends, streaming, context | unchanged | `10-llm-backends`, `20-streaming`, `30-context-management` |
| 4 | pluggable tools | an outside tool is a process declared in configuration, spoken to as line-delimited JSON on stdio | `40-pluggable-tools`, plus a branch for that process |
| 5 | agentic loop | unchanged | `50-agentic-loop` |
| 6 | hooks | Cordis's `emit`, `parallel`, `bail` and `waterfall` modes as a Rust event bus; an outside listener uses the part-4 protocol | `60-hooks`, plus that branch |
| 7–10 | workspaces, sandbox, Web UI, token | unchanged; the page is judged in a browser too | `70` to `90`, and browser-use against DSH |
| 11 | Web UI daemon | the same launchd agent, pointed at the binary | `95-web-daemon` |

**The offline constraint carries over**: every verifier spends nothing by default, and the one real-endpoint
check reports *unjudged* when its endpoint is missing.

## What the target is not

- **Not a rewrite of the page** — one page serves both builds.
- **Not a second contract** — a check only the Rust binary passes is a bug, apart from the three shapes above.
- **Not the end of the TypeScript build** until the owner says so; it is the oracle while the port is incomplete.

## How the state is maintained

Per-part status lives in [`INDEX.md`](INDEX.md), written only from a verifier run against the binary, with
the command and the date; browser baselines are in [`../_context_/rust-port/`](../_context_/rust-port/INDEX.md).
