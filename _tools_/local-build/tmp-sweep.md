---
title: TMPDIR sweep
created: 2026-10-29T14:25:54Z
modified: 2026-10-29T14:25:54Z
level: L2
version: 1.0.0
description: What tmp-sweep removes from the user TMPDIR after a gate, what it keeps, and why. It covers the four kinds of leftovers, the two-hour age, and live browser profiles.
status: unverified
grounded_in:
  - source: 'coordinator request 2026-10-29: the user TMPDIR held 41,000 entries (16,000 heddle-* test dirs, 24,000 com.google.Chrome*, hd-*-browser-* profiles of 130 MB); add a tmp-sweep seats run after a gate'
---

# TMPDIR sweep

Tests and browser runs leave scratch entries in the user TMPDIR (`/var/folders/.../T`). On 29 October it held
41,000 entries. Run `_tools_/local-build/tmp-sweep` after a gate. It removes four kinds of entry once they are
older than two hours:
- `heddle-*`: unit, server and verifier scratch folders;
- `hd-*-browser-*`: browser profiles from seats' own runs, about 130 MB each;
- `scoped_dir*` and `com.google.Chrome*`: what Chrome itself leaves.

It keeps two kinds:
- **Young entries.** An entry's age is the newest mtime of the entry and its direct children, so a folder still
  being written is young.
- **Live entries.** An entry named on a running process's command line is kept, such as a browser's
  `--user-data-dir`.

`--dry-run` lists only, `--age-minutes n` changes the age, and `--dir` sweeps another folder. It exits 0, or 1
when an entry could not be removed (the first ten errors are printed), or 64 on a usage error.

The sweep treats the symptom. The cause is code that never removes its scratch folder: a test should remove
it in an `after` hook or a `finally`, so that a failing test removes it too.
