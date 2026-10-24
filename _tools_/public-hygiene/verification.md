---
title: Public hygiene verification
created: 2026-10-24T05:00:36Z
modified: 2026-10-24T05:00:36Z
level: L2
version: 1.0.0
description: A pinned run of the public-hygiene gate on a real range, and what its unit tests judge.
status: unverified
grounded_in:
  - source: the public-hygiene INDEX.md this was split from
---

# Verification

## A pinned run

```text
$ git rev-parse --short HEAD
e6122fd
$ node _tools_/public-hygiene/gate.mjs
public-hygiene: range origin/main..HEAD, 3 commit(s), 9 file(s), 10 private rule(s), 1 built-in rule(s)
ok: nothing to flag; main can take this
```

Run on 2026-10-23T03:34Z on branch `hd/tool-developer` at e6122fd, ahead of `origin/main` by the cap file and
the reflection sync. The same commit's `--tree HEAD` found 189 findings across 602 files in content already
published on main — names in paths, session ids, internal aliases, devserver names and private tree paths. Those
are not this range's work ([usage.md](usage.md) says which mode judges a push); cleaning published history is
the owner's decision, not an integrator's.

## What the unit tests judge

The suite judges the list format, literal and regex matching, redaction, the diff and log parsers, the identity
check, the built-in rule, the placeholder rule (integrator-two's six measured shapes exempt, a random v4 and two
stray digits caught), a branch behind main, a symlinked invocation, and the three exit codes against a throwaway
git repository.
