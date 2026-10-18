---
title: Web Daemon
version: 1.0.0
description: The launchd agent that keeps the heddle Web UI running at the documented port.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, asking for a daemon on 3082
---

# `web-daemon`

Holds the definition that makes the Web UI a **service** rather than a command someone runs: a launchd
agent template, an installer that fills it in for the machine it runs on, and the liveness decision a
supervisor needs.

## What belongs in it

| File | What it is |
|---|---|
| [`heddle-web.plist.template`](heddle-web.plist.template) | the agent, with placeholders for the node binary, the checkout and the port |
| [`install.sh`](install.sh) | writes the agent for this machine and loads it; `--status`, `--restart`, `--uninstall`. It **refuses** a checkout that is not on `main` or has uncommitted changes, so the agent cannot be installed from a workspace (`HEDDLE_ALLOW_DIRTY_INSTALL=1` is the development override). |

## Why an agent and not a daemon

The convention is explicit: a **LaunchDaemon** is boot-level and needs root, a **LaunchAgent** needs no
privileges and starts at login. `~/Library/LaunchAgents` is owned by the account the service runs as, so
installing, inspecting and removing this needs no `sudo` — and a file the operator can read is worth more
than a unit they have to be told about.

## What keeps it up, and how that is judged

`KeepAlive` is the supervisor half of the convention, with `ThrottleInterval` bounding a crash loop, and
the working directory is what makes the default profile load — a daemon started elsewhere would boot an
empty tree, which is a real failure mode this repository has already met once.

**Liveness is port ownership**, never a process-name search. The convention is blunt about why: `pgrep -f`
matches the searching command's own line and has been measured concluding a dead service was up. A bound
port cannot be satisfied by our own argv and cannot be satisfied twice, and because the server is the
agent's only process there are no children to orphan.

The server answers `GET /healthz` with its own name and port and **nothing else** — no counts, no
version, no session data — which is the one route reachable without a token, so it is the one route that
must say nothing worth having. The definition and the server therefore agree on a single endpoint instead
of on parsing a banner.

## The request fence, and the viewer it used to break

heddle refuses a request whose `Host` is not loopback, and refuses one whose `Origin` names another
authority. A cross-site request may **read** and may not **change** anything — `GET` and `HEAD` pass,
everything else is refused.

That split is a correction. The fence first refused every cross-site request, and a viewer that embeds the
page in a **sandboxed iframe** has an opaque origin, so the browser marks its requests cross-site: measured,
`allow-same-origin` rendered heddle and a fully sandboxed frame received `refused: a cross-site request`.
heddle was unreachable from the sidebar it was meant to be watched in. Reads are safe to allow because the
credential cannot travel — the session cookie is `SameSite=Strict`, so a browser never attaches it to a
cross-site request, and the same read without the cookie is a `401`. A write must name this authority in
`Origin`, and an opaque origin's `null` matches nothing.

**This is why the gate is not a workaround for the fence.** The gate forwards the caller's `Sec-Fetch-Site`
untouched, so a sandboxed viewer reaches heddle through it only because heddle now permits the read.

## How the token works here

The launch token is minted **per process** and never stored, which does not change because the process is
supervised: each restart prints a new one into the log. The installer says so and gives the command that
reads the last one, rather than printing a URL whose token would be stale by the time it was used.

## A build is only visible after a restart

The agent runs the built files, and **the page and every module are read when the process starts**. After
`npm run build`, restart the agent (`sh install.sh --restart`, or `launchctl kickstart -k
gui/$UID/<label>`) or the browser keeps being served the previous page and the previous projections.

Measured on 2026-10-17, and it cost a false bug report: the owner saw rounded panes and a duplicated
assistant row after the fixes had been committed, while the running process had started before the build
that carried them. Restarting the agent made the same browser show the fixed page — `aside` radius
`28px → 0px`, one assistant row per turn — with no code change in between. A stale process looks exactly
like a broken fix.

## Read next

[`../../_verifiers_/95-web-daemon/INDEX.md`](../../_verifiers_/95-web-daemon/INDEX.md) for the claim this
decides, and [`../../src/server/INDEX.md`](../../src/server/INDEX.md) for the server it runs.
