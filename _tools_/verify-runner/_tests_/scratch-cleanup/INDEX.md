---
title: Verify runner scratch cleanup tests
version: 1.0.0
description: Unit tests for scratch.mjs. A check's temp folders and browser profile are removed when its process ends, even when the check throws or the runner sends SIGTERM.
grounded_in:
  - source: _tools_/verify-runner/scratch.mjs
created: 2026-10-29T14:29:28Z
modified: 2026-10-29T14:29:28Z
---

# `scratch-cleanup`

Each test runs a child node process against a scratch root of its own. The tests check that a tracked folder
goes when the check throws, on a normal exit, and on SIGTERM. On SIGTERM the tracked browser process is killed,
and the child still ends by the signal. An untracked folder stays, and `tempDir()` folders go when the process
ends. SIGKILL cannot be caught, and `_tools_/local-build/tmp-sweep` removes what it leaves.

```bash
node --test _tools_/verify-runner/_tests_/scratch-cleanup/unit.test.mjs
```

**Browser mode: none.**
