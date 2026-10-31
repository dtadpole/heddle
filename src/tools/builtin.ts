import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile as readFileText, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { symbols } from '@deepseek-ai/cordis'

import { SandboxUnavailableError, classifyOutcome, type ConfinedArgv } from '../sandbox/backend.ts'
import { killProcessGroup } from '../sandbox/process-group.ts'
import type { SandboxService } from '../sandbox/service.ts'
import type { ToolDefinition, ToolResult, ToolRunContext } from './service.ts'

/**
 * The tools this harness ships.
 *
 * Four tools and one command, which is what the goal asks for: the claim is that
 * the **extension point** works, not that the catalogue is large. Each one goes
 * through the registry's two gates, so `write_file` is refused by the sandbox for
 * a path outside the workspace and by the policy when it is denied by name — two
 * different refusals a reader can tell apart.
 *
 * Every tool's `spec` is what the model is told, so the descriptions are written
 * for a model rather than for a person reading the source: what it does, what it
 * costs, and what it refuses.
 */

/**
 * The two schema fields DSH advertises on a mutating tool when the composition confines.
 *
 * They are the tool layer's, not the sandbox's: the sandbox decides what a mode means, and the tool decides what a
 * model may ask for and when a person is prompted. They are absent when nothing can confine — an offered escalation
 * a host cannot enforce would be a prompt whose grant could not run.
 */
function escalationFields(sandbox: SandboxService): Record<string, { type: 'string'; description: string; enum?: string[] }> {
  const targets = sandbox.escalationTargets()
  if (targets.length === 0) return {}
  return {
    sandbox_permissions: {
      type: 'string',
      enum: [...targets],
      description:
        'The narrowest wider sandbox mode for a one-shot retry of the exact operation the sandbox just denied; the retry asks the user for approval.',
    },
    justification: {
      type: 'string',
      description:
        'Required with sandbox_permissions: one sentence for the user explaining why this exact operation needs the wider access. Use the language of the user’s current request.',
    },
  }
}

/**
 * DSH's display spelling for a path a tool names (`dsh-fs-local` `localDisplayPath`, POSIX): absolute, and normalised
 * unless the spelling walks `..`, which is kept as written. It is the path a refusal names, so the model can tell which
 * of several reads failed (live-testing issue #4: the Rust build named no file at all).
 */
export function displayPath(cwd: string, path: string): string {
  const raw = isAbsolute(path) ? path : `${cwd}${sep}${path}`
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(raw) ? raw : resolve(cwd, path)
}

/** The default for `bashOutputLimit`: characters of a command's combined output kept for the model. */
export const BASH_OUTPUT_LIMIT = 20_000

/** The environment every `bash` command runs with, foreground or background. */
export function shellEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NO_COLOR: '1' }
}

/** A command line confined for one call: the argv to spawn and the confinement it runs under (`null`: unconfined). */
export interface ShellLaunch {
  readonly argv: readonly string[]
  readonly confined: ConfinedArgv | null
}

/**
 * Confine the exact argv, or refuse to run it.
 *
 * `danger-full-access` is the only mode that never asks a provider. Every confined mode asks the sandbox
 * service for a wrapped argv; if this host cannot confine, the call fails closed with the reason rather than
 * running unconfined — that is the difference between a sandbox and a suggestion.
 *
 * Shared by the foreground run below and the jobs row's background run (`src/jobs/bash.ts`), so a background
 * command is confined by exactly the path a foreground one is.
 */
export function launchShell(sandbox: SandboxService, command: string, context: ToolRunContext): ShellLaunch | { readonly refusal: ToolResult } {
  const mode = context.mode
  let confined: ConfinedArgv | null = null
  try {
    if (mode !== 'danger-full-access') confined = sandbox.confine(['/bin/sh', '-c', command], mode, context.cwd)
  } catch (error) {
    if (error instanceof SandboxUnavailableError) {
      context.log(`refused a '${mode}' shell: ${error.message}`)
      return {
        refusal: {
          output: '',
          error: { code: 'SANDBOX_UNAVAILABLE', message: error.message },
          data: { sandbox: { mode, denied: false, unavailable: true } },
        },
      }
    }
    throw error
  }
  return { argv: confined?.argv ?? ['/bin/sh', '-c', command], confined }
}

