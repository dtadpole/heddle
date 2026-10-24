---
title: The judge
created: 2026-10-24T05:55:00Z
modified: 2026-10-24T05:55:00Z
level: L3
version: 1.0.0
description: Why run.mjs exists rather than plain node --test, how to run it, the mapping it implements, and why it shares an instance with the library.
status: unverified
grounded_in:
  - source: human-authored
  - source: measurement on Node v24.19.0, a suite whose checks all skip exits 0
---

# The judge, `run.mjs`

**Why it exists rather than plain `node --test`.** Measured on Node v24.19.0: a suite whose checks all skip exits
`0`. That is the one answer that must never be given for "nothing was judged", and it is the whole reason this
wrapper exists. A part of the goal that is not built yet must read as unjudged, never as holding.

```bash
node _tools_/verify-runner/run.mjs _verifiers_/10-llm-backends/check-model-service.mjs
node _tools_/verify-runner/run.mjs <check> --list    # the check names, and why any was unjudged
node _tools_/verify-runner/run.mjs <check> --json    # one parseable object
```

`--list` and `--json` return the same verdict as a plain run, because the verdict is the result rather than a side
effect of printing.

**The mapping is the claim**, so `classify` is exported and documented: no checks at all is `3`, any failure is `1`,
any skip is `3`, and only a run where every check passed is `0`. It is component-tested without running a check:
`node --test _tools_/verify-runner/_tests_/verdict-rules/unit.test.mjs` pins `classify`, `tapCounts` and
`collectNames` with nine tests that spawn nothing.

**Why the judge and the library share an instance.** They are one job with two audiences: the judge is a command,
the library is a library, and a reader looking for either starts at the same place. The boundary that matters is the
process, not the folder:

- `run.mjs` is invoked by every `verify.sh` (`node _tools_/verify-runner/run.mjs <check>`) and is **never imported by
  a check**, so a check cannot reach into the decision about its own score. `classify` is exported only for the
  component tests.
- `run.mjs` stays dependency-free — no browser, no harness modules — while `lib.mjs` and `browser.mjs` carry the
  transcript decoder and the tool. The judge's dependencies are the judge's own.
