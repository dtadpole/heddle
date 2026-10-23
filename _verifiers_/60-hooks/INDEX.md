---
title: Verifier 6 — Hooks
version: 1.0.0
description: hooks intercept a model or a tool call.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, listing the ten verifiers
---

# `60-hooks`

Instance of this project's `_verifiers_`. **The claim it decides:** hooks intercept a model or a tool call.

A hook is what lets a policy attach without the caller knowing. This part judges that named hook points exist around a model call and a tool call, that a listener can rewrite a request or refuse a call, and that a listener is released with the fiber that registered it.

## Where it runs

**No browser.** The checks drive the CLI, a scripted endpoint or a local HTTP double; nothing here needs
a display or a window.

## What decides it

`check.mjs` installs a hook plugin through a layer file and observes its effect on a scripted turn.

## Under `HEDDLE_BIN`

The TypeScript build loads each hook as a `.ts` plugin; the Rust binary cannot load TypeScript, so under
`HEDDLE_BIN` each hook is written as a **process** instead (`rust/ULTIMATE_GOAL.md`, part 6: an outside listener
uses the part-4 protocol). The row names a component manifest beside the profile, in the shape D-031 froze:

```yaml
# retarget.component.yml; the row is `name: ./retarget.component.yml`
program: "/path/to/node"
args:
  - ./retarget.mjs
```

The script speaks line-delimited JSON-RPC 2.0 on stdio. It answers `initialize` with the points it listens on
(`{"tools":[],"listeners":[{"point":"model/request"}]}`), the way the plugin calls `ctx.on(...)`, and each
`hooks/call` with the plugin's own decision as a part-4 reply: `replace` for the retarget and the write refusal,
`next` to pass, `merge` for the post-execute rewrite (the rest of the chain and the tool run first, as the plugin's
`next()` does), `refuse` for the pre-step stop, and a JSON-RPC error for the broken hook. The claims, the
fixtures and their verdicts on the TypeScript build are unchanged.

## Running it

```bash
sh verify.sh            # every check, with the verdict
sh verify.sh --list     # the check names, and why any was unjudged
sh verify.sh --json     # one parseable object
```

Exit `0` when the claim holds, `1` when it fails, `3` when it could not be judged. A
claim that could not be judged is never reported as holding, which is the runner's
whole reason for existing — see [`_tools_/verify-runner/`](../../_tools_/verify-runner/INDEX.md).

## What it deliberately does not judge

- **How well a model reasons.** Nothing here scores an answer's quality; the checks
  ask whether the mechanism works.
- **Anything it has to spend to see.** Except where a check is named for the real
  backend, every fixture is local and the run is free.

## Read next

[`../INDEX.md`](../INDEX.md) for the verifications, and
[`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the part this one decides.
