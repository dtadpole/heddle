---
title: Build output sweep
created: 2026-10-29T15:11:15Z
modified: 2026-10-29T15:11:15Z
level: L2
version: 1.0.0
description: How deps-sweep removes the superseded heddle artifacts every cargo build leaves in target/*/deps. It covers the runner's hook after a successful build, what is kept, and the sweep of every worktree.
status: unverified
grounded_in:
  - source: 'coordinator request 2026-10-29: stale hashed heddle test binaries and rlibs piled up in rust/target/debug/deps, 4,168 files older than 3 hours, 5.5 GB across the worktrees, the disk losing about 70 MB a minute'
---

# Build output sweep

Each cargo build writes new hashed heddle test binaries and rlibs into `target/<profile>/deps` and never
removes the old ones. On 29 October that came to 5.5 GB across the worktrees.

**After every successful build**, the slot runner (`run`) calls `deps-sweep.mjs` on the target that cargo
used. That is `CARGO_TARGET_DIR`, else the folder beside `--manifest-path`, else `./target` next to a
`Cargo.toml`. A failed build sweeps nothing, and a sweep never changes the build's status. Set
`LOCAL_BUILD_DEPS_SWEEP=0` to skip it.

**What goes:** an artifact named `[lib]heddle<crate>-<16 hex>[.ext]` once a newer one with the same name and
extension exists and it is over an hour old. The age covers a crate whose lib and bin tests share a name, so
the pair from one build is never split.

**What stays:** the newest of each name, third-party crates, and any deps folder that a running process names
(a live rustc's `--out-dir`).

`_tools_/local-build/deps-sweep --all` sweeps every worktree in `git worktree list`. `--target <dir>`
sweeps one target, `--age-minutes n` changes the age, and `--dry-run` lists only.
