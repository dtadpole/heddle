---
title: 'The live deployment on the owner''s Mac, 2026-10-22'
created: 2026-10-22T20:20:00Z
modified: 2026-10-22T20:20:00Z
level: L3
version: 1.0.0
description: 'The TypeScript deployment brought up on this Mac: which commit ~/heddle-live serves, the agent and gate that run it, the commands run, and what _verifiers_/96-deployment answered.'
status: unverified
grounded_in:
  - source: D-020 (the team resumed on the owner's Mac; no devservers, no SSH forward)
  - source: owner statement in the dsh session, 2026-10-22, asking that heddle be served locally at 127.0.0.1:8082
  - source: D-015 (a deployment checkout detached at origin/main judges the same fact as one on main)
---

# The live deployment on this Mac

The owner's page is `http://127.0.0.1:8082/`, served on this Mac with no SSH forward (D-020). This is the
record of the checkout, the two launchd agents and the commands behind it, so a later reader can tell a stale
build from a missing feature.

## What runs, and where

| Piece | Value |
|---|---|
| deployment checkout | `~/heddle-live`, a worktree of `~/heddle`, detached at `origin/main` |
| commit deployed | `a5b0c66195192f1ea2fa0dbfd8eed88d000034e4` (`fix(tools): free a build slot when cargo ends`) — equal to `origin/main` at the time |
| cleanliness | `git status --porcelain` empty; `dist/` and `node_modules/` are ignored |
| server | launchd agent `com.dtadpole.heddle-web`, running `node ~/heddle-live/dist/cli.js web --host 127.0.0.1 --port 3082 --config ~/heddle-live/cordis.yml` from `~/heddle-live`, `KeepAlive` true |
| gate | launchd agent `ai.reflection.heddle-web-gate`, `127.0.0.1:8082` → `127.0.0.1:3082`, supplying the launch token from `~/.heddle/web.log` (mode `600`) |
| build marker | `<meta name="heddle-page" content="dd6d45d28567">`, the same marker the 2026-10-22 baseline recorded |

## The commands

```sh
cd ~/heddle-live && git fetch origin && git checkout --detach origin/main   # a5b0c66
cd ~/heddle-live && npm ci --no-audit --no-fund && npm run build
cd ~/heddle-live && HEDDLE_ALLOW_DIRTY_INSTALL=1 sh _tools_/web-daemon/install.sh
launchctl kickstart -k gui/$(id -u)/com.dtadpole.heddle-web                     # RunAtLoad did not fire
chmod 600 ~/.heddle/web.log                                                    # it carries the launch token
cd ~/nexus/_projects_/dsh-web-ops/_tools_/heddle-web-gate && ./install-heddle-gate.sh
launchctl kickstart -k gui/$(id -u)/ai.reflection.heddle-web-gate               # same defect
```

Two defects were met and are part 11's work, not this record's fixes: `launchctl bootstrap` loads the agent
but does not start it on this Mac (`state = not running`, `last exit code = (never exited)`), so the installer
has to kickstart it; and main's `install.sh` refuses a checkout detached at `origin/main`, which is the only
shape this deployment can have while the base clone holds `main` (D-015). The `HEDDLE_ALLOW_DIRTY_INSTALL=1`
above is that escape hatch, used once to bring the service up; the `hd/live-deploy` branch's installer accepts
the detached shape and replaces it when it merges.

## What was measured

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3082/healthz        # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8082/               # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8082/api/sessions   # 200
curl -s http://127.0.0.1:8082/ | wc -c                                        # 533283
wc -c < ~/heddle-live/dist/server/page.html                                   # 533280 (+3: the marker's content)
```

The token is required, and it opens the page:

```sh
TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' ~/.heddle/web.log | tail -1 | cut -d= -f2)
curl -s -D /tmp/h -o /dev/null "http://127.0.0.1:3082/?token=$TOKEN"   # 303 + set-cookie: heddle-auth-…
curl -s -H "Cookie: $COOKIE" -o /dev/null http://127.0.0.1:3082/        # 200
curl -s -H "Cookie: $COOKIE" -o /dev/null http://127.0.0.1:3082/api/sessions  # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3082/        # 401 without one
```

`_verifiers_/96-deployment`, run in the deployment checkout against this main:

```sh
cd ~/heddle-live && sh _verifiers_/96-deployment/verify.sh
# verdict 1 — 2 pass, 1 fail: "the deployment checkout is on main (it is on HEAD)"
```

The failing check is the third one, and it is the shape D-015 already accepted for the Linux branch: a
deployment worktree cannot be on branch `main` because the base clone `~/heddle` has it checked out, and git
checks out one branch in one worktree. The `hd/live-deploy` branch changes that check to accept a clean
checkout detached exactly at `origin/main`. Run from that branch against this same deployment:

```sh
cd ~/heddle--live-deploy && sh _verifiers_/96-deployment/verify.sh
# verdict 0 — all 3 check(s) passed
```

So on the evidence: the process behind `3082` runs this checkout's `dist/cli.js`, the page at the owner's
URL is this build's page byte for byte, and the checkout is a clean deployment checkout at `origin/main`.
The one open question — whether the committed wording should say `main` or `origin/main` for a worktree
deployment — is D-015's, and the branch takes the wording that matches the machine.

## A turn answers — with a labelled offline fixture, not a model

**Before D-030** a turn ended in `event: error — the script for 'scripted' could not be read at scripted.json`.
The cause was the configuration, not the page: the repository's offline default endpoint (`src/endpoints.ts`,
`kind: 'scripted'`, `baseUrl: 'scripted.json'`) resolves a relative path against the server's working directory,
which is this checkout, and the repository carries no such file (every check suite writes its own and removes it).
A file dropped into the checkout would also make it dirty and fail `96-deployment`'s third check.

**Since D-030** the page answers, and says what it is in its first line. Two files, both outside the checkout, so
the deployment stays clean:

| File | What it holds |
|---|---|
| `~/.heddle/deployment-scripted.json` | the script: one turn step whose text begins **`scripted endpoint: offline fixture reply, not a model`** |
| `~/.heddle/heddle.json` | `{"endpoints": [{"name": "scripted", "baseUrl": "~/.heddle/deployment-scripted.json"}]}` — the machine's endpoint list is an **array** of partial endpoints, merged over the repository defaults by name |

Measured 2026-10-22 20:30:47 PDT, after a restart (the configuration is read at start): a turn through
`POST /api/turn` with a session cookie wrote 8 session events, `assistant/chunk` seq 5 as a `text-delta` beginning
with that sentence, `assistant/completed` seq 7 and `turn/completed`, and **zero** `event: error`. The owner's page
therefore answers, and nobody can mistake the answer for a model's: the first line says it is the fixture.

A real endpoint is the owner's decision (D-030 condition 4): put one in the same `heddle.json` and it replaces the
fixture for the endpoint that is nominated; nothing about the page, the token or the stream changes.

## What stopped it, and what brings it back

Two stops were measured after the first proof, and both are recorded because a 502 on the owner's page looks the
same whether the build is broken or nothing is running it.

- **20:16 PDT — a stop during bring-up.** A manual probe server was started on 3082 to read its command line, and
  the `pkill` that cleaned it up matched the agent's process too. The gate then answered 502
  (`connect ECONNREFUSED 127.0.0.1:3082`) until it was started again. Nothing restarted it: the agent was loaded,
  `state = not running`, `runs = 1`, and `KeepAlive` never fired. This is the second defect above, met as an
  outage rather than as a reading.
- **20:21 PDT — a deliberate stop.** `_verifiers_/95-web-daemon`'s stays-up check kills the process that owns the
  port. The page was answering again from a new pid within about 15 s. The restore was the **interim guard**
  below; its log records `port 3082 silent, kickstarting`.

**Measured again at 20:32 PDT, with the guard paused**, because one run had looked like launchd recovering by
itself: killing the process that owned 3082 left it silent for **12 seconds**, `launchctl print` kept
`runs = 2`, and the port never answered. It had to be kickstarted by hand. The run that looked like a fast
recovery was `_verifiers_/95-web-daemon` (main's checks) **passing 3 of 3 in 731 ms** because the guard's
15-second probe happened to land in the same second as the kill: a real pass, but not a repeatable one, and not
launchd's. Until the supervisor is on main, main's 95 result on this host depends on the guard.

**The supervisor was also judged under launchd itself** (20:38 PDT), on a scratch label and a scratch port so the
live agent was untouched: an agent whose `ProgramArguments` are `node supervisor.mjs -- node <checkout>/dist/cli.js
web … --port 3098`, started with `launchctl kickstart -k`, answered `/healthz` 200 on 3098; a SIGKILL of the server
it held left a **new** pid serving 3098 and 200 again within four seconds. That is the arrangement this branch
installs for 3082, measured end to end rather than argued.

**What restarts it today.** Until this branch reaches `main`, the answer is an interim guard run from this
session: every 15 s it probes `3082/healthz` and runs `launchctl kickstart -k gui/$(id -u)/com.dtadpole.heddle-web`
when the port is silent (`~/.heddle/guard.log`). That is a hand, not a design — it dies with the session, and after
a reboot nothing starts it again until someone does.

`guard.sh` was also tested by hand and works in the case it exists for: `launchctl bootout` the agent, and it
bootstraps from the plist, kickstarts it and records `port 3082 answering again` about a second later. What it
cannot do yet is run on a timer: adding the cron line needs the account's crontab permission, and
`crontab -` from this automation answered **`Operation not permitted`** (macOS TCC), so the crontab is untouched
and `install.sh --guard` will fail loudly there until the line is added by the account owner or from a context that
holds the permission. **The outer layer is therefore the supervisor and, at login, launchd; the cron line is
one owner action away.**

The
landed answer is [`_tools_/web-daemon/supervisor.mjs`](../../_tools_/web-daemon/supervisor.mjs), which the agent
runs so the server is restarted inside the service, plus
[`_tools_/web-daemon/guard.sh`](../../_tools_/web-daemon/guard.sh) and `install.sh --guard`, one cron line for the
case where launchd never starts the job at login. Both are on `hd/live-deploy`; they reach this checkout when
`main` carries them and the deployment moves to it.

**The manual command**, when a person has to do what the guard does:

```sh
launchctl kickstart -k gui/$(id -u)/com.dtadpole.heddle-web
```

## Redeploy log

| At (PDT) | main moved to | Deployment | Reading |
|---|---|---|---|
| 20:12 | `a5b0c66` | `a5b0c66`, clean | 8082 200, page 533,283 bytes against 533,280, marker `dd6d45d28567`; 96 3/3 with the branch's checks, 2/3 with main's |
| 20:29 | `b4f8abf` (Rust lockfile chore) | `b4f8abf`, clean | 8082 200, healthz 200, page identical (533,283 / 533,280, same marker); 96 3/3 with the branch's checks, 2/3 with main's |
| 20:31 | `eaaa6bb` (Rust status run) | `eaaa6bb`, clean | 8082 200, healthz 200, page identical; a turn answers with the labelled offline fixture (D-030), 0 errors; 96 3/3 with the branch's checks, 2/3 with main's |

Both redeploys used main's installer at that commit, which refuses a detached checkout, with
`HEDDLE_ALLOW_DIRTY_INSTALL=1`; the branch's installer accepts the detached shape and replaces that override when
`main` carries it. Neither build changed `dist/server/page.html`, which is why the marker is the same across them.

## Redeploying, when an integrator moves main

The deployment is one checkout and one agent, so a redeploy is four steps and one reading:

```sh
cd ~/heddle-live && git fetch origin && git checkout --detach origin/main   # the tip, clean
npm ci --no-audit --no-fund && npm run build                                # dist/, ignored by git
sh _tools_/web-daemon/install.sh --restart                                  # writes the definition and restarts
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8082/            # 200, through the gate
sh _verifiers_/96-deployment/verify.sh                                      # 3/3, or the reason it is not
```

The build is read when the process starts, so the restart is not optional: without it the browser keeps the
previous page and 96 fails on the marker, which is the stale-build shape this verifier exists to catch.

**When a Rust binary can run `web`** (it cannot yet: `rust/crates/heddle` still exits "not ported", and
`heddle-server` is a crate with no wiring into it), the same checkout can serve it instead:

```sh
cd ~/heddle--int-ui && cargo build --release --manifest-path rust/Cargo.toml   # in a build slot, D-021
cd ~/heddle-live && HEDDLE_BIN=~/heddle--int-ui/rust/target/release/heddle sh _tools_/web-daemon/install.sh --restart
```

One condition comes with it: the binary embeds the page it serves, so the two checkouts must be at the **same
main** — the lane worktree builds it, and `~/heddle-live` is what `96-deployment` holds to `origin/main` and
compares the page against (`src/server/page.html` for the binary, `dist/server/page.html` for the TypeScript
build). A binary built from an older commit serves an older page, and that is exactly the 502-era failure
`_verifiers_/96-deployment` was written for.
