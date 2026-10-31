---
title: Load check verdict and exit codes
created: 2026-10-24T05:01:48Z
modified: 2026-10-31T07:45:00Z
level: L2
version: 1.5.0
description: When a load-check line warns or stops and why, how to override a threshold for one run, and the exit codes.
status: unverified
grounded_in:
  - source: _tools_/load-check/INDEX.md version 1.1.0, the entry point this was split from
---

# Verdict and exit codes

## What warns and what stops

- **disk** — the working model removes release artifacts below 26 GB, and below 16 GB nothing new starts
  (D-067, which moved D-064's disk gate from 20 GB; between 16 and 20 GB the coordinator sweeps every pass), so
  those are the warn and stop lines.
- **team** — over 1.0/core is a warn and 1.3 a stop. **The verdict follows this figure**, not the load line,
  so Spotlight or Chrome cannot make the coordinator throttle the team.
- **memory** — D-064's gate: `memory_pressure` free under 25% is a stop, nothing new starts. Under 30% it
  warns.
- **swap** — no gate (D-064): macOS keeps stale pages in swap and grows it on demand, so used, total and free
  are printed as detail only.
- **slots** — a stale slot is a warning even though the next command will reclaim it: something died.

Thresholds are the constants at the top of the script and can be overridden for a single run with
`LOAD_CHECK_DISK_WARN_GB`, `LOAD_CHECK_DISK_STOP_GB`, `LOAD_CHECK_LOAD_WARN_PER_CORE`,
`LOAD_CHECK_LOAD_STOP_PER_CORE` (the system line), `LOAD_CHECK_TEAM_WARN_PER_CORE`,
`LOAD_CHECK_TEAM_STOP_PER_CORE` (the verdict), `LOAD_CHECK_MEM_WARN_PCT`, `LOAD_CHECK_MEM_STOP_PCT` and
`LOAD_CHECK_SLOTS`.

## Exit codes

| Code | Meaning | What the coordinator does |
|---|---|---|
| `0` | ok | nothing |
| `1` | warn | one review of patience: no new heavy work, look at the stale slot; a memory warn alone allows one start (D-064) |
| `2` | stop | report to the owner; the working model's stop conditions are met |
| `3` | the check itself failed | fix the check; its message says which command it could not read |
