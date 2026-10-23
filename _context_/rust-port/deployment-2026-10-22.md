---
title: 'The live deployment on the owner''s Mac, 2026-10-22'
created: 2026-10-23T03:15:19Z
modified: 2026-10-23T04:35:55Z
level: L3
version: 1.7.0
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

**After ten failed starts the supervisor keeps retrying, slowly** (by 21:00 PDT on the branch; the deployment takes it
at its next move): one attempt every 60 s with a line saying why, instead of exiting 1. The reason is the same
measurement as everything else here — a process that exits is not restarted on this host, so an exit turns a
transient cause into an outage that lasts until a person or a monitor acts; `--give-up` keeps the old bounded
behaviour for a platform that restarts the job. Both are covered by the suite: one test that a failing server is
started again after the limit while the supervisor stays alive, and one that `--give-up` exits 1.

## 20:57–20:58: an outage this seat caused, and the installer bug behind it

While measuring the restart windows, `install.sh --restart` was run against the live agent at the moment another
seat's push had moved `origin/main` (the refs are shared by every worktree, and a `git fetch` in the base clone had
just brought it in). The installer **booted the live agent out first**, then rendered the definition, and the render
refused: the deployment was one commit behind the freshly fetched tip. It exited with nothing loaded. `8082`
answered 502 until the agent was bootstrapped from its unchanged plist and kickstarted by hand at 03:58:35Z; the
deployment was then moved to the new `main` (`0a10ceb`) the normal way. Measured from outside by live-monitor, the
page was unreachable for about **70 s** (plist rewritten 03:57:36Z, answering 03:58:47Z): the window began with a
deliberate `kickstart -k` of a four-second-old job — the throttle measurement below — and the refused reinstall
extended it.

The bug is the ordering, not the refusal — the refusal is correct. `install.sh` now renders (and refuses) **before**
it stops anything, so a refused reinstall leaves the running agent and the installed file exactly as they were. The
regression test drives the macOS replace path with a loaded agent and a dirty checkout and requires no `bootout`,
`bootstrap` or `kickstart` before the refusal; against the previous installer it fails with
`calls: launchctl print … | launchctl bootout …`, which is this outage written as a test.

Two smaller readings from the same measurement, for whoever next restarts this by hand:

| Action | Longest silence at `3082` |
|---|---|
| `install.sh --restart` on a job older than 10 s | 288–364 ms |
| `launchctl kickstart -k` on a job younger than `ThrottleInterval` (10 s) | the respawn waits out the throttle: about 10 s |

So a restorer that kicks a freshly started job does not shorten an outage, it lengthens one — another reason the
guard acts on the job state rather than on a silent port.

## Rehearsals: experiments on a scratch agent, never on the live one

