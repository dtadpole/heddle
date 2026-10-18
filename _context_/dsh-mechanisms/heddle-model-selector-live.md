---
title: The model selector on the owner's URL — live verification loop
version: 1.0.0
description: Why a verified cycle was reported for a UI the owner never saw, with the evidence that located the mistake, and the three-cycle verification of the deployed address (http://127.0.0.1:8082/) that follows.
grounded_in:
  - owner statement 2026-10-17 asking "did you verify on localhost:8082?" after a completed cycle whose every check was spawned from the worktree
  - owner statement 2026-10-17 asking to research and verify the miss before touching the procedure again
  - the deployed service chain measured 2026-10-17 on this machine: 8082 gate -> 3082 -> launchd agent com.dtadpole.heddle-web -> a checkout's dist/cli.js
---

# The model selector on the owner's URL

This document is the memory of the deployed-surface verification loop. It starts with the miss that created the
loop, because a later cycle must not have to rediscover why "all checks green" and "the owner sees nothing" can
both be true.

## Miss research — verified before any fix

The claim under test: the model selector was reported as complete and verified, and the owner connected to
`http://localhost:8082/` and saw the previous UI. Is that true, and where was the verification pointed?

### The evidence

| Fact | How it was measured |
|---|---|
| The **only** probe of the owner's URL was created at **19:20:58**, i.e. after the deploy at **19:20:42** (plist mtime). Every earlier browser probe (18:27, 18:27, 18:29, 18:41, 18:49) spawned its own server with `--port 0`. | `stat` of `/tmp/probe-ui*.mjs`, `/tmp/capture-after.mjs`, `/tmp/real-config-shot.mjs`, and of `~/Library/LaunchAgents/com.dtadpole.heddle-web.plist.bak-model-selector` |
| The completed cycle's commit is **19:14:53**; the claim of completion came before any 8082 evidence existed. | `git log --format='%h %ad'` on the branch |
| The browser contract cannot see a service: it spawns `join(repoRoot, 'dist/cli.js')` with `--port 0`, where `repoRoot` is the checkout that holds the check. | `_verifiers_/80-web-ui/check-model-switcher.mjs` lines 184–186 |
| The daemon behind the owner's URL ran **another checkout**: launchd `com.dtadpole.heddle-web` → `/Users/zhenc/heddle/dist/cli.js web --port 3082` (PID 43963 before the deploy; the backup plist still names it). | `ps`, `launchctl list`, and the backup plist |
| That checkout's served page had **none** of the feature: `model-effort` markers **0**, `Model and reasoning effort` **0**, the old `endpointTitle` code present, and `dist/endpoints.js` with no `models:` catalogue. | `grep -c` against `/Users/zhenc/heddle/dist/server/page.html` and `dist/endpoints.js` |
| The branch's build has them: `model-effort` **3**, two-level menu aria **4**. | the same grep against `/Users/zhenc/heddle-model-selector/dist/server/page.html` |
| A controlled run of **the old build itself** reproduces exactly what the owner saw. | `node /Users/zhenc/heddle/dist/cli.js web --port 0` + browser probe: seat `Select model, current plugboard-d · deepseek-flash`, title `the model that answers this session`, no effort span, one flat endpoint menu with `role=menu` and **0** `role=menuitem` rows; screenshot `heddle-live-before-old-build.png` |

The old build's menu, measured in that controlled run:

```
items: ["scripted|scripted", "claude-opus|claude-opus-5-5", "plugboard-d|deepseek-flash", "plugboard-x|gpt-6.1-sol"]
role=menuitem rows: 0            (the new build has two: Model, Effort)
model-effort element: absent     (the new build has it, hidden until declared)
```

### Where the mistake was

Not in the check and not in the feature. In **three decisions**:

1. **The claim was made from the wrong artifact.** Every screenshot and number came from a server the probe had
   just spawned out of the worktree. That is a legitimate code instrument; it is not the delivery. The delivery is
   the process the owner's request reaches, and the two were different builds.
2. **The serve chain was never inspected.** One `lsof`/`ps` on 3082 at claim time would have shown a pid running
   `/Users/zhenc/heddle/dist/cli.js` — a checkout that did not contain the change. The chain (8082 gate → 3082 →
   launchd → main checkout's dist) was discovered only after the owner said which URL they were on.
3. **The procedure had no delivery phase.** The full-loop skill's cycle went implement → verify, and "verify" could
   be satisfied by isolated checks. The repository's own `ui-parity-audit` §0 already said "pin the artifact: build,
   reload, check a marker in the served script" — it was applied to the DSH reference and not to our own
   deliverable.

### The corrective mechanism

- The skill is **v1.4.0**: a cycle now has a **deliver** phase (switch the service, restart it, pin the served bytes
  by a marker, record URL/PID/checkout/revert) and the verify phase is measured **at the owner's address** in a fresh
  browser profile. The miss is in its frontmatter, so a later round reads why the rule exists.
- The live loop below exists to exercise that rule on this exact service: every cycle measures
  `http://127.0.0.1:8082/`, and names the process and checkout behind it.

## Cycle log

(cycles appended below as they are measured)
