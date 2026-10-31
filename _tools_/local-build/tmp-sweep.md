---
title: TMPDIR sweep
created: 2026-10-29T14:25:54Z
modified: 2026-10-31T04:20:00Z
level: L2
version: 1.1.0
description: What tmp-sweep removes from the user TMPDIR after a gate, what it keeps, and why. It covers the four kinds of leftovers, the two-hour age, live browser profiles, and the npm and uv cache sizes it reports but never removes.
status: unverified
grounded_in:
  - source: 'coordinator request 2026-10-31 04:02Z: the coordinator cleared the npm cache (2 GB) to stay above 20 GiB; report the npm and uv cache sizes, not delete them'
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

It also reports two caches by size, and never removes anything in them:
- the **npm cache**, `$npm_config_cache` or `~/.npm`;
- the **uv cache**, `$UV_CACHE_DIR`, or `uv` under `$XDG_CACHE_HOME` or `~/.cache`.

On 31 October they held 347 MiB and 2.1 GiB. Clearing one is the coordinator's call (`npm cache clean --force`,
`uv cache prune`), since every seat would refill it.

`--dry-run` lists only, `--age-minutes n` changes the age, `--dir` sweeps another folder, and `--no-caches` skips
the cache sizes. It exits 0, or 1
when an entry could not be removed (the first ten errors are printed), or 64 on a usage error.

The sweep treats the symptom. The cause is code that never removes its scratch folder: a test should remove
it in an `after` hook or a `finally`, so that a failing test removes it too.
