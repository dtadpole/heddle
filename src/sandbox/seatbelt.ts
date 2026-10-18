import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

import type { ConfinedArgv, SandboxBackend } from './backend.ts'
import { writableRoots, type SandboxExecutionPolicy } from './policy.ts'

/**
 * The macOS Seatbelt rung — the one this machine can judge.
 *
 * The profile is DSH's, measured and probed here rather than remembered: allow-default, deny every write, keep
 * `/dev/null` as the one literal sink a shell expects, and grant one canonical `(subpath …)` per writable root.
 * `sandbox-exec` rides Apple's deprecated private policy engine; the functional probe is what fails closed if
 * the command ever disappears.
 */

/** Where macOS ships the runner. Named rather than looked up: a PATH entry must not be able to change the boundary. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

/** The stderr dialect macOS speaks for a denied write, measured: `Operation not permitted`. */
const DENIAL_SIGNATURES = ['operation not permitted'] as const

/** The runner's own fatal diagnostics. `sandbox-exec` exits non-zero when it refuses a profile and says so here. */
const RUNNER_FAILURE_RULES = [{ fatalSignatures: ['sandbox-exec: '] as const }] as const

/** Quote one path as an SBPL string literal, so a path cannot end the string early. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * The SBPL profile arguments for one policy.
 *
 * Exported because it is the part that can be silently wrong: the roots are canonical (Seatbelt matches resolved
 * paths, so `/tmp` is `/private/tmp`), and a profile that lists the wrong set governs the wrong set while looking
 * perfectly reasonable.
 */
export function seatbeltProfileArgs(policy: SandboxExecutionPolicy): readonly string[] {
  const forms = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (literal ${sbplString('/dev/null')}))`,
  ]
  const roots = writableRoots(policy)
  if (roots.length > 0) forms.push(`(allow file-write* ${roots.map((root) => `(subpath ${sbplString(root)})`).join(' ')})`)
  return ['-p', forms.join(' ')]
}

/** A Sealtbelt backend over a runner path and a probe; the options exist so a test can judge selection and absence. */
export function seatbeltBackend(options: { readonly exec?: string; readonly probeTimeoutMs?: number } = {}): SandboxBackend {
  const exec = options.exec ?? SANDBOX_EXEC
  const probeTimeoutMs = options.probeTimeoutMs ?? 5_000
  /** The verdict is a functional probe, cached for this backend's lifetime — DSH's rule. */
  let verdict: boolean | undefined

  const probe = (): boolean => {
    if (verdict !== undefined) return verdict
    if (!existsSync(exec)) {
      verdict = false
      return verdict
    }
    /**
     * Apply the **real read-only profile** around `true`: exit 0 means the kernel accepted and enforced it.
     * `sandbox-exec` exits non-zero when `sandbox_init` refuses a profile, so a broken profile cannot be mistaken
     * for a usable rung.
     */
    const result = spawnSync(
      exec,
      [...seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: '/', extraWritableRoots: [] }), '--', '/usr/bin/true'],
      { timeout: probeTimeoutMs, stdio: 'ignore' },
    )
    verdict = result.status === 0
    return verdict
  }

  return {
    name: 'seatbelt',
    probe,
    confine(argv, policy): ConfinedArgv {
      return {
        argv: [exec, ...seatbeltProfileArgs(policy), '--', ...argv],
        enforcement: 'full',
        denialSignatures: [...DENIAL_SIGNATURES],
        runnerFailureRules: RUNNER_FAILURE_RULES.map((rule) => ({ fatalSignatures: [...rule.fatalSignatures] })),
      }
    },
  }
}
