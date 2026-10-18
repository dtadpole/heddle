import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { SandboxUnavailableError, classifyOutcome, type ConfinedArgv } from '../sandbox/backend.ts'
import type { SandboxService } from '../sandbox/service.ts'
import type { ToolDefinition, ToolResult } from './service.ts'

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

/** Build the standard tools around one sandbox. */
export function builtinTools(sandbox: SandboxService, options: { readonly bashTimeoutMs?: number } = {}): readonly ToolDefinition[] {
  const timeoutMs = options.bashTimeoutMs ?? 30_000
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
      const target = sandbox.assertWritable(path, context.mode)
      mkdirSync(dirname(target), { recursive: true })
      const content = String(args.content ?? '')
      writeFileSync(target, content)
      context.log(`wrote ${target} (${content.length} bytes)`)
      return { output: `wrote ${content.length} bytes to ${relative(sandbox.workspaceRoot, target) || target}`, data: { path: target, bytes: content.length } }
    },
  }

  const readFile: ToolDefinition = {
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
      const target = sandbox.assertReadable(path, context.mode)
      const text = readFileSync(target, 'utf8')
      return { output: text, data: { path: target, bytes: text.length } }
    },
  }

  const listDir: ToolDefinition = {
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
      const target = sandbox.assertReadable(String(args.path ?? '.'), context.mode)
      const entries = readdirSync(target, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => {
          const stats = statSync(join(target, entry.name))
          return `${entry.isDirectory() ? `${entry.name}/` : entry.name}${entry.isDirectory() ? '' : ` (${stats.size}B)`}`
        })
      return { output: entries.join('\n'), data: { path: target, entries: entries.length } }
    },
  }

  const bash: ToolDefinition = {
    spec: {
      name: 'bash',
      description:
        'Run a shell command in the workspace and return its combined output. The command runs under the session’s sandbox mode: read-only and workspace-write confine the whole process tree at the kernel (writes denied, or allowed only under the workspace and host temp areas), and danger-full-access runs unconfined. A blocked file operation is reported as [sandbox: file access denied under <mode> mode]; if no sandbox backend is usable the command is refused rather than run unconfined.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command line, run through sh -c.' },
          timeoutMs: { type: 'number', description: `Wall time before the command is killed; default ${timeoutMs}.` },
          ...escalation,
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    run: async (args, context): Promise<ToolResult> => {
      const command = String(args.command ?? '')
      if (command.length === 0) return { output: '', error: { code: 'BAD_ARGS', message: 'bash needs a command' } }
      const mode = context.mode

      /**
       * Confine the exact argv, or refuse to run it.
       *
       * `danger-full-access` is the only mode that never asks a provider. Every confined mode asks the sandbox
       * service for a wrapped argv; if this host cannot confine, the call fails closed with the reason rather than
       * running unconfined — that is the difference between a sandbox and a suggestion.
       */
      let confined: ConfinedArgv | null = null
      try {
        if (mode !== 'danger-full-access') confined = sandbox.confine(['/bin/sh', '-c', command], mode)
      } catch (error) {
        if (error instanceof SandboxUnavailableError) {
          context.log(`refused a '${mode}' shell: ${error.message}`)
          return {
            output: '',
            error: { code: 'SANDBOX_UNAVAILABLE', message: error.message },
            data: { sandbox: { mode, denied: false, unavailable: true } },
          }
        }
        throw error
      }
      const argv = confined?.argv ?? ['/bin/sh', '-c', command]
      // The working directory is the workspace. The confinement, when there is one, is the wrapped argv's: the
      // whole process tree is under the kernel profile, not only the command this tool spawns.
      const cwd = sandbox.workspaceRoot
      const limit = Number(args.timeoutMs ?? timeoutMs)
      return await new Promise<ToolResult>((resolve) => {
        const child = spawn(argv[0] as string, argv.slice(1), { cwd, env: { ...process.env, NO_COLOR: '1' } })
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
          const trimmed = combined.length > 20_000 ? `${combined.slice(0, 20_000)}\n… truncated` : combined
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
