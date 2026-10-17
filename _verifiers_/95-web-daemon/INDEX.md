---
title: Verifier 11 — Web Daemon
version: 1.0.0
description: a launchd agent keeps the Web UI running at the documented port.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, asking for a daemon on 3082
---

# `95-web-daemon`

Instance of this project's `_verifiers_`. **The claim it decides:** the harness is arranged to be
**running** at the documented port without anyone starting it — and the arrangement is complete enough to
hold on a machine that installs it, not only on this one.

It sits beside [`80-web-ui`](../80-web-ui/INDEX.md) because it judges a different thing. That part judges
the **server**: what it answers, on an ephemeral port and on the default. This part judges the **daemon**:
a definition, an installer, a supervisor that restarts it, and a liveness decision that a process name
cannot fake.

## Where it runs

**No browser.** The checks drive the CLI, a scripted endpoint or a local HTTP double; nothing here needs
a display or a window.

## What decides it

`check.mjs` has three checks, and they answer different questions:

1. **The definition is complete** — a launchd agent with a working directory, `KeepAlive`, a throttle,
   real log paths, the loopback host and a port placeholder; an installer that fails loudly, offers
   status/restart/uninstall, works twice, and resolves the real interpreter rather than handing launchd a
   shell shim. Judged from the repository, so it holds anywhere.
2. **This machine runs it** — read from launchd and from the port, with the answer's service name checked,
   because something listening is not the same as *this* listening. A host with no agent installed reports
   **unjudged**.
3. **It stays up** — the server is killed and required to be answering again within twenty seconds, which
   is the difference between "it is running" and "it will be running".

## Running it

```bash
sh verify.sh            # every check, with the verdict
sh verify.sh --list     # the check names, and why any was unjudged
sh verify.sh --json     # one parseable object
```

Exit `0` when the claim holds, `1` when it fails, `3` when it could not be judged. A host without the
agent installed is the `3` case, and it says how to install it.

## What it deliberately does not judge

- **That a browser renders the page.** The daemon is judged over HTTP; a browser is still the missing
  check, and the roadmap says so.
- **A supervisor the platform lacks.** `KeepAlive` is the supervisor half of the convention here, which
  is enough for one process with no children. The cron-plus-supervisord arrangement the convention
  describes exists for hosts where launchd is not available, and this repository does not carry it.
- **The token.** Reading data still requires it, and that is [`90-web-ui-token`](../90-web-ui-token/INDEX.md)'s
  claim; this part only asserts that the daemon does not weaken it.

## Read next

[`../INDEX.md`](../INDEX.md) for the verifications, and
[`../../_tools_/web-daemon/INDEX.md`](../../_tools_/web-daemon/INDEX.md) for the mechanism.
