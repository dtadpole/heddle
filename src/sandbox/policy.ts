import { tmpdir } from 'node:os'

import { canonical } from './paths.ts'

/**
 * The sandbox policy: the value every consumer is decided against.
 *
 * The vocabulary and the writable-root list live here rather than in the service because the service, the
 * filesystem fence and each kernel profile all consume them, and DSH's lesson is that one home is what keeps the
 * kernel boundary and the in-process check from drifting.
 */

/**
 * How much of the filesystem a call may touch.
 *
 * The vocabulary is DSH's, taken as-is because it is already the right three
 * words: `read-only` permits only the required sinks, `workspace-write` adds the
 * workspace and the host temp areas, and `danger-full-access` is the escape hatch
 * a person asks for by name. Reusing the words means a reader who knows one
 * harness knows this one.
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * The closed vocabulary, narrowest first.
 *
 * Order is part of the fact rather than a convenience: "wider" is what an escalation means, and the whole
 * reason full access is the one transition that needs an owner's confirmation is that it ranks above the
 * boundary the two confined modes keep.
 */
export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const

/** Whether a value is one of the three modes, so a stored or posted word cannot become a policy. */
export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === 'string' && (SANDBOX_MODES as readonly string[]).includes(value)
}

/** Where a mode sits on the ladder: 0 read-only, 1 workspace-write, 2 danger-full-access. */
export function sandboxModeRank(mode: SandboxMode): number {
  return SANDBOX_MODES.indexOf(mode)
}

/** One resolved policy, which is what a check is actually decided against. */
export interface SandboxExecutionPolicy {
  readonly mode: SandboxMode
  readonly workspaceRoot: string
  /** Extra absolute roots a write may also reach, named one by one. */
  readonly extraWritableRoots: readonly string[]
}

/**
 * The writable-root set, which is **the** fact the fence and every kernel profile share.
 *
 * DSH's helper is the model, and heddle adopts its answer for `workspace-write`: the workspace, the extra roots
 * this project allows a profile to name, and the host temp areas (`/tmp` and `os.tmpdir()`), canonicalised
 * because Seatbelt matches resolved paths. `read-only` has no writable root (`/dev/null` is a literal exception
 * in each profile, not a root), and `danger-full-access` is not a root set at all — the provider is never
 * consulted in that mode.
 *
 * Measured on this machine: `/tmp` on macOS resolves to `/private/tmp`, so the canonical form is the one a
 * Seatbelt `(subpath …)` must carry.
 */
export function writableRoots(policy: SandboxExecutionPolicy): readonly string[] {
  if (policy.mode !== 'workspace-write') return []
  const roots = [policy.workspaceRoot, ...policy.extraWritableRoots, '/tmp', tmpdir()].map((root) => canonical(root))
  return [...new Set(roots)]
}

/**
 * The policy as one model-visible sentence.
 *
 * DSH contributes a `sandbox:policy` runtime-context snapshot before each request so the model knows the standing
 * file policy instead of learning it from a denial. This is heddle's version of the same statement, with the same
 * capability-neutral framing: it names the mode and, under `workspace-write`, the workspace the mode promises. It
 * deliberately does not enumerate mounted backends — the denial a tool returns is where a refusal is explained.
 */
export function sandboxPolicyStatement(policy: SandboxExecutionPolicy): string {
  switch (policy.mode) {
    case 'read-only':
      return 'Current heddle file policy: read-only. Any available operation enforced by heddle’s file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial guidance it returns.'
    case 'workspace-write':
      return `Current heddle file policy: workspace-write. Any available operation enforced by heddle’s file sandbox may modify files under the session workspace: "${policy.workspaceRoot}". The host temp areas may also be writable.`
    case 'danger-full-access':
      return 'Current heddle file policy: danger-full-access. The heddle file sandbox does not restrict file modifications by available operations.'
  }
}
