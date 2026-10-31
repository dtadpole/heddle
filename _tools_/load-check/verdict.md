---
title: Load check verdict and exit codes
created: 2026-10-24T05:01:48Z
modified: 2026-10-31T01:02:49Z
level: L2
version: 1.3.0
description: When a load-check line warns or stops and why, how to override a threshold for one run, and the exit codes.
status: unverified
grounded_in:
  - source: _tools_/load-check/INDEX.md version 1.1.0, the entry point this was split from
---

# Verdict and exit codes

## What warns and what stops

- **disk** — the working model removes release artifacts below 26 GB and stops below 20 GB, so those are
  the warn and stop lines.
- **team** — over 1.0/core is a warn and 1.3 a stop. **The verdict follows this figure**, not the load line,
  so Spotlight or Chrome cannot make the coordinator throttle the team.
- **memory** — D-061's gate: `memory_pressure` free under 25% is a stop, nothing new starts. Under 30% it
  warns.
- **swap** — macOS swap is sticky and grows, so the backstop is D-063's relative line: swap free (total minus
  used) under 1024M is a stop, and under 1280M a warn. Above the stop one build or browser gate may start, one at a time. The
  percent is detail only.
- **slots** — a stale slot is a warning even though the next command will reclaim it: something died.

Thresholds are the constants at the top of the script and can be overridden for a single run with
`LOAD_CHECK_DISK_WARN_GB`, `LOAD_CHECK_DISK_STOP_GB`, `LOAD_CHECK_LOAD_WARN_PER_CORE`,
`LOAD_CHECK_LOAD_STOP_PER_CORE` (the system line), `LOAD_CHECK_TEAM_WARN_PER_CORE`,
`LOAD_CHECK_TEAM_STOP_PER_CORE` (the verdict), `LOAD_CHECK_MEM_WARN_PCT`, `LOAD_CHECK_MEM_STOP_PCT`, `LOAD_CHECK_SWAP_FREE_WARN_MB`, `LOAD_CHECK_SWAP_FREE_STOP_MB` and
`LOAD_CHECK_SLOTS`.

## Exit codes

| Code | Meaning | What the coordinator does |
|---|---|---|
| `0` | ok | nothing |
| `1` | warn | one review of patience: no new heavy work, look at the stale slot; a memory or swap warn alone allows one start (D-061, D-063) |
| `2` | stop | report to the owner; the working model's stop conditions are met |
| `3` | the check itself failed | fix the check; its message says which command it could not read |
