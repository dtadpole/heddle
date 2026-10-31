import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile as readFileText, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

import { symbols } from '@deepseek-ai/cordis'

import { SandboxUnavailableError, classifyOutcome, type ConfinedArgv } from '../sandbox/backend.ts'
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

/** Build the standard tools around one sandbox. */
export function builtinTools(
  sandbox: SandboxService,
  options: { readonly bashTimeoutMs?: number; readonly bashOutputLimit?: number } = {},
): readonly ToolDefinition[] {
  const timeoutMs = options.bashTimeoutMs ?? 30_000
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
      context.log(`wrote ${target} (${content.length} bytes)`)
      return { output: `wrote ${content.length} bytes to ${relative(sandbox.policy(context.mode, context.cwd).workspaceRoot, target) || target}`, data: { path: target, bytes: content.length } }
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
            timeoutMs: { type: 'number', description: `Wall time before the command is killed; default ${timeoutMs}.` },
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
      const { argv, confined } = launch
      // The working directory is the call's folder — the session's workspace, resolved by the loop — not the
      // directory the process was launched in. The confinement, when there is one, is the wrapped argv's: the
      // whole process tree is under the kernel profile, not only the command this tool spawns.
      const cwd = context.cwd
      const limit = Number(args.timeoutMs ?? timeoutMs)
      return await new Promise<ToolResult>((resolve) => {
        const child = spawn(argv[0] as string, argv.slice(1), { cwd, env: shellEnv() })
        let stdout = ''
        let stderr = ''
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, limit)
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        context.signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true })
        child.on('error', (error) => {
          clearTimeout(timer)
          resolve({ output: '', error: { code: 'TOOL_FAILED', message: error.message } })
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          const combined = stdout + stderr
          const trimmed = combined.length > outputLimit ? `${combined.slice(0, outputLimit)}\n… truncated` : combined
          /** The facts a reader (and the model) is told: which mode ran, and what the runner actually governed. */
          const sandboxFacts = confined === null ? { mode } : { mode, enforcement: confined.enforcement }
          if (timedOut) {
            resolve({
              output: trimmed,
              error: { code: 'TIMEOUT', message: `the command exceeded ${limit}ms and was killed` },
              data: { sandbox: { ...sandboxFacts, denied: false } },
            })
            return
          }
          const outcome = confined === null ? ({ kind: 'exited' } as const) : classifyOutcome({ exitCode: code ?? 1, stderr, confined })
          /**
           * A runner failure means the command **never ran**, so it is reported as a sandbox problem and outranks
           * any denial sentence in the output. An ordinary denial says which mode refused the effect.
           */
          if (outcome.kind === 'runner-failure') {
            resolve({
              output: trimmed,
              error: {
                code: 'SANDBOX_UNAVAILABLE',
                message: `the sandbox runner failed under '${mode}' mode — the command did not run: ${outcome.detail}`,
              },
              data: { sandbox: { ...sandboxFacts, denied: false, runnerFailed: true } },
            })
            return
          }
          if (outcome.kind === 'denied') {
            resolve({
              output: trimmed,
              error: { code: 'SANDBOX', message: `[sandbox: file access denied under ${mode} mode]` },
              data: { sandbox: { ...sandboxFacts, denied: true } },
            })
            return
          }
          if (code !== 0) {
            resolve({
              output: trimmed,
              error: { code: 'EXIT', message: `the command exited ${code}` },
              data: { sandbox: { ...sandboxFacts, denied: false } },
            })
            return
          }
          resolve({ output: trimmed, data: { exitCode: code, sandbox: { ...sandboxFacts, denied: false } } })
        })
      })
    },
  }

  return [writeFile, readFile, listDir, bash]
}
