---
title: 'The live deployment''s incidents, 2026-10-22'
created: 2026-10-23T04:42:38Z
modified: 2026-10-23T04:42:38Z
level: L3
version: 1.0.0
description: Every outage or failed turn on the owner's page during the first night on the Mac, with what was seen, the cause and the fix.
status: unverified
grounded_in:
  - source: ~/.heddle/web.log, ~/.heddle/guard.log and live-monitor's pinned passes, 2026-10-22
  - source: decisions D-030, D-042 and D-045
---

# Incidents, 2026-10-22 (PDT)

A 502 at 8082 looks the same whether the build is broken or nothing runs it, so each one is attributed.

| When | Seen | Cause | Fix |
|---|---|---|---|
| 20:16 | 502 until a hand restart | this seat's `pkill` of a probe server also matched the agent's server; launchd never restarted it | [`supervisor.mjs`](../../_tools_/web-daemon/supervisor.mjs) inside the agent |
| 20:21–20:30 | a turn never answered | the offline `scripted` endpoint resolved `scripted.json` against the checkout, which has none | D-030: `~/.heddle/heddle.json` points it at `~/.heddle/deployment-scripted.json`, whose reply opens `scripted endpoint: offline fixture reply, not a model` |
| 20:39–20:50 | short 502s, including the coordinator's reading at 20:49–20:50 | 95's stays-up check kills the server: the lane gate ran it against the deployment (three restores by the interim guard at 20:39–20:41 in `guard.log`), and this seat ran it after the 20:47 and 20:50 redeploys | D-042 and this seat's rule: 95 judges a scratch service, never the deployment |
| 20:53 (measured) | a kill followed by a second restart | the old port-only guard, run during a supervisor restart, kicked the job | [`guard.sh`](../../_tools_/web-daemon/guard.sh) acts only when the job is not running |
| 20:42 and 20:54 | a freshly started server killed | live-monitor's delegated `kickstart` fired inside install windows | D-045: live-monitor observes only |
| 20:57–20:58 | about 70 s unreachable | `install.sh --restart` booted the agent out, then refused a checkout one commit behind a newly fetched `origin/main`; a deliberate `kickstart -k` of a young job had opened the window | the installer renders before it stops anything; experiments run on scratch agents only |
| about 21:05 (scratch only) | reinstall left nothing loaded | `bootout` returns early, and the following `bootstrap` failed with `5: Input/output error` | the installer waits for the old job and retries the bootstrap |

The last row never reached the owner's page: [`rehearse.sh`](../../_tools_/web-daemon/rehearse.sh) found it on a
scratch agent, which is why experiments now run there. Each fix has a component test that fails on the code before
it. Measurements behind these rows are in
[`deployment-measurements-2026-10-22.md`](deployment-measurements-2026-10-22.md).