/**
 * The background half of `bash`: what the jobs row (`src/plugins/jobs.ts`) attaches.
 *
 * While one is attached to the sandbox a `bash` tool was built over, the tool's schema carries `run_in_background`
 * and a call that sets it is handed to `start`; with none attached, the schema is exactly the foreground one. The
 * seam is keyed by the sandbox service because that is the one object both rows already share, which keeps the tools
 * row unchanged and the dependency optional.
 */
export interface BashBackground {
  /** The schema property bash advertises while attached (DSH's `run_in_background`). */
  readonly property: { readonly type: 'boolean'; readonly description: string }
  /** Start the command as a background job and answer the tool result. */
  readonly start: (args: Record<string, unknown>, context: ToolRunContext) => Promise<ToolResult>
  /**
   * Run a foreground call as a job, DSH's `promoteOnTimeout` (`dsh-tool-bash`: with a registry, every call registers
   * its process as a job at its start). It answers `render`'s result when the command ends within `limitMs`, and the
   * promoted answer when the command outlives it and keeps running as a job. `undefined` means the job could not be
   * registered, and the call runs here in the foreground, with the wall-time kill, as DSH falls back. Absent when the
   * row does not promote.
   */
  readonly runForeground?: (run: ForegroundRun) => Promise<ToolResult | undefined>
}

/** One foreground call handed to {@link BashBackground.runForeground}. */
export interface ForegroundRun {
  readonly args: Record<string, unknown>
  readonly context: ToolRunContext
  /** The confined argv, from {@link launchShell}: the job runs exactly what the foreground would have. */
  readonly launch: ShellLaunch
  /** The call's wall time, already validated and capped ({@link bashWallTime}). */
  readonly limitMs: number
  /** `bash`'s own answer for a command that ended ({@link shellResult}, bound to this call). */
  readonly render: (end: ShellEnd) => ToolResult
}

/** What a foreground command reported when it ended, before it becomes `bash`'s answer. */
export interface ShellEnd {
  readonly stdout: string
  readonly stderr: string
  /** The exit code; `null` when a signal ended it. */
  readonly code: number | null
  /** The call's Stop ended it. */
  readonly stopped: boolean
  /** Its wall time ended it. */
  readonly timedOut: boolean
  readonly limitMs: number
}

/**
 * `bash`'s answer for a command that ended: the combined output cut to `outputLimit`, then the stop, the wall time,
 * the sandbox's reading (a runner failure outranks a denial) or a nonzero exit, each with the sandbox facts. Shared by
 * the foreground run and the jobs row's promoting run, so a call answers the same however it was run.
 */
export function shellResult(end: ShellEnd, launch: ShellLaunch, mode: ToolRunContext['mode'], outputLimit: number): ToolResult {
  const { stdout, stderr, code } = end
  const { confined } = launch
  const combined = stdout + stderr
  const trimmed = combined.length > outputLimit ? `${combined.slice(0, outputLimit)}\n… truncated` : combined
  /** The facts a reader (and the model) is told: which mode ran, and what the runner actually governed. */
  const sandboxFacts = confined === null ? { mode } : { mode, enforcement: confined.enforcement }
  /** A stopped call says so, as the Rust build and the loop's own stopped calls do, not `exited null`. */
  if (end.stopped) {
    return {
      output: trimmed,
      error: { code: 'INTERRUPTED', message: 'the command was stopped before it finished' },
      data: { sandbox: { ...sandboxFacts, denied: false } },
    }
  }
  if (end.timedOut) {
    return {
      output: trimmed,
      error: { code: 'TIMEOUT', message: `the command exceeded ${end.limitMs}ms and was killed` },
      data: { sandbox: { ...sandboxFacts, denied: false } },
    }
  }
  const outcome = confined === null ? ({ kind: 'exited' } as const) : classifyOutcome({ exitCode: code ?? 1, stderr, confined })
  /**
   * A runner failure means the command **never ran**, so it is reported as a sandbox problem and outranks
   * any denial sentence in the output. An ordinary denial says which mode refused the effect.
   */
  if (outcome.kind === 'runner-failure') {
    return {
      output: trimmed,
      error: {
        code: 'SANDBOX_UNAVAILABLE',
        message: `the sandbox runner failed under '${mode}' mode — the command did not run: ${outcome.detail}`,
      },
      data: { sandbox: { ...sandboxFacts, denied: false, runnerFailed: true } },
    }
  }
  if (outcome.kind === 'denied') {
    return {
      output: trimmed,
      error: { code: 'SANDBOX', message: `[sandbox: file access denied under ${mode} mode]` },
      data: { sandbox: { ...sandboxFacts, denied: true } },
    }
  }
  if (code !== 0) {
    return {
      output: trimmed,
      error: { code: 'EXIT', message: `the command exited ${code}` },
      data: { sandbox: { ...sandboxFacts, denied: false } },
    }
  }
  return { output: trimmed, data: { exitCode: code, sandbox: { ...sandboxFacts, denied: false } } }
}

