---
title: Web daemon install rules
created: 2026-10-23T01:37:16Z
modified: 2026-10-23T05:30:26Z
version: 1.0.0
description: Unit tests that run install.sh in throwaway checkouts with stand-in launchctl, systemctl and loginctl.
grounded_in:
  - source: _tools_/web-daemon/install.sh
---

# `install-rules`

The rules `install.sh` keeps on both platforms: the rendered definition runs node on the checkout's CLI, or the
binary `HEDDLE_BIN` names, on the documented port; it is read back by the same reader the verifiers use; only
committed main is installable, on main or detached exactly at `origin/main`; a bad program, a path systemd would
split, an account that does not linger and an unknown option are refused; a refusal leaves the installed file as
it was; installing twice changes nothing; `--print` calls no supervisor; a start is verified on the port; the agent
is well-formed XML that abandons its process group; and an uninstall stops this service's leftover and no stranger.

Each case copies the installer and both templates into a fresh git repository under the system temporary
directory, so the script resolves that repository as its checkout, and puts recording stand-ins for
`launchctl`, `systemctl` and `loginctl` first on `PATH`. No real service is touched.

```bash
node --test _tools_/web-daemon/_tests_/install-rules/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../INDEX.md`](../../INDEX.md) for the tool these rules belong to.
