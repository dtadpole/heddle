import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ApprovalService } from '../src/approvals/service.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import { builtinTools } from '../src/tools/builtin.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * A character whose UTF-8 bytes arrive in separate chunks is decoded whole (live-testing issue #96): each chunk was
 * decoded on its own, so a split sequence became replacement characters on the TypeScript build. DSH concatenates the
 * bytes before decoding; the Rust build decodes the whole output once.
 */

/** A command that prints `text` one byte at a time, pausing between bytes so they reach the reader apart. */
export function bytewise(text: string, pauseSeconds = 0.02): string {
  return [...Buffer.from(text, 'utf8')].map((byte) => `printf '\\${byte.toString(8).padStart(3, '0')}'; sleep ${pauseSeconds}`).join('; ')
}

async function bash(command: string) {
  const scratch = mkdtempSync(join(tmpdir(), 'heddle-bash-utf8-'))
  const workspace = join(scratch, 'workspace')
  mkdirSync(workspace)
  const sandbox = new SandboxService(new Context(), { mode: 'danger-full-access', workspaceRoot: workspace, backend: 'none' })
  const sessions = new SessionService(new Context(), { root: join(scratch, 'sessions') })
  const registry = new ToolRegistry(new Context(), new ApprovalService(new Context(), { mode: 'allow' }), sandbox, sessions)
  for (const tool of builtinTools(sandbox)) registry.register(tool)
  const handle = sessions.start({ cwd: workspace })
  try {
    return await registry.call('bash', { command }, { cwd: workspace, session: handle, log: () => {} })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

test('Chinese and an emoji printed one byte at a time arrive whole on stdout', async () => {
  const result = await bash(bytewise('你好🙂'))
  assert.equal(result.error, undefined)
  assert.equal(result.output, '你好🙂')
})

test('the same on stderr', async () => {
  const result = await bash(`{ ${bytewise('é🙂')}; } >&2`)
  assert.equal(result.error, undefined)
  assert.equal(result.output, 'é🙂')
})

test('a character left unfinished at the end is flushed as one replacement character, not dropped', async () => {
  // The first two of 你's three bytes, then the command ends: the decoder's end() must emit what it held.
  const result = await bash("printf 'ok'; printf '\\344'; sleep 0.02; printf '\\275'")
  assert.equal(result.error, undefined)
  assert.equal(result.output, 'ok\ufffd')
})
