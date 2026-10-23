---
title: The heddle binary sources
version: 0.2.0
description: The sources of the Rust port's binary and composition root, with their unit tests beside the code.
grounded_in:
  - source: rust/ULTIMATE_GOAL.md
  - source: src/cli.ts, src/boot.ts and src/app.ts of the TypeScript build
---

# `rust/crates/heddle/src`

The sources of the binary. Unit tests live beside the code in `#[cfg(test)]` modules, as Rust does; the
verifiers judge the built binary from outside. Run them with
`cargo test --manifest-path rust/Cargo.toml -p heddle`.

## What belongs in it

| File | What it is |
|---|---|
| [`main.rs`](main.rs) | the process shell: hands `run` the arguments, environment, working directory and streams, and turns the `Exit` into a process exit code |
| [`lib.rs`](lib.rs) | the library root: `Invocation`, `Exit`, `run` |
| [`cli.rs`](cli.rs) | the command line: `Args`, `parse_args`, the layer request (`parseArgs`, `baseLayer`, `hasProfile`) |
| [`usage.rs`](usage.rs) | the help, line by line, gated by the capabilities the binary serves |
| [`boot.rs`](boot.rs) | the boot and the loader: composition through `heddle-config`, entries and fiber states started to a fixed point, `settle`, `failed_entries`, `dispose`, the printed tree |
| [`builtins.rs`](builtins.rs) | the built-in table, how a row's `name` resolves, the `Component` and `Catalog` traits |
| [`services.rs`](services.rs) | the service registry: a name with typed views, the injection gate |
| [`ports.rs`](ports.rs) | what the binary asks of each crate, one trait per service |
| [`commands.rs`](commands.rs) | every command and its dispatch, the configuration commands delegating to `heddle-config`, and the hook points `hooks` lists |
| [`output.rs`](output.rs) | the two streams a run writes to, and `JSON.stringify(value, null, 2)` |

## Read next

[`../INDEX.md`](../INDEX.md) for the crate, its public API and its port plan.
