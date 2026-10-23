---
title: Process Tools
version: 1.0.0
description: The three tool processes 40-pluggable-tools writes under HEDDLE_BIN, driven over the part-4 protocol with the suite playing the host.
grounded_in:
  - source: rust/crates/heddle-tools/PROTOCOL.md
  - source: _verifiers_/40-pluggable-tools/check-tools.mjs, whose generator and tool table the suite reads
---

# `process-tools`

Instance of [`_tests_`](../INDEX.md). Holds [`unit.test.mjs`](unit.test.mjs), which reads the process generator and
tool table out of [`check-tools.mjs`](../../check-tools.mjs) and drives each process the way a host would: the
manifest's `program` + `args` shape, `shout`'s declared spec and its `sandbox/assertWritable` question for the
workspace file before it writes the upper-cased text, a sandbox refusal returned as `SANDBOX` with nothing written,
the shadowing `read_file` and its answer, the malformed spec, and method-not-found for anything else. So a failed
check under `HEDDLE_BIN` is the binary's, not the fixture's.

## Run it

```bash
node --test _verifiers_/40-pluggable-tools/_tests_/process-tools/unit.test.mjs
```
