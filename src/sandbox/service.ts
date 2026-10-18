import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

import { SandboxUnavailableError, selectBackend, type ConfinedArgv, type SandboxBackend } from './backend.ts'
import { canonical, contains } from './paths.ts'
import {
  SANDBOX_MODES,
  isSandboxMode,
  sandboxModeRank,
  writableRoots,
  type SandboxExecutionPolicy,
  type SandboxMode,
} from './policy.ts'

export const name = 'sandbox'

export { SANDBOX_MODES, isSandboxMode, sandboxModeRank, writableRoots, type SandboxExecutionPolicy, type SandboxMode } from './policy.ts'
export { canonical } from './paths.ts'
export {
  SandboxUnavailableError,
  classifyOutcome,
  selectBackend,
  type ConfinedArgv,
  type SandboxBackend,
  type SandboxEnforcement,
  type RunnerFailureRule,
  type SandboxOutcome,
} from './backend.ts'

/** What a session-mode change consists of, as a value rather than a side effect. */
export type PermissionTransition =
  | { readonly ok: true; readonly mode: SandboxMode; readonly changed: boolean }
  | { readonly ok: false; readonly reason: string }

/**
 * The one rule that decides a session's mode change.
 *
 * It is a pure function on purpose: the Web UI, the HTTP route and the unit suite all judge the same rule
 * instead of each re-deriving it. The rule is DSH's, with one deliberate strengthening:
 *
 * - a mode outside the vocabulary is refused;
 * - choosing the mode already in effect changes nothing (`changed: false`), so a no-op appends no event;
 * - a **narrowing** needs no confirmation;
 * - widening to `workspace-write` needs no second prompt — the menu click is the owner's action, and
 *   `workspace-write` stays inside the same boundary;
 * - widening to **`danger-full-access`** is refused unless the request carries the explicit confirmation
 *   token. The reference gates that in its client only; here the server refuses it too, so a stale page or
 *   a script cannot widen access by accident.
 *
 * A tool call can never reach this function: no tool argument names a mode, and the only caller is the
 * owner's API route. That is what "an escalation is an explicit owner action, never a side effect" means.
 */
export function permissionTransition(current: SandboxMode, target: unknown, confirmation: unknown): PermissionTransition {
  if (!isSandboxMode(target)) {
    return { ok: false, reason: `'${String(target)}' is not one of ${SANDBOX_MODES.join(', ')}` }
  }
  if (target === current) return { ok: true, mode: current, changed: false }
  const escalates = sandboxModeRank(target) > sandboxModeRank(current)
  if (escalates && target === 'danger-full-access' && confirmation !== 'full-access') {
    return {
      ok: false,
      reason: "widening to 'danger-full-access' needs the owner's explicit confirmation; send confirm: 'full-access' only after the risk gate has been acknowledged",
    }
  }
  return { ok: true, mode: target, changed: true }
}

/** Why a path was refused, with enough detail to show the user. */
export class SandboxDenial extends Error {
  readonly path: string
  readonly mode: SandboxMode
  readonly workspaceRoot: string

  constructor(message: string, options: { path: string; mode: SandboxMode; workspaceRoot: string }) {
    super(message)
    this.name = 'SandboxDenial'
    this.path = options.path
    this.mode = options.mode
    this.workspaceRoot = options.workspaceRoot
  }
}