After the 03:57Z outage the coordinator made it a rule: measurements and experiments run on a scratch agent on a
scratch port, and the live agent is touched only by a real redeploy to a new `main`. `_tools_/web-daemon/rehearse.sh`
makes that the easy way. It installs the same definition `install.sh` writes, under the label
`com.dtadpole.heddle-web.rehearsal`, port 3096, and its own state directory and log (the 8082 gate reads the
newest launch token from the deployment's log, so a scratch server must never write there). Then it measures five
claims and removes everything. It refuses the deployment's label, unit and ports before it calls anything.

**The first run found a real installer bug.** The reinstall claim failed: `install.sh --restart` booted the scratch
agent out and the `bootstrap` that followed answered `Bootstrap failed: 5: Input/output error`. `bootout` returns
before launchd has finished removing the job, and a bootstrap in that window is refused, so the installer exited with
nothing loaded. That is the outage shape again, and the deployment's redeploys had only been surviving it by timing.
The installer now waits for the old job to disappear and retries a refused bootstrap, then exits 1 with a sentence if
the agent is still not loaded. Two tests drive a stand-in launchd that keeps the old job visible after bootout and
refuses the first bootstraps; both fail against the previous installer.

Rehearsals with the fixed installer, 21:09 and 21:11 PDT, from the seat worktree (`npm run build` there; no cargo):

| Claim | Run 1 | Run 2 |
|---|---|---|
| started | 463 ms after install | 339 ms |
| kill → new pid answering | 443 ms (56643 → 56860) | 260 ms (60474 → 60775) |
| guard run during that restart | no action | no action |
| reinstall, longest silence | 635 ms | 349 ms |
| agent booted out → one guard run | restored, 1251 ms | restored, 1163 ms |
| verdict | 5 held | 5 held |

During both runs the live deployment kept the same server pid (92313) and the same launch token in its log, and 8082
answered 200: the rehearsal did not touch it. No scratch agent is left loaded (`launchctl print` on the rehearsal
label fails), and the scratch state directory was removed.

**A sixth claim: `95-web-daemon` judged on the scratch service.** The ui lane gate stopped running 95 against the
deployment (D-042), because its stays-up check kills the owner's server. `95-web-daemon` now judges the service that
`HEDDLE_WEB_LABEL` names when one is set, and `rehearse.sh` runs it against the scratch agent as its last claim. Run 3,
21:19 PDT: started 320 ms, kill 357 ms (94784 → 95214), guard no action, reinstall 426 ms, agent gone restored in
1170 ms, **95-web-daemon 4 pass, 0 fail, 0 skipped** — 6 of 6 held, while the live server kept pid 70020 and its token.
`96-deployment` blanks those overrides, so it always reads the deployment: 3/3 at `b0ef8ab` both from a plain shell and
from one with the scratch label set.

**The Rust branch, rehearsed (part 11 through `HEDDLE_BIN`).** The same tool installs the binary exactly as the
deployment would serve it: `HEDDLE_BIN=<binary> sh _tools_/web-daemon/rehearse.sh`. With the lanes' release binary
(sha256 `a355a0aa1fc4…`, built 21:14 PDT, copied to a temporary file first so the run depended on nothing in another
seat's worktree): `started` **failed** after 20 s, and the scratch log gave the reason — `heddle: not ported to Rust
yet: web`, exit 2 after 4 ms, retried by the supervisor with backoff — and the other five claims were reported
**unjudged** rather than failed one by one. The rehearsal now stops at that point instead of spending another minute,
which a component test pins. The TypeScript rehearsal run right after held 6 of 6 again (95: 4 pass, 0 fail).

## The gate on 8082 has no working supervisor either

The owner's address is the gate, not the server: `ai.reflection.heddle-web-gate` (dsh-web-ops' token-supplying
proxy, installed on this Mac with that project's own installer) listens on 8082 and forwards to 3082. Its only parent
is launchd (`ppid 1`; no supervisord runs here), so it has the same defect the server had before `supervisor.mjs`: a
gate process that dies is not restarted, and 8082 stays down although the server behind it is healthy.

Rehearsed on a scratch pair, 2026-10-22 at about 21:29 PDT (before 21:30:59, when this section was committed), with the gate's unchanged code on 8096 in front of a
rehearsal heddle on 3096 (own log, mode 600), the live gate untouched (pid 97470 before and after):

| Gate arrangement | SIGKILL of the process owning 8096 |
|---|---|
| launchd alone (as the live gate runs now) | `000` at 2, 5, 10 and 15 s; the job stays `not running` |
| `supervisor.mjs -- node heddle-gate.mjs` under the same agent | back in **400 ms** on a new pid (15349 → 15501), and `/api/sessions` answers 200 through a fresh token handshake |

So the fix is the one the server already has, and the supervisor is already on `main`
(`~/heddle-live/_tools_/web-daemon/supervisor.mjs`). Changing the gate's installed agent belongs to dsh-web-ops, so it
is proposed to the coordinator rather than done: the gate's plist would gain the two arguments in front of its program,
with the same environment, and dsh-web-ops' `install-heddle-gate.sh` restores the original in one command.

**Decided 2026-10-22, 21:33 PDT (coordinator):** this team does not modify, restart or wrap the gate; it is
dsh-web-ops' installed agent. The finding — the gate has no restarter, so 8082 stays down if its process dies while
3082 is healthy — is raised with the owner as a decision for the dsh-web-ops team. Until then live-monitor alerts on
it, and this record keeps the rehearsal above as the evidence.

## Who acts on the service, and the guard's state (D-045)

**No guard is scheduled or running.** The crontab has no guard line (it is TCC-blocked anyway), no LaunchAgent runs
one, and no process runs `guard.sh`; verified 21:02 PDT. The interim 15-second loop from this session was stopped
at about 03:44Z, before the supervisor's kill test. The old port-only `guard.sh` was run only by hand, in the
measurements at 03:36:39Z and 03:53:17Z. So until the job-aware guard is on `main`, the deployment runs
**the supervisor alone**, which is what the coordinator's D-045 asks.

Everything that has touched the service tonight, so a restart in `web.log` can be attributed:

| Actor | What it does | Since |
|---|---|---|
| this seat | redeploys (`install.sh --restart` after `checkout --detach origin/main`), the measurements recorded here | throughout |
| `supervisor.mjs` | restarts a server that exits, in about a second | the tooling merge, 20:44 PDT |
| live-monitor | **observes only** since D-045: its restore code was removed (live-monitor `c791612`). It used one delegated `kickstart` at 03:42:20Z and 03:54:07Z, the second inside an install window, where it killed a freshly started server | read-only since 04:06Z |
| the ui lane gate | ran `95-web-daemon` against the deployment four times on 2026-10-22 (each a real kill); **no longer** since D-042 — it cites 95 from a scratch install and 96 read-only | stopped 04:13Z |

## The flap at 20:49–20:50, and the guard race it exposed

The coordinator measured a 502 at `8082` with `3082` momentarily not listening, and three kickstarts in
`guard.log` 75 s and 15 s apart. The cause was not a crash loop and not a slow launch: each entry was the restore of
a **deliberate kill by `_verifiers_/95-web-daemon`'s stays-up check**, which integrator-two's lane gate ran against
this deployment (its 03:39:44Z note records the 95 and 96 runs). At that moment the agent had no supervisor, launchd
does not restart a loaded agent here, and the interim 15-second guard was the only restorer — so three kills became
three restores, each about 15 s later, and each window a 502. **A gateway that runs 95 against the owner's page is,
by construction, running a kill test on it.**

It also exposed a real race in the guard. `guard.sh` probed the port: a silent port meant "kick the job". Once the
supervisor was installed, a killed server is back in about a second, but during that second the port is silent, so a
port-only guard kicks the job it is supposed to protect — launchd kills the supervisor and the fresh server, and the
restart begins again. Measured on the live deployment: the old guard logged `port 3082 silent but the agent is
loaded; kickstarting it` during a restart; then, after the fix, the same scenario produced **zero actions, zero log
lines**, and the supervisor had a new pid answering 200 a second later.

The fix, on `hd/live-deploy` (`ba92183`, with the slow-retry supervisor in `58f60f6`): the guard acts on the **job**,
not the port — `running` (or systemd `active`) means the supervisor owns the server, so it does nothing — plus a
20-second cooldown; seven component tests drive the whole script against stand-in platform commands. The deployment
takes both at its next move of `main`.

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
| 20:44 | `51f198b` (the tooling merge landed as `085caaf`) | `51f198b`, clean | installed by the deployment's own `install.sh` with **no override** (it accepts detached-at-`origin/main` now); the agent runs `supervisor.mjs`; **95 4/4 and 96 3/3, both run from `~/heddle-live`**; a SIGKILL of the port's process left a new pid answering within **one second** with no guard running |
| 20:47 | `c67f5ad` (Rust lockfile chore) | `c67f5ad`, clean | 95 **4/4** (949 ms) and 96 **3/3** (521 ms) from the deployment; page unchanged (533,283 / 533,280, marker `dd6d45d28567`); a turn answers with the fixture, 0 errors |
| 20:50 | `1bcff7e` (backend merges under the status-docs commits) | `1bcff7e`, clean | 95 **4/4** and 96 **3/3** from the deployment; page unchanged (same marker and byte counts); gate 200, healthz 200 |
| 20:54 | `59fd96f` (component manifest) | `59fd96f`, clean | 95 **4/4**, 96 **3/3** from the deployment |
| 20:59 | `0a10ceb` (part 0 passes through the binary) | `0a10ceb`, clean | after the 20:57–20:58 outage below; redeploy silence 288 ms; 95 **4/4**, 96 **3/3**; marker `dd6d45d28567` |
| 21:02 | `480d9b8` (a served command routes through the boot) | `480d9b8`, clean | 95 **4/4**, 96 **3/3** from the deployment; marker `dd6d45d28567`; the binary's `web` still exits 2, so the page is still the TypeScript oracle |
| 21:13 | `d28625d` (a ui check whose harness cannot start fails instead of hanging) | `d28625d`, clean | 95 **4/4**, 96 **3/3** from the deployment; marker `dd6d45d28567` |
| 21:21 | `b0ef8ab` (Rust status run on `ea1028b`) | `b0ef8ab`, clean | 96 **3/3** from the deployment; 95 judged on the scratch service instead (4/4, rehearsal run 3), so the owner's server was not killed |
| 21:24 | `b89ad37` (Rust status run on `4aca3b1`; the hygiene gate judges from the merge base) | `b89ad37`, clean | 96 **3/3** from the deployment; marker `dd6d45d28567`; 95 not run against the live agent |
| 21:27 | `c4c9292` (check-team-view fails instead of hanging) | `c4c9292`, clean | 96 **3/3** from the deployment; marker `dd6d45d28567` |
| 21:31 | `1157d4e` (30 commits; the bus adapts to the tools and agent ports) | `1157d4e`, clean | **first redeploy by `redeploy.sh`**: 3.8 s end to end, longest silence at 3082 300 ms; 96 **3/3**; marker `dd6d45d28567`; 8082 `/api/sessions` 200 |
| 21:32 | `5c87849` | `5c87849`, clean | `redeploy.sh`; 96 **3/3**; marker `dd6d45d28567`; 8082 `/api/sessions` 200 |
| 21:35 | `29cec5b` (via `c1cdb81`) | `29cec5b`, clean | `redeploy.sh`; 96 **3/3**; marker `dd6d45d28567`; 8082 `/api/sessions` 200 |

Both redeploys used main's installer at that commit, which refuses a detached checkout, with
`HEDDLE_ALLOW_DIRTY_INSTALL=1`; the branch's installer accepts the detached shape and replaces that override when
`main` carries it. Neither build changed `dist/server/page.html`, which is why the marker is the same across them.

## On main: the deployment judged from itself

The tooling merge reached `main` as `085caaf` and main moved to `51f198b`. `~/heddle-live` was moved to it, rebuilt,
and installed by **its own** `_tools_/web-daemon/install.sh` — no `HEDDLE_ALLOW_DIRTY_INSTALL` — because the
installer now accepts the one shape a deployment worktree can have: clean and detached exactly at `origin/main`.

| Reading | Value |
|---|---|
| deployed commit | `51f198bc7cd69a9513715fbc139191054317f55f`, `~/heddle-live` clean, `origin/main`'s tip |
| agent program | `node ~/heddle-live/_tools_/web-daemon/supervisor.mjs -- node ~/heddle-live/dist/cli.js web --host 127.0.0.1 --port 3082 --config ~/heddle-live/cordis.yml` |
| `_verifiers_/95-web-daemon` from `~/heddle-live` | **4 checks, 4 passed**, 767 ms — the first time this verifier passes on main on this host |
| `_verifiers_/96-deployment` from `~/heddle-live` | **3 checks, 3 passed**, 372 ms — the third check passes on main for the first time |
| a SIGKILL of the process owning 3082, no guard running | a **new** pid answering 200 within **one second** (50845 → 51830), 8 s of polling |
| `install.sh --guard` | exits 1, `crontab: tmp/…: Operation not permitted`; the crontab is untouched, so the cron line is still one owner action away |
| `guard.sh --status` | `port 3082: answering`, `service: loaded` |

That is the arrangement the deployment keeps: **launchd starts the agent at login, `supervisor.mjs` keeps the
server up inside it, and `guard.sh` is the outer layer the moment the account lets a cron line be installed.** The
interim 15-second loop from this session was stopped before the kill test, so the one-second recovery above is the
supervisor's alone.

**The install window is visible from outside, and live-monitor saw it.** Its 03:42:20Z pass found `3082` silent
while `install.sh` had the job booted out, used the restore authority once (`launchctl kickstart -k`, answering again
in 507 ms), and then failed its door check because a relaunched server mints a new launch token and the pass still
held the old one — live-monitor's bug, fixed by re-reading `~/.heddle/web.log` after a restore. Neither is a
deployment fault: a 3082 that is silent *after* the supervisor is installed comes back by itself in under a second,
and the restore authority stays for the case where the whole agent is gone (bootout, or a login whose launchd did
not start it). `guard.log` entries at 03:36:39–03:40:50Z are the same windows: my hand-installs and bootout/kickstart
tests, not a crash loop.

## Redeploying, when an integrator moves main

**Since `redeploy.sh` (2026-10-23):** one command, `sh ~/heddle-live/_tools_/web-daemon/redeploy.sh` (or, until
`main` carries it, `sh <seat worktree>/_tools_/web-daemon/redeploy.sh --repo ~/heddle-live`). It fetches, moves the
checkout to `origin/main`, builds, runs **the new checkout's** `install.sh --restart`, waits for the port and judges
with the checkout's own `96-deployment`; `--check` only answers whether the deployment is behind. First run against the
live deployment, at `c4c9292`: `current at c4c9292`, then `96-deployment 3/3 held`, and the server kept its pid — a
current deployment is judged, not restarted. The manual steps below are what it does.

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
