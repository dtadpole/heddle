---
title: Verifier 4 — Pluggable Tools
version: 1.9.0
description: tools are configurable and pluggable.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, listing the ten verifiers
---

# `40-pluggable-tools`

Instance of this project's `_verifiers_`. **The claim it decides:** tools are configurable and pluggable.

The extension point is the claim, not the catalogue. This part judges that a configuration chooses which tools exist, that a tool from outside this project can be added without editing `src/`, that every tool carries a description the model can read, and that a configuration naming a tool that does not exist fails where it is written.

## Where it runs

**No browser.** The checks drive the CLI, a scripted endpoint or a local HTTP double; nothing here needs
a display or a window.

## What decides it

`check-tools.mjs` lists and calls the built-in tools, and `check-plugins.mjs` adds a fixture tool through a layer file.
`check-bash-timeout.mjs` holds a bash call's own `timeoutMs` to DSH's rule: a value that is not a finite positive number
is refused and the command does not run, a larger one is cut to the tools row's `bashMaxTimeoutMs` (DSH's `maxTimeoutMs`,
ten minutes by default; live-testing issue #13).
`check-read-errors.mjs` holds a failed `read_file` to DSH's sentences: a missing file is `FS_NOT_FOUND` and a directory
`FS_NOT_REGULAR_FILE`, each naming the path (live-testing issue #4), and a file that is not UTF-8 text `FS_NOT_TEXT`,
`cannot read "<path>": invalid UTF-8 text`, as DSH's fatal decode says it (live-testing issue #234: the TypeScript
build read it with replacement characters, the Rust build refused it unnamed as `TOOL_FAILED`).
`check-write-errors.mjs` holds a write aimed at a folder to DSH's sentence (`dsh-fs-local` writeText): `FS_NOT_REGULAR_FILE`,
`cannot write "<path>": not a regular file`, with the folder and its contents left as they were (live-testing issue
#237: the TypeScript build returned Node's raw `EISDIR` text and the Rust build `Is a directory (os error 21)` unnamed).
`check-list-errors.mjs` holds a failed `list_dir` to DSH's sentences (`dsh-fs-local` listDirectory): a missing folder is
`FS_NOT_FOUND` and a file `FS_NOT_DIRECTORY`, each `cannot list "<path>": …`, and one dangling symbolic link in a folder
is listed by name instead of failing the whole listing (live-testing issue #223).
`check-list-links.mjs` holds a symbolic link in a listing to what it points at, as DSH's `stat` probe follows it: a
link to a folder is `link/` and a link to a file is a file of the target's size (live-testing issue #229: the
TypeScript build listed a link to a folder as a file of the folder's size).
`check-bash-streams.mjs` holds a finished bash call's stderr to its own section, as DSH's renderResult marks it: stdout,
a newline when stdout does not end in one, then `[stderr]` and the stderr text, in success and below a failure's error
line alike (live-testing issue #246: both builds glued the streams, `printf out; printf err >&2` came back `outerr`).
`check-list-order.mjs` holds a listing to DSH's order, `name.localeCompare` (ICU collation), which the TypeScript
build shares: case and accents sort with their letters, punctuation and digits before letters in ICU's order, and
names that collate equal in byte order (live-testing issue #247: the Rust build sorted by bytes). Its expected orders
are English collation; under a Node that resolves another locale it reports itself unjudged.
`check-read-window.mjs` holds `read_file`'s line window to DSH's read (`dsh-tool-fs`): a 1-based `offset` and a
`limit` answered with DSH's numbered envelope and a footer naming the offset to continue from or the end of the file,
FS_NOT_FOUND for an offset past the end, DSH's sentence for a limit over 2000, and a file over one default window
(2000 lines or 50 KB) no longer returned whole; a small file read without a window still reads as its exact text, the
stated difference (live-testing issue #263: the tool took only a path).
Those seven share `fs-tool-turn.mjs`, which is not a check: it writes a self-contained profile that allows the one tool
under test and runs one scripted turn that calls it once, returning the tool results and what the disk holds afterwards.
`check-utf8-chunks.mjs` holds bash output to whole characters when a UTF-8 sequence arrives split across chunks
(live-testing issue #96: the TypeScript build decoded each chunk alone).
`check-output-limit.mjs` holds bash output to the tools row's `bashOutputLimit`: a cut keeps the **end** of the output
and names a file holding all of it, `[output truncated; full output: <path>]`, as DSH's bash does (live-testing issue #83).
`check-failed-output.mjs` holds a failed bash call to keeping what it printed: the error line first, then its stdout
and stderr, as DSH's renderResult keeps the body of a non-zero exit (live-testing issue #82).
`check-stdin-eof.mjs` holds a bash command that reads stdin to end-of-file at once, as DSH's shell leaves stdin closed.
It covers a harness started with its own stdin ignored and one started with an open pipe on stdin, which the command
must not inherit (live-testing issue #97).

## Under `HEDDLE_BIN`

The TypeScript build loads each fixture tool as a `.ts` plugin; a Rust binary cannot load TypeScript, so under
`HEDDLE_BIN` each fixture tool is a **process** instead — part 4's Rust shape in `rust/ULTIMATE_GOAL.md`. The row
names a component manifest beside the profile, in the shape D-031 froze:

```yaml
# shout-tool.component.yml; the row is `name: ./shout-tool.component.yml`
program: "/path/to/node"
args:
  - ./shout-tool.mjs
```

The script speaks line-delimited JSON-RPC 2.0 on stdio (`rust/crates/heddle-tools/PROTOCOL.md`). It answers
`initialize` with the spec its plugin registers, and each `tools/call` the way the plugin's `run` does: `shout`
asks the host `sandbox/assertWritable` for `shout.txt` under the workspace root before writing it, the shadowing
script declares `read_file`, and the malformed one declares `{"name":"","description":""}`. The claims, the `.ts`
fixtures and their verdicts on the TypeScript build are unchanged.

The processes are judged on their own by [`_tests_/process-tools/`](_tests_/process-tools/INDEX.md), which drives each
over the protocol with the suite playing the host, so a failed check under `HEDDLE_BIN` is the binary's:

```bash
node --test _verifiers_/40-pluggable-tools/_tests_/process-tools/unit.test.mjs
```

## Running it

```bash
sh verify.sh            # every check, with the verdict
sh verify.sh --list     # the check names, and why any was unjudged
sh verify.sh --json     # one parseable object
```

Exit `0` when the claim holds, `1` when it fails, `3` when it could not be judged. A
claim that could not be judged is never reported as holding, which is the runner's
whole reason for existing — see [`_tools_/verify-runner/`](../../_tools_/verify-runner/INDEX.md).

## What it deliberately does not judge

- **How well a model reasons.** Nothing here scores an answer's quality; the checks
  ask whether the mechanism works.
- **Anything it has to spend to see.** Except where a check is named for the real
  backend, every fixture is local and the run is free.

## Read next

[`../INDEX.md`](../INDEX.md) for the verifications, and
[`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the part this one decides.