export const Config = Schema.object({
  /** `read-only`, `workspace-write` or `danger-full-access`. */
  mode: Schema.union([
    Schema.const('read-only' as const),
    Schema.const('workspace-write' as const),
    Schema.const('danger-full-access' as const),
  ]).default('workspace-write'),
  /** The directory writes are confined to. Defaults to the process's directory. */
  workspaceRoot: Schema.string(),
  /** Extra absolute roots a write may also reach, named one by one (in addition to the host temp areas). */
  extraWritableRoots: Schema.array(Schema.string()).default([]),
  /**
   * Which runner may confine a shell call.
   *
   * `auto` selects the platform's backend (Seatbelt on macOS; the Linux chain in its own cycle) and probes it
   * once. `none` forces the absence of a backend, which is what the fail-closed check uses: a confined call must
   * then refuse to run rather than run unconfined.
   */
  backend: Schema.union([Schema.const('auto' as const), Schema.const('none' as const)]).default('auto'),
  /**
   * Absolute path to the Landlock launcher on Linux.
   *
   * heddle does not bundle the versioned external binary DSH ships as a platform package, and which binary
   * confines a process must not be decidable by an ambient environment variable, so the path is configuration.
   * Unset means the Landlock rung is unavailable and the Linux chain fails closed without bubblewrap.
   */
  landlockRunner: Schema.string(),
})

export interface Config {
  readonly mode?: SandboxMode
  readonly workspaceRoot?: string
  readonly extraWritableRoots?: readonly string[]
  readonly backend?: 'auto' | 'none'
  readonly landlockRunner?: string
}

/**
 * The sandbox service.
 *
 * Two jobs, one policy. For the harness's own file tools it is an **in-process fence**: may this path be written —
 * answered by comparing canonical paths rather than string prefixes, because `/tmp/workspace-2` starts with
 * `/tmp/workspace` as a string and a symlink inside the workspace to `/etc` is the other half of the same trap. For
 * a shell it is a **backend seam**: it hands the caller a kernel-wrapped argv and the facts needed to classify the
 * result.
 *
 * It is deliberately still not an OS-level confinement of its own: on macOS that is Seatbelt, behind the backend
 * seam; on Linux it will be bubblewrap/Landlock in their own cycle. Saying which of the two layers a call is
 * governed by matters more than appearing stronger than it is.
 */
export class SandboxService extends Service {
  static readonly provide = 'sandbox'

