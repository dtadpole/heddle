---
title: Web daemon preview rules
created: 2026-10-23T06:03:13Z
modified: 2026-10-23T07:47:29Z
version: 1.1.0
description: Component tests for preview.sh — when the Rust preview is rebuilt from main, the order it is rebuilt in, and what a failure leaves serving.
grounded_in:
  - source: _tools_/web-daemon/preview.sh
  - source: the coordinator's standing rule of 2026-10-22 to rebuild the 3097 preview on every main that touches rust/crates/heddle or heddle-server
---

# `preview-rules`

[`preview.sh`](../../preview.sh) rebuilds the Rust preview from `origin/main` and restarts it. The tests run it against
throwaway repositories, a bare origin and a scratch checkout, with stand-ins for the build runner, the binary it builds
and the installer, all recording their calls.

| Case | Expected |
|---|---|
| no recorded build | build in a slot, dry-run `web`, swap the binary, reinstall on 3097, record the commit, print the link |
| main changed any crate's code or manifest, the lockfile, the embedded page, or the profile | `--check` exits 10 and names the file; nothing runs |
| main changed only Markdown, inside a crate or out | current: no build, the owner keeps the link |
| `--force` | rebuilds even when current |
| the build or the dry run fails | exit 1; the served binary and the recorded commit are unchanged |
| a dirty checkout, the deployment's port or label, an unknown option | exit 2, nothing runs |

```bash
node --test _tools_/web-daemon/_tests_/preview-rules/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../INDEX.md`](../../INDEX.md) for the tool these rules belong to.
