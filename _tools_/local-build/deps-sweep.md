---
title: Build output sweep
created: 2026-10-29T15:11:15Z
modified: 2026-11-01T17:20:00Z
level: L2
version: 1.1.0
description: How deps-sweep removes the superseded heddle artifacts every cargo build leaves in target/*/deps. It covers the runner's hook after a successful build, what is kept, the sweep of every worktree, and --floor, which removes idle debug targets when the disk is under 18 GiB.
status: unverified
grounded_in:
  - source: 'coordinator goal 2026-11-01: deps-sweep --floor removes rust/target/debug folders unwritten for 30+ minutes that no process holds when the disk is under 18 GiB, listing each with its owner and notifying no one; the coordinator removed 2.5 to 3.2 GB of idle debug targets by hand on 31 October and 1 November and told the owners'
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

## Under the disk floor

`_tools_/local-build/deps-sweep --floor` acts only when the disk has less than 18 GiB free (`--floor-gib`),
read as df's Avail. Then it removes the whole `rust/target/debug` folder of each worktree in
`git worktree list` (`--repo` names the repository) when both hold:
- **Unwritten** for 30 minutes (`--age-minutes`). Its last write is the newest mtime of the folder, its entries
  and theirs (`deps/<file>`, `.fingerprint/<crate>`), and the scan stops at the first young one.
- **Not held.** No process has an open file or its working folder in it, such as cargo's `.cargo-lock` or a
  running test binary, and no command line names it. The process list is read again just before the
  removals, so a build that started while the sizes were measured keeps its folder. When the list cannot be
  read, nothing is removed.

It goes oldest first, takes `release/` and the rest of the target never, and passes over a `debug` that is a
link. It lists each folder with its owner, the time unwritten and the size, then who kept theirs (paths print
in full; `~` here):

```
deps-sweep --floor: disk 16.3 GiB free, under the 18 GiB floor: removed 2 rust/target/debug folder(s) unwritten for 30+ minutes, 2.6 GiB; disk 18.9 GiB free after. Owners are not told: tell them.
  removed ~/heddle--developer-three/rust/target/debug (owner developer-three, unwritten 6h48, 2.0 GiB)
  kept, written in the last 30 minutes: developer-eight, developer-nine
```

**It tells no one.** The coordinator tells the owners: their next build starts from scratch.

The owner comes from the roster's `resource_identity_ref` lines (`--roster`, else the
team's `TEAM.yaml` when this Mac has it). A folder belongs to the seat whose folder it is or
extends: `heddle--int-backend` is integrator-one's, `heddle--developer-eight-b10` developer-eight's. A nested
worktree belongs to the seat of the folder it is in. Under `/private/tmp`, an `hd/<seat>-...` branch names the
owner. Otherwise the folder's own name stands.

At or above the floor it prints one line and removes nothing. `--dry-run` lists only. It exits 1 when the free
space or the process list cannot be read or a removal failed, and 64 on a usage error.