  readonly mode: SandboxMode
  readonly workspaceRoot: string
  readonly extraWritableRoots: readonly string[]
  /** The selected platform runner, or `undefined` when the platform (or the config) has none. */
  private readonly backend: SandboxBackend | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sandbox')
    this.mode = config.mode ?? 'workspace-write'
    this.workspaceRoot = canonical(config.workspaceRoot ?? process.cwd())
    this.extraWritableRoots = (config.extraWritableRoots ?? []).map((root) => canonical(root))
    this.backend =
      config.backend === 'none'
        ? undefined
        : selectBackend(process.platform, { ...(config.landlockRunner !== undefined ? { landlockRunner: config.landlockRunner } : {}) })
  }

  /** The policy a call runs under, so a caller can report it and every consumer shares one value. */
  policy(mode: SandboxMode = this.mode): SandboxExecutionPolicy {
    return { mode, workspaceRoot: this.workspaceRoot, extraWritableRoots: this.extraWritableRoots }
  }

  /** The selected runner's name, or `null` when this host can confine nothing — reported rather than guessed. */
  backendName(): string | null {
    return this.backend?.name ?? null
  }

  /**
   * Resolve a caller-supplied path against the workspace, **and canonicalise it**.
   *
   * Canonicalising here rather than at each comparison is the whole fix for a measured bug: the
   * workspace roots are canonical, so comparing a raw path against them made a policy that had
   * admitted the temp directory refuse a write to it, because `/var/folders/...` is a symlink to
   * `/private/var/folders/...` and only one side of the comparison had been resolved. A sandbox that
   * compares a resolved path with an unresolved one is a sandbox that says no for the wrong reason.
   */
  resolvePath(path: string): string {
    return canonical(isAbsolute(path) ? resolve(path) : resolve(this.workspaceRoot, path))
  }

  /**
   * Wrap one exact argv for the shell under this call's policy.
   *
   * `danger-full-access` never consults the provider — that is the only bypass, and it is a mode the owner has to
   * ask for. A confined mode with no usable backend throws `SandboxUnavailableError`, which the caller reports:
   * failing closed is the whole point, because a command that runs unconfined after being asked to confine it is
   * the silent widening this seam exists to prevent.
   */
  confine(argv: readonly string[], mode: SandboxMode = this.mode): ConfinedArgv {
    if (mode === 'danger-full-access') {
      return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
    }
    if (this.backend === undefined || !this.backend.probe()) throw new SandboxUnavailableError(mode)
    return this.backend.confine(argv, this.policy(mode))
  }

  /**
   * Refuse a write unless the path is inside one of the policy's writable roots.
   *
   * A denial is thrown rather than returned because every caller must handle it;
   * a returned `false` that a caller could ignore is how a sandbox becomes
   * advisory.
   *
   * `mode` is the **policy for this call**, which is how a session's own access mode reaches the effect:
   * the registry resolves it once per call from the session log and passes it in, so the same service can
   * decide two calls under two sessions at the same instant. Left out, the deployment mode applies, which
   * keeps every older call site's meaning.
   */
  assertWritable(path: string, mode: SandboxMode = this.mode): string {
    const target = this.resolvePath(path)
    if (mode === 'danger-full-access') return target
    if (mode === 'read-only') {
      throw new SandboxDenial(`the sandbox is read-only, so '${path}' cannot be written`, {
        path: target,
        mode,
        workspaceRoot: this.workspaceRoot,
      })
    }
    const allowed = writableRoots(this.policy(mode))
    if (allowed.some((root) => contains(root, target))) return target
    throw new SandboxDenial(
      `'${target}' is outside the sandbox root ${this.workspaceRoot}, so it cannot be written`,
      { path: target, mode, workspaceRoot: this.workspaceRoot },
    )
  }

  /** Refuse a read outside the workspace in the confined modes, under this call's policy. */
  assertReadable(path: string, mode: SandboxMode = this.mode): string {
    const target = this.resolvePath(path)
    if (mode === 'danger-full-access') return target
    /**
     * Reading follows the same roots the call may write, plus the harness's own configuration directory so a
     * confined run can read the profile it was started from. `read-only` has no writable roots (the mode promises
     * no file effects), so its readable set is the workspace and the named extra roots.
     */
    const allowed = [
      ...(mode === 'workspace-write' ? writableRoots(this.policy(mode)) : [this.workspaceRoot, ...this.extraWritableRoots]),
      join(homedir(), '.heddle'),
    ]
    if (allowed.some((root) => contains(root, target))) return target
    throw new SandboxDenial(
      `'${target}' is outside the sandbox root ${this.workspaceRoot}, so it cannot be read in '${mode}' mode`,
      { path: target, mode, workspaceRoot: this.workspaceRoot },
    )
  }

  /** Whether a path would be permitted, without throwing. Used by the loop's report. */
  writable(path: string, mode: SandboxMode = this.mode): boolean {
    try {
      this.assertWritable(path, mode)
      return true
    } catch {
      return false
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by this plugin; reads require `inject: ['sandbox']`. */
    sandbox: SandboxService
  }
}

/**
 * The plugin is the service class itself, so the Cordis loader's own `inject`
 * row gates it — the mechanism DSH uses, rather than an exported `inject` array
 * that a hand-written `ctx.set` path ignores. Measured: the function form threw
 * "cannot get property ... without inject" while the loader reported nothing,
 * because `ctx.set` does not go through the inject gate.
 */
export default class SandboxServicePlugin extends SandboxService {
  /**
   * The schema has to be declared on the plugin, and its absence was invisible.
   *
   * Measured: without this, the loader accepted the row's config and passed it through unvalidated —
   * so `tempRoot: true` never arrived, `workspace-write` kept refusing the temp directory, and every
   * check of the mode passed because the mode itself was fine. A config schema that is exported but
   * not declared is a config that is silently ignored.
   */
  static readonly Config = Config
}
