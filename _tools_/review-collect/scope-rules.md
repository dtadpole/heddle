---
title: Review collect scope rules
created: 2026-10-24T05:01:11Z
modified: 2026-10-24T05:01:11Z
level: L2
version: 1.0.0
description: How review-collect turns a seat's write scope into prefixes and judges each path against them
status: unverified
grounded_in:
  - source: the review-collect INDEX.md this was split from
---

# How a path is judged

A write scope is prose with paths in it. Each path-shaped token becomes a prefix (`rust/crates/heddle-server/`,
`_tools_/verify-runner/`, `rust/INDEX.md`; `the backend _verifiers_ folders` becomes `_verifiers_/`); a scope with
no path (`merges of the backend lane onto main`) is listed as **unparsed** and never used to call a path outside.

A path is `in scope`, `EXCLUDED` (it matches an excluded prefix), `OUTSIDE SCOPE`, or `no path scope recorded`
when the seat has no machine-readable scope at all.

The verdict is evidence for the reviewer, not a ruling: a lockfile merge or an agreed exception reads as outside
and is the reviewer's call.