const backgrounds = new WeakMap<object, BashBackground>()

/**
 * The service behind a context's handle. Cordis hands each plugin its own proxy of a service, so the tools row's
 * `ctx.sandbox` and the jobs row's are different objects over one service; the seam is keyed by that service.
 */
function serviceOf(sandbox: SandboxService): object {
  const original = (sandbox as unknown as Record<symbol, unknown>)[symbols.original]
  return typeof original === 'object' && original !== null ? original : sandbox
}

/** The background runner attached for the `bash` tools built over `sandbox`, if any. */
function backgroundFor(sandbox: SandboxService): BashBackground | undefined {
  return backgrounds.get(serviceOf(sandbox))
}

/** Attach a background runner for the `bash` tools built over `sandbox`; answers the detach. */
export function attachBashBackground(sandbox: SandboxService, background: BashBackground): () => void {
  const key = serviceOf(sandbox)
  backgrounds.set(key, background)
  return () => {
    if (backgrounds.get(key) === background) backgrounds.delete(key)
  }
}

/** The default for `bashMaxTimeoutMs`: the most wall time a call may ask for, DSH's `maxTimeoutMs` (ten minutes). */
export const BASH_MAX_TIMEOUT_MS = 600_000

/**
 * The longest delay one Node timer can hold (2^31-1 ms, about 24.8 days). `setTimeout` runs a larger one after a
 * millisecond, so no cap or request may exceed it: the setting refuses a larger `bashMaxTimeoutMs`, and the wall time is
 * cut to it here as well (developer-five's review of #13; DSH bounds its grace by the same `MAX_TIMER_DELAY_MS`).
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * The wall time a `bash` call runs with, or the refusal its `timeoutMs` earns.
 *
 * DSH's rule (`dsh-tool-bash` `validateBashArgs`, `dsh-timeout` `clampTimeout`): an absent value takes the default; a
 * value that is not a finite positive number is refused; a larger one is cut to the cap. Before it, the value went
 * straight into `setTimeout`, which runs `0`, a negative delay or one above 2^31-1 ms after one millisecond, so the
 * command was killed before it ran and the result claimed it had timed out (live-testing issue #13).
 */
export function bashWallTime(requested: unknown, defaultMs: number, maxMs: number): { readonly ms: number } | { readonly refusal: string } {
  const cap = Math.min(maxMs, MAX_TIMER_DELAY_MS)
  if (requested === undefined || requested === null) return { ms: Math.min(defaultMs, cap) }
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return { refusal: `invalid timeoutMs: expected a positive number, got ${JSON.stringify(requested)}` }
  }
  return { ms: Math.min(Math.max(1, Math.round(requested)), cap) }
}

