import { seatbeltBackend } from './seatbelt.ts'
import type { SandboxExecutionPolicy, SandboxMode } from './policy.ts'

/**
 * The sandbox backend contract, selection and outcome classification.
 *
 * This is DSH's seam, heddle-sized: a backend turns one per-call policy into a kernel runner invocation and
 * reports **what it actually governed** — enforcement completeness, the stderr dialect its kernel speaks when it
 * denies a write, and the signatures that mean the runner itself failed. The consumer (the `bash` tool) reports
 * the facts; it never negotiates permissions and never decides a mode.
 */

/** How completely a backend governs the policy's promised file effects. `partial` is a fact, not a warning. */
export type SandboxEnforcement = 'full' | 'partial'

/**
 * What a runner's own failure looks like: a fatal stderr signature, optionally gated on the exit code the runner
 * reserves for that failure. A runner failure means the command never ran, so it outranks a denial.
 */
export interface RunnerFailureRule {
  readonly allowedExitCodes?: readonly number[]
  readonly fatalSignatures: readonly string[]
}

/** One confined execution: the argv to spawn, and the facts needed to classify what it did. */
export interface ConfinedArgv {
  /** The wrapped argv: runner, profile arguments, separator, then the caller's argv. */
  readonly argv: readonly string[]
  readonly enforcement: SandboxEnforcement
  /** Case-insensitive stderr substrings this kernel produces for a denied file effect. */
  readonly denialSignatures: readonly string[]
  readonly runnerFailureRules: readonly RunnerFailureRule[]
}

/** One platform runner, selected once and probed on first use. */
export interface SandboxBackend {
  readonly name: 'seatbelt' | 'bwrap' | 'landlock'
  /**
   * Whether this runner can enforce a profile on this machine.
   *
   * A functional probe, cached for the backend's lifetime: the point is not that the binary exists but that the
   * kernel accepts and applies a real profile.
   */
  probe(): boolean
  /** Wrap one exact argv under the policy. */
  confine(argv: readonly string[], policy: SandboxExecutionPolicy): ConfinedArgv
}

/**
 * The fail-closed error: a confined mode was requested and no runner can enforce it.
 *
 * It is an error rather than a fallback because running the command unconfined after being asked to confine it
 * is the one outcome this mechanism exists to prevent. The message names what is missing so the reader is sent to
 * the platform's runner rather than to their command.
 */
export class SandboxUnavailableError extends Error {
  readonly mode: SandboxMode

  constructor(mode: SandboxMode, detail?: string) {
    super(
      `sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing kernel (Linux), or ensure sandbox-exec is usable (macOS).` +
        (detail !== undefined ? ` Runner failure: ${detail}` : ''),
    )
    this.name = 'SandboxUnavailableError'
    this.mode = mode
  }
}

/**
 * The platform runner chains, DSH's order: macOS has exactly one candidate, Linux prefers bubblewrap and falls
 * back to Landlock, and a platform with no chain fails closed. Candidates are probed only when there is more than
 * one (probing arbitrates; it does not re-validate a choice with no alternative), and the verdict is cached by the
 * backend instance.
 *
 * The Linux chain is wired in the next cycle of this loop (bubblewrap, then Landlock) — until then a Linux host
 * has no backend and a confined call fails closed, which is the honest answer rather than an unconfined run.
 */
export function selectBackend(platform: NodeJS.Platform | string = process.platform): SandboxBackend | undefined {
  switch (platform) {
    case 'darwin':
      return seatbeltBackend()
    case 'linux':
      return undefined
    default:
      return undefined
  }
}

/** What one command did, as far as the sandbox is concerned. */
export type SandboxOutcome =
  | { readonly kind: 'runner-failure'; readonly detail: string }
  | { readonly kind: 'denied' }
  | { readonly kind: 'exited' }

/** The facts classification needs: the process result and the wrapped call's dialects. */
export interface SandboxClassificationInput {
  readonly exitCode: number
  readonly stderr: string
  /** The wrapped call's dialects, or `null` for an unconfined call (which cannot be denied). */
  readonly confined:
    | {
        readonly denialSignatures: readonly string[]
        readonly runnerFailureRules: readonly RunnerFailureRule[]
      }
    | null
}

/**
 * Classify one settled command.
 *
 * The order is the mechanism: **a runner failure means the command never ran**, so it outranks a denial; a
 * denial is only a denial when the command **failed** and its stderr speaks the backend's dialect (a command
 * that merely prints `Operation not permitted` and exits 0 succeeded); anything else is an ordinary command
 * result the sandbox has no opinion about.
 */
export function classifyOutcome(input: SandboxClassificationInput): SandboxOutcome {
  const { exitCode, stderr, confined } = input
  if (confined === null) return { kind: 'exited' }
  const lines = stderr.split('\n')
  const mentions = (line: string, signature: string): boolean => line.toLowerCase().includes(signature.toLowerCase())

  for (const rule of confined.runnerFailureRules) {
    if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(exitCode)) continue
    for (const line of lines) {
      const fatal = rule.fatalSignatures.find((signature) => mentions(line, signature))
      if (fatal !== undefined) return { kind: 'runner-failure', detail: line.trim() }
    }
  }

  if (exitCode !== 0) {
    for (const line of lines) {
      if (confined.denialSignatures.some((signature) => mentions(line, signature))) return { kind: 'denied' }
    }
  }
  return { kind: 'exited' }
}
