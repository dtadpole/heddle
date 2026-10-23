---
title: 'The live deployment on the owner''s Mac, 2026-10-22'
created: 2026-10-23T03:15:19Z
modified: 2026-10-23T06:04:13Z
level: L3
version: 2.0.0
description: What serves the owner's page on loopback port 8082, how it is redeployed, rehearsed and restored, who acts on it, and what is still open.
status: unverified
grounded_in:
  - source: D-020 (the team resumed on the owner's Mac; no devservers, no SSH forward)
  - source: owner statement in the dsh session, 2026-10-22, asking that heddle be served locally on loopback port 8082
  - source: D-015, D-030, D-035, D-042, D-045
---

# The live deployment on this Mac

The owner's page is `http://127.0.0.1:8082/`, the TypeScript build as the oracle until the binary serves `web`.

| Piece | Value |
|---|---|
| checkout | `~/heddle-live`, a worktree detached at `origin/main`, never edited |
| server | agent `com.dtadpole.heddle-web` runs `supervisor.mjs -- node ~/heddle-live/dist/cli.js web --port 3082` |
| gate | dsh-web-ops' agent `ai.reflection.heddle-web-gate`, 8082 → 3082, token read from `~/.heddle/web.log` (mode 600) |
| endpoint | D-030 offline fixture: `~/.heddle/heddle.json` points `scripted` at `~/.heddle/deployment-scripted.json`; replies open `scripted endpoint: offline fixture reply, not a model` |
| page marker | `dd6d45d28567`, unchanged through every redeploy so far |
| Rust preview (separate) | agent `com.dtadpole.heddle-web-rust-preview` on 3097, main's release binary, rebuilt by `preview.sh` on every main that changes `rust/crates/heddle` or `heddle-server` (the commit is in `~/.heddle-rust-preview/built-from-main`); own `HEDDLE_HOME` `~/.heddle-rust-preview`; no gate, so a token link; stop with `launchctl bootout` of its label |

## Operating it

- **Redeploy** when `main` moves: `sh ~/heddle-live/_tools_/web-daemon/redeploy.sh` (until `main` carries it, a seat
  copy with `--repo ~/heddle-live`). It fetches, moves, builds, runs the new checkout's installer and judges with
  `96-deployment`; `--check` only says whether the deployment is behind. A move that changes nothing the server
  loads at start (Rust, verifiers, records, docs) is checked out and judged without a restart.
- **Experiment** only with `_tools_/web-daemon/rehearse.sh`, on a scratch agent. The live agent is touched only by a
  redeploy, and 95 never runs against it: its stays-up check kills the server.
- **Restore** a job that is gone: `launchctl kickstart gui/$(id -u)/com.dtadpole.heddle-web`. A silent port with the
  job running is the supervisor mid-restart; leave it.

| Acts on the service | How |
|---|---|
| this seat | redeploys; scratch rehearsals |
| `supervisor.mjs` | restarts a server that exits, in about a second |
| live-monitor | observes and alerts only (D-045) |
| the ui lane gate | 96 read-only; 95 from a scratch install (D-042) |

## Open

- **The gate has no restarter:** under launchd alone a dead gate stays down. It is dsh-web-ops' to change; the
  coordinator raised it with the owner and this team does not touch it.
- **No outer guard:** `guard.sh` needs a cron line, and the crontab refuses automation (TCC); that line is the owner's.
- **Part 11 through the binary is not met:** its `web` exits 2. When it serves, `HEDDLE_BIN=<binary>` switches the
  same checkout, with one condition: the lane that builds the binary and `~/heddle-live` must be at the same `main`,
  because the binary serves the page it was built with.

## Evidence

[`deployment-2026-10-22-log.jsonl`](deployment-2026-10-22-log.jsonl), every redeploy and its verdicts;
[`deployment-incidents-2026-10-22.md`](deployment-incidents-2026-10-22.md);
[`deployment-measurements-2026-10-22.md`](deployment-measurements-2026-10-22.md).
