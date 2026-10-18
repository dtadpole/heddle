import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

import { canonical } from './paths.ts'

import type { ConfinedArgv, SandboxBackend, SandboxEnforcement } from './backend.ts'
import { writableRoots, type SandboxExecutionPolicy } from './policy.ts'

/**
 * The Linux rungs: bubblewrap first, Landlock second, both behind the same backend contract.
 *
 * The profiles are DSH's, read from `dsh-sandbox-local/lib/index.js`. The launchers are **not** bundled with
 * heddle — bubblewrap is a standard system binary, and Landlock's launcher is a versioned external executable
 * (`landlock-run`) that DSH ships as a platform package. A missing launcher therefore probes unusable and the
 * call fails closed, which is the honest answer on a host heddle cannot confine.
 */

/** The stderr dialect bubblewrap's kernel speaks for a denied write. */
const BWRAP_DENIAL_SIGNATURES = ['read-only file system'] as const
/** bubblewrap's own fatal diagnostics; a failed runner means the command never ran. */
const BWRAP_RUNNER_FAILURE_RULES = [{ fatalSignatures: ['bwrap: '] as const }] as const

/** The Landlock launcher's own exit code and diagnostic, part of its CLI contract. */
export const LANDLOCK_FAILURE_EXIT = 125
const LANDLOCK_DENIAL_SIGNATURES = ['permission denied'] as const
const LANDLOCK_RUNNER_FAILURE_RULES = [
  { allowedExitCodes: [LANDLOCK_FAILURE_EXIT] as const, fatalSignatures: ['landlock-run: '] as const },
] as const

/**
 * The bubblewrap profile arguments for one policy — DSH's own argv.
 *
 * A read-only bind of the host root with a fresh `/dev`, a private PID namespace and a private procfs, then, for
 * `workspace-write`, an **ephemeral** `/tmp` and a writable bind for every writable root other than `/tmp` (the
 * tmpfs covers that one). Dying with the parent keeps a killed turn from leaving a confined child behind.
 */
export function bwrapProfileArgs(policy: SandboxExecutionPolicy): readonly string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    /** DSH's shape: an ephemeral `/tmp` as the temp area, then a writable bind for the workspace and extras. */
    args.push('--tmpfs', '/tmp')
    const tempRoots = new Set([canonical('/tmp'), canonical(tmpdir())])
    for (const root of writableRoots(policy)) {
      if (tempRoots.has(root)) continue
      args.push('--bind', root, root)
    }
  }
  return args
}

/** bubblewrap's backend: the profile above, a functional probe, and its denial dialect. */
export function bwrapBackend(options: { readonly command?: string; readonly probeTimeoutMs?: number; readonly probe?: () => boolean } = {}): SandboxBackend {
  const command = options.command ?? 'bwrap'
  const probeTimeoutMs = options.probeTimeoutMs ?? 5_000
  let verdict: boolean | undefined
  const probe = (): boolean => {
    if (options.probe !== undefined) return options.probe()
    if (verdict !== undefined) return verdict
    const result = spawnSync(command, [...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/', extraWritableRoots: [] }), '--', '/usr/bin/true'], {
      timeout: probeTimeoutMs,
      stdio: 'ignore',
    })
    verdict = result.status === 0
    return verdict
  }
  return {
    name: 'bwrap',
    probe,
    confine(argv, policy): ConfinedArgv {
      return {
        argv: [command, ...bwrapProfileArgs(policy), '--', ...argv],
        enforcement: 'full',
        denialSignatures: [...BWRAP_DENIAL_SIGNATURES],
        runnerFailureRules: BWRAP_RUNNER_FAILURE_RULES.map((rule) => ({ fatalSignatures: [...rule.fatalSignatures] })),
      }
    },
  }
}

/**
 * The Landlock launcher's grant arguments: read-only roots first, then read-write roots, as its CLI contract
 * requires (`--ro <path>` / `--rw <path>`, before the `--` separator).
 */
export function landlockGrantArgs(policy: SandboxExecutionPolicy): readonly string[] {
  const readWrite = [normalisedDevNull(), ...writableRoots(policy)]
  return ['--ro', '/', ...readWrite.flatMap((root) => ['--rw', root])]
}

/** `/dev/null` is a device node; the launcher's grant is a path, and the literal is what every profile allows. */
function normalisedDevNull(): string {
  return '/dev/null'
}

/**
 * The Landlock backend over an operator-supplied launcher path.
 *
 * The path is configuration (a profile row), never an ambient environment variable: which binary confines a
 * process must not be decidable by the environment a session happened to inherit. Without a path the rung is
 * unavailable and selection moves on (or fails closed).
 */
export function landlockBackend(options: { readonly runner?: string; readonly probeTimeoutMs?: number; readonly probe?: () => 'full' | 'partial' | 'unusable' } = {}): SandboxBackend | undefined {
  const runner = options.runner
  if (runner === undefined && options.probe === undefined) return undefined
  const probeTimeoutMs = options.probeTimeoutMs ?? 5_000
  let verdict: { usable: boolean; enforcement: SandboxEnforcement } | undefined
  const runProbe = (): { usable: boolean; enforcement: SandboxEnforcement } => {
    if (options.probe !== undefined) {
      const answer = options.probe()
      return { usable: answer !== 'unusable', enforcement: answer === 'partial' ? 'partial' : 'full' }
    }
    if (verdict !== undefined) return verdict
    const result = spawnSync(runner as string, ['--probe'], { timeout: probeTimeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    verdict =
      result.status === 0
        ? { usable: true, enforcement: /partially enforced/.test(result.stdout ?? '') ? 'partial' : 'full' }
        : { usable: false, enforcement: 'full' }
    return verdict
  }
  return {
    name: 'landlock',
    probe: () => runProbe().usable,
    confine(argv, policy): ConfinedArgv {
      const enforcement = runProbe().enforcement
      return {
        argv: [runner as string, ...landlockGrantArgs(policy), '--', ...argv],
        enforcement,
        denialSignatures: [...LANDLOCK_DENIAL_SIGNATURES],
        runnerFailureRules: LANDLOCK_RUNNER_FAILURE_RULES.map((rule) => ({
          allowedExitCodes: [...rule.allowedExitCodes],
          fatalSignatures: [...rule.fatalSignatures],
        })),
      }
    },
  }
}

/**
 * The Linux chain, in DSH's order: bubblewrap when it can enforce a profile, otherwise the Landlock rung when a
 * launcher is configured and probes, otherwise `undefined` — and the caller fails closed.
 *
 * Exported with the candidates as parameters so the order is judged without spawning anything.
 */
export function selectLinuxBackend(bwrap: SandboxBackend = bwrapBackend(), landlock: SandboxBackend | undefined = landlockBackend()): SandboxBackend | undefined {
  if (bwrap.probe()) return bwrap
  if (landlock !== undefined && landlock.probe()) return landlock
  return undefined
}
