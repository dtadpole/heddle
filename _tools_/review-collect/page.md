---
title: Review collect example page
created: 2026-10-24T05:01:11Z
modified: 2026-10-24T05:01:11Z
level: L2
version: 1.0.0
description: An example of the page review-collect prints for one seat
status: unverified
grounded_in:
  - source: the review-collect INDEX.md this was split from
---

# The page

```text
review-collect: developer-ten  [hd] Developer Ten  lane ui
team        <the TEAM.yaml given>
focus       server, token and stream — the server, token and stream first, so every feature crate can mount its routes
worktree    ~/heddle--developer-ten  branch hd/developer-ten  HEAD 72fdb4fb824d
tip         24 ahead, 0 behind  origin/main 59fd96f (2026-10-22T20:51:13-07:00)
pushed      origin/hd/developer-ten 72fdb4f: 24 ahead, 0 behind origin/main; local HEAD is the pushed tip
scope check clean: 0 committed and 0 uncommitted path(s) outside the write scope
commits     19 ahead with subjects (5 merge(s) of main not listed; 24 commits total)
  f09a628  2026-10-22T20:48  fix(heddle-server): answer a stale approval with answered:false
  ...
files       16 changed vs origin/main
  crate heddle-server (16) [in scope (heddle rust/crates/heddle-server/)]
    rust/crates/heddle-server/Cargo.toml
    ...
uncommitted 0 path(s)
  none
last report 2026-10-22T20:54:34-07:00 to hd-coordinator [fyi] backend candidate abdf20c: heddle-server 121 tests pass
  (the first twelve lines of the body)
newer msg   2026-10-22T20:57:12-07:00 to developer-twelve [answer] ...
runs        1 recorded in a scoped INDEX
  rust/crates/heddle-server/INDEX.md:25
    `cargo test -p heddle-server` is green (122 tests). The door is judged over a real socket as
    command: cargo test -p heddle-server
action log  0 line(s) since 2026-10-22T20:51:00-07:00 (last seat line 2026-10-22T20:41:05-07:00)
scope       include: rust/crates/heddle-server/
```

Where each section comes from is in [evidence-sources.md](evidence-sources.md).
