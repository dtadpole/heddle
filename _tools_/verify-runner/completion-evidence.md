---
title: Harness Verification Evidence
level: L0
version: 1.0.0
description: Records the complete verifier sweep and the final trajectory regression recheck without treating skipped checks as passing.
status: verified
grounded_in:
  - source: full verifier sweep on 99ceaa4 and trajectory verifier recheck on df59673
  - source: unit, component, type, build and convention checks recorded during the same session
---

# Harness verification evidence

Measured on 2026-10-18 in `heddle-deploy`. The full sweep ran on `99ceaa4`; its only failed
verifier was the trajectory navigation assertion. `df59673` corrected its invalid starting position,
and the complete trajectory verifier passed after a negative control demonstrated that disabled
navigation still fails. No other source or verifier changed between those revisions.

All **17 verifier instances report exit 0**: **211 checks passed, zero failed, zero skipped,
zero cancelled and zero todo**. This covers all twelve parts in `ULTIMATE_GOAL.md` and the additional
trajectory, panel, preview, deployment and model-validation contracts. The historical 2026-10-11
measurement in `INDEX.md` is retained as history, not presented as today's evidence.

| Verifier | Checks | Exit |
|---|---:|---:|
| `05-config-system` | 10 | 0 |
| `10-llm-backends` | 8 | 0 |
| `20-streaming` | 5 | 0 |
| `30-context-management` | 8 | 0 |
| `40-pluggable-tools` | 6 | 0 |
| `50-agentic-loop` | 9 | 0 |
| `60-hooks` | 6 | 0 |
| `70-workspaces-sessions` | 45 | 0 |
| `75-permission-sandbox` | 17 | 0 |
| `80-web-ui` | 74 | 0 |
| `85-trajectory-view` | 2 | 0 |
| `87-resizable-panels` | 1 | 0 |
| `88-file-preview` | 3 | 0 |
| `90-web-ui-token` | 9 | 0 |
| `95-web-daemon` | 3 | 0 |
| `96-deployment` | 3 | 0 |
| `98-model-endpoints` | 2 | 0 |

## Independent checks

- `npm run check` passes source and test type checks.
- `npm test` passes 478 tests, with no skips.
- `npm run build` passes.
- `node --test _tools_/*/_tests_/*/unit.test.mjs` passes 50 component tests, with no skips.
- Reflection's convention linter reports 83 folders checked, zero errors and zero warnings, using
  `--generated dist` and the shared type vocabulary rather than a copied linter.
- The daemon verifier kills the installed service and observes launchd recovery within its bounded
  window. A separate deployment recheck after that restart passes all three checks.
- The deployment working tree is clean, on `main`, with changes committed and pushed.

## Run conditions and scope

Browser checks ran **headless** with the UI target enabled. `HEDDLE_VERIFY_UI=0` was not used and skips
were never allowed to count as passing. The macOS system directories `/usr/sbin` and `/sbin` were on
`PATH` so the installed-service probe could actually invoke `lsof` rather than report an unobserved
service. The real configured backend answered its check, and the model endpoint verifier judged the
fresh machine-local validation record without committing endpoint addresses or credentials.

Detailed command outputs are under the ignored repository runtime directory
`.heddle-tmp/goal-faa8a5ad/checks/`. The aggregate `verified-summary.json` identifies each log and
its counters. Historical screenshots remain unchanged; new browser captures use separate allocations
under `.heddle-tmp/verifier-evidence/`. Those runtime paths are local evidence, not portable tracked files.

This records observed satisfaction of the requested checks. It does not ratify the owner's wording of
`ULTIMATE_GOAL.md`, claim universal provider support, or transfer the owner's reserved authority over
that document's `goal_state` field. The session's operational goal can close on the requested verification
objective without rewriting that separate declaration.
