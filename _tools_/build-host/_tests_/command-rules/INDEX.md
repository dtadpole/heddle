---
title: Build host command rules
version: 1.0.0
description: Unit tests for the scripts and arguments the build-host tool sends to a build host.
grounded_in:
  - source: _tools_/build-host/build-host.mjs
---

# `command-rules`

The rules the build-host tool's builders keep: no default host; `~/heddle--<seat>` on `hd/<seat>`, with
integration and the deployment detached at main; a worktree created once and resumed from its pushed branch;
rsync excludes history and build output; a remote run caps jobs and uses the cache; an owner tests only its own
crates; a failed cache install never stops a bootstrap.

```bash
node --test _tools_/build-host/_tests_/command-rules/unit.test.mjs
```

**Browser mode: none.**

## Read next

[`../../INDEX.md`](../../INDEX.md) for the tool these rules belong to.
