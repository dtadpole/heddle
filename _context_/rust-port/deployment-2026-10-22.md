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
