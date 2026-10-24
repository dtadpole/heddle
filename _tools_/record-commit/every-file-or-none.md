---
title: Every file or none
created: 2026-10-24T05:00:49Z
modified: 2026-10-24T05:00:49Z
level: L2
version: 1.0.0
description: The rule that a record-commit run carries every file it is given or none, and the three checks that enforce it.
status: unverified
grounded_in:
  - source: the record-commit INDEX.md version 1.0.0 this was split from
---

# Every file or none

A record commit carries every file it is given, or none. A given file that would not change `origin/main` — its
content already equal, or every one of its log lines already there — refuses the whole run before anything is
committed, naming the file (`UNCHANGED path: ... was the edit saved in <repo>, or did another writer land it?`). When
another writer adds or changes one of the given files between this run's fetch and its push, the rebuilt attempt
refuses all of them with exit 2, whatever bytes that writer used.

Behind that, git's own staged list must name every given path, and the read-back checks that the pushed commit's
file list contains every given path, not only that each file's bytes match. A run that once committed one of
three files with exit 0 now stops at the first of those three checks, and each check alone is enough.