/** Build the standard tools around one sandbox. */
export function builtinTools(
  sandbox: SandboxService,
  options: { readonly bashTimeoutMs?: number; readonly bashMaxTimeoutMs?: number; readonly bashOutputLimit?: number } = {},
): readonly ToolDefinition[] {
  const timeoutMs = options.bashTimeoutMs ?? 30_000
  const maxTimeoutMs = Math.min(options.bashMaxTimeoutMs ?? BASH_MAX_TIMEOUT_MS, MAX_TIMER_DELAY_MS)
  /** Characters of a command's combined output the model is shown; the rest is cut and marked (DSH's output cap). */
  const outputLimit = options.bashOutputLimit ?? BASH_OUTPUT_LIMIT
  const escalation = escalationFields(sandbox)

  const writeFile: ToolDefinition = {
    spec: {
      name: 'write_file',
      description:
        'Write text to a file, creating parent directories as needed. The path is resolved against the workspace and the sandbox refuses anything outside it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to write, relative to the workspace or absolute inside it.' },
          content: { type: 'string', description: 'Exact text to write.' },
          ...escalation,
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    run: async (args, context): Promise<ToolResult> => {
      const path = String(args.path ?? '')
      if (path.length === 0) return { output: '', error: { code: 'BAD_ARGS', message: 'write_file needs a path' } }
      const target = sandbox.assertWritable(path, context.mode, context.cwd)
      mkdirSync(dirname(target), { recursive: true })
      const content = String(args.content ?? '')
      writeFileSync(target, content)
      /**
       * Bytes, as the sentence says: UTF-8 bytes on disk, not UTF-16 code units (five Chinese characters are 15
       * bytes). The path is relative to the workspace only when the target is inside it; a file elsewhere (the host
       * temp area under workspace-write) is named absolutely, never as a climb of `../`. The Rust build's twin
       * already reports both this way (issue #3).
       */
      const bytes = Buffer.byteLength(content, 'utf8')
      context.log(`wrote ${target} (${bytes} bytes)`)
      const inside = relative(sandbox.policy(context.mode, context.cwd).workspaceRoot, target)
      // Outside is exactly `..` or a climb (`../…`): a file inside whose name starts with two dots stays relative.
      const climbs = inside === '..' || inside.startsWith(`..${sep}`)
      const shown = inside.length > 0 && !climbs && !isAbsolute(inside) ? inside : target
      return { output: `wrote ${bytes} bytes to ${shown}`, data: { path: target, bytes } }
    },
  }

  const readFile: ToolDefinition = {
    /** Reads only, so two reads of one step run together (DSH's fs read tools are concurrency-safe). */
    concurrencySafe: true,
    spec: {
      name: 'read_file',
      description: 'Read a text file and return its contents. Refused for a path outside the sandbox in confined modes.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File to read, relative to the workspace or absolute inside it.' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
    run: async (args, context): Promise<ToolResult> => {
      const path = String(args.path ?? '')
      if (path.length === 0) return { output: '', error: { code: 'BAD_ARGS', message: 'read_file needs a path' } }
      const target = sandbox.assertReadable(path, context.mode, context.cwd)
      /**
       * A missing file and a directory are classified and named, as DSH's read tool does (`dsh-tool-fs`
       * `resolveRegularReadTarget`): `FS_NOT_FOUND` and `FS_NOT_REGULAR_FILE`, each `cannot read "<path>": …`, not the
       * platform's raw error (live-testing issue #4).
       */
      const shown = displayPath(context.cwd, path)
      const info = await stat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
        throw error
      })
      if (info === undefined) return { output: '', error: { code: 'FS_NOT_FOUND', message: `cannot read "${shown}": not found` } }
      if (!info.isFile()) return { output: '', error: { code: 'FS_NOT_REGULAR_FILE', message: `cannot read "${shown}": not a regular file` } }
      // Read without blocking the event loop, so the other reads of a parallel group run alongside this one.
      const text = await readFileText(target, 'utf8')
      return { output: text, data: { path: target, bytes: text.length } }
    },
  }

  const listDir: ToolDefinition = {
    concurrencySafe: true,
    spec: {
      name: 'list_dir',
      description: 'List the entries of a directory inside the workspace, one per line, directories marked with a trailing slash.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory to list; defaults to the workspace root.' } },
        additionalProperties: false,
      },
    },
    run: async (args, context): Promise<ToolResult> => {
      const target = sandbox.assertReadable(String(args.path ?? '.'), context.mode, context.cwd)
      // Listed without blocking the event loop, as read_file reads, so a parallel group's calls run together.
      const dirents = (await readdir(target, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
      const entries = await Promise.all(
        dirents.map(async (entry) => {
          const stats = await stat(join(target, entry.name))
          return `${entry.isDirectory() ? `${entry.name}/` : entry.name}${entry.isDirectory() ? '' : ` (${stats.size}B)`}`
        }),
      )
      return { output: entries.join('\n'), data: { path: target, entries: entries.length } }
    },
  }

  const bash: ToolDefinition = {
    /**
     * Read per call rather than fixed: `run_in_background` is in the schema only while the jobs row has attached
     * a background runner to this sandbox (DSH shows the parameter only when a job registry is loaded). With none
     * attached, this is the foreground schema exactly.
     */
    get spec() {
      const background = backgroundFor(sandbox)
      return {
        name: 'bash',
        description:
          'Run a shell command in the workspace and return its combined output. The command runs under the session’s sandbox mode: read-only and workspace-write confine the whole process tree at the kernel (writes denied, or allowed only under the workspace and host temp areas), and danger-full-access runs unconfined. A blocked file operation is reported as [sandbox: file access denied under <mode> mode]; if no sandbox backend is usable the command is refused rather than run unconfined.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Command line, run through sh -c.' },
            timeoutMs: { type: 'number', description: `Wall time before the command is killed, in milliseconds; default ${timeoutMs}, at most ${maxTimeoutMs}.` },
            ...(background !== undefined ? { run_in_background: background.property } : {}),
            ...escalation,
          },
          required: ['command'],
          additionalProperties: false,
        },
      }
    },
    run: async (args, context): Promise<ToolResult> => {
      const command = String(args.command ?? '')
      if (command.length === 0) return { output: '', error: { code: 'BAD_ARGS', message: 'bash needs a command' } }
      const wallTime = bashWallTime(args.timeoutMs, timeoutMs, maxTimeoutMs)
      if ('refusal' in wallTime) return { output: '', error: { code: 'BAD_ARGS', message: wallTime.refusal } }
      const limit = wallTime.ms
      const mode = context.mode

      /** A background call is the jobs row's (DSH's refusal text when no job registry is loaded, adapted). */
      if (args.run_in_background === true) {
        const background = backgroundFor(sandbox)
        if (background === undefined) {
          return {
            output: '',
            error: { code: 'JOB_UNAVAILABLE', message: 'background jobs unavailable: load the jobs row (src/plugins/jobs.ts)' },
          }
        }
        return await background.start(args, context)
      }

      const launch = launchShell(sandbox, command, context)
      if ('refusal' in launch) return launch.refusal
      const { argv } = launch
      const render = (end: ShellEnd): ToolResult => shellResult(end, launch, mode, outputLimit)

      /**
       * With the jobs row attached and promoting, the call runs as a job (DSH's `promoteOnTimeout`): a command that
       * outlives its wall time keeps running in the background instead of being killed. A registration the row
       * refuses (a session at its job cap) falls through to the foreground run and its wall-time kill.
       */
      const runForeground = backgroundFor(sandbox)?.runForeground
      if (runForeground !== undefined) {
        const answered = await runForeground({ args, context, launch, limitMs: limit, render })
        if (answered !== undefined) return answered
      }
      // The working directory is the call's folder — the session's workspace, resolved by the loop — not the
      // directory the process was launched in. The confinement, when there is one, is the wrapped argv's: the
      // whole process tree is under the kernel profile, not only the command this tool spawns.
      const cwd = context.cwd
      return await new Promise<ToolResult>((resolve) => {
        /**
         * The command leads its own process group (`detached`), so a Stop or the wall time reaches everything it
         * started, as DSH's launcher does. Killing only the shell left its children running orphaned, and the turn
         * waited for them because they still held the output pipes (live-testing draft developer-five-5).
         */
        const child = spawn(argv[0] as string, argv.slice(1), { cwd, env: shellEnv(), detached: true })
        let stdout = ''
        let stderr = ''
        let timedOut = false
        let stopped = false
        const stop = () => {
          if (!killProcessGroup(child.pid)) child.kill('SIGKILL')
        }
        const timer = setTimeout(() => {
          timedOut = true
          stop()
        }, limit)
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        context.signal?.addEventListener(
          'abort',
          () => {
            stopped = true
            stop()
          },
          { once: true },
        )
        child.on('error', (error) => {
          clearTimeout(timer)
          resolve({ output: '', error: { code: 'TOOL_FAILED', message: error.message } })
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve(render({ stdout, stderr, code, stopped, timedOut, limitMs: limit }))
        })
      })
    },
  }

  return [writeFile, readFile, listDir, bash]
}
