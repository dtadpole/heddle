import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

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

/** Build the standard tools around one sandbox. */
export function builtinTools(sandbox: SandboxService, options: { readonly bashTimeoutMs?: number } = {}): readonly ToolDefinition[] {
  const timeoutMs = options.bashTimeoutMs ?? 30_000

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
        'Run a shell command in the workspace and return its combined output. It runs with the workspace as its working directory; the sandbox governs the paths the harness itself writes, not what a command does. A read-only session refuses the shell entirely, because an unconfined shell could write outside those paths.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command line, run through sh -c.' },
          timeoutMs: { type: 'number', description: `Wall time before the command is killed; default ${timeoutMs}.` },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    run: async (args, context): Promise<ToolResult> => {
      const command = String(args.command ?? '')
      if (command.length === 0) return { output: '', error: { code: 'BAD_ARGS', message: 'bash needs a command' } }
      /**
       * A read-only session refuses the shell.
       *
       * The refusal is not an accident of this tool's implementation: the sandbox governs the paths **the
       * harness itself writes**, and a shell's writes to the filesystem are outside it. A `read-only` mode
       * that still started a shell would therefore be a promise the harness cannot keep, and "no file
       * effects" has to mean none. The alternative — an OS-level confinement — is a different, much larger
       * mechanism, and the module's own doc says this one is not that.
       */
      if (context.mode === 'read-only') {
        return {
          output: '',
          error: {
            code: 'SANDBOX',
            message:
              "the session is read-only, so the shell is refused: heddle's sandbox governs its own file tools, and a shell could write outside them",
          },
        }
      }
      // The working directory is the workspace, and that is the only confinement
      // claimed here: this is the harness's own shell, not an OS-level seccomp
      // boundary, and the description says so rather than implying more.
      const cwd = sandbox.workspaceRoot
      const limit = Number(args.timeoutMs ?? timeoutMs)
      return await new Promise<ToolResult>((resolve) => {
        const child = spawn('sh', ['-c', command], { cwd, env: { ...process.env, NO_COLOR: '1' } })
        let output = ''
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, limit)
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString()
        })
        child.stderr.on('data', (chunk: Buffer) => {
          output += chunk.toString()
        })
        context.signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true })
        child.on('error', (error) => {
          clearTimeout(timer)
          resolve({ output: '', error: { code: 'TOOL_FAILED', message: error.message } })
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          const trimmed = output.length > 20_000 ? `${output.slice(0, 20_000)}\n… truncated` : output
          if (timedOut) {
            resolve({ output: trimmed, error: { code: 'TIMEOUT', message: `the command exceeded ${limit}ms and was killed` } })
            return
          }
          if (code !== 0) {
            resolve({ output: trimmed, error: { code: 'EXIT', message: `the command exited ${code}` } })
            return
          }
          resolve({ output: trimmed, data: { exitCode: code } })
        })
      })
    },
  }

  return [writeFile, readFile, listDir, bash]
}
