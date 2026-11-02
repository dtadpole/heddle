import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ApprovalService } from '../src/approvals/service.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import { READ_LIMIT, READ_MAX_LINE_LENGTH, builtinTools, formatReadWindow, readWindow } from '../src/tools/builtin.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * read_file takes DSH's line window (`dsh-tool-fs` read): `offset` and `limit`, a numbered envelope and the offset to
 * continue from. Live-testing issue #263: the tool took only a path and returned a large file whole.
 */

async function withWorkspace(files: Record<string, string>, body: (read: (args: Record<string, unknown>) => ReturnType<ToolRegistry['call']>, workspace: string) => Promise<void>) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'heddle-read-window-')))
  const workspace = join(scratch, 'workspace')
  mkdirSync(workspace)
  for (const [name, text] of Object.entries(files)) writeFileSync(join(workspace, name), text)
  const sandbox = new SandboxService(new Context(), { mode: 'danger-full-access', workspaceRoot: workspace, backend: 'none' })
  const sessions = new SessionService(new Context(), { root: join(scratch, 'sessions') })
  const registry = new ToolRegistry(new Context(), new ApprovalService(new Context(), { mode: 'allow' }), sandbox, sessions)
  for (const tool of builtinTools(sandbox)) registry.register(tool)
  const handle = sessions.start({ cwd: workspace })
  try {
    await body((args) => registry.call('read_file', args, { cwd: workspace, session: handle, log: () => {} }), workspace)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

test('readWindow numbers lines as DSH does: a final LF makes no line, a CR before LF is stripped', () => {
  const text = 'one\r\ntwo\nthree\nfour\nfive\n'
  assert.equal(
    formatReadWindow('/w/f.txt', readWindow(text, 2, 2)),
    '<path>/w/f.txt</path>\n<type>file</type>\n<content>\n2: two\n3: three\n\n(Showing lines 2-3 of 5. Use offset=4 to continue.)\n</content>',
  )
  assert.equal(
    formatReadWindow('/w/f.txt', readWindow(text, 5, 2)),
    '<path>/w/f.txt</path>\n<type>file</type>\n<content>\n5: five\n\n(End of file - total 5 lines)\n</content>',
  )
  assert.equal(formatReadWindow('/w/e.txt', readWindow('', 1, READ_LIMIT)), '<path>/w/e.txt</path>\n<type>file</type>\n<content>\n(End of file - total 0 lines)\n</content>')
  assert.equal(readWindow('\n', 1, 10).totalLines, 1)
  assert.equal(readWindow('a\n\nb', 1, 10).totalLines, 3)
})

test('readWindow cuts a long line and caps the selected bytes at 50 KB', () => {
  const cut = readWindow('x'.repeat(READ_MAX_LINE_LENGTH + 5), 1, READ_LIMIT)
  assert.equal(cut.cutLine, true)
  assert.equal(cut.lines[0]?.text, `${'x'.repeat(READ_MAX_LINE_LENGTH)}... (line truncated to 2000 chars)`)
  // 1000 lines of 99 characters: each kept line costs 100 bytes with its newline, so 512 fit in 50 KB.
  const capped = readWindow(`${'y'.repeat(99)}\n`.repeat(1000), 1, READ_LIMIT)
  assert.equal(capped.truncatedByBytes, true)
  assert.equal(capped.totalLines, 1000)
  assert.equal(capped.lines.length, 512)
  assert.match(formatReadWindow('/w/big.txt', capped), /\n\n\(Output capped\. Showing lines 1-512\. Use offset=513 to continue\.\)\n<\/content>$/)
})

test('a cut at 2000 UTF-16 units splits a surrogate pair as DSH does (the Rust build keeps whole characters)', () => {
  const window = readWindow(`${'a'.repeat(1999)}\u{1f600}z`, 1, READ_LIMIT)
  assert.equal(window.lines[0]?.text, `${'a'.repeat(1999)}\ud83d... (line truncated to 2000 chars)`)
})

test('read_file takes a window, keeps a small unwindowed read plain, and refuses a bad window in DSH words', async () => {
  const many = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}\n`).join('')
  await withWorkspace({ 'five.txt': 'a\nb\nc\nd\ne\n', 'many.txt': many }, async (read, workspace) => {
    const shown = join(workspace, 'five.txt')
    const window = await read({ path: 'five.txt', offset: 3, limit: 2 })
    assert.equal(window.error, undefined)
    assert.equal(window.output, `<path>${shown}</path>\n<type>file</type>\n<content>\n3: c\n4: d\n\n(Showing lines 3-4 of 5. Use offset=5 to continue.)\n</content>`)
    assert.equal((await read({ path: 'five.txt' })).output, 'a\nb\nc\nd\ne\n')
    assert.deepEqual((await read({ path: 'five.txt', offset: 9 })).error, { code: 'FS_NOT_FOUND', message: `offset 9 is out of range for "${shown}" (5 lines)` })
    assert.deepEqual((await read({ path: 'five.txt', offset: 0 })).error, { code: 'BAD_ARGS', message: 'offset must be a positive integer' })
    assert.deepEqual((await read({ path: 'five.txt', limit: 1.5 })).error, { code: 'BAD_ARGS', message: 'limit must be a positive integer' })
    assert.deepEqual((await read({ path: 'five.txt', limit: 2001 })).error, { code: 'BAD_ARGS', message: 'limit must be less than or equal to 2000' })
    const big = await read({ path: 'many.txt' })
    assert.match(big.output, /\n2000: line 2000\n\n\(Showing lines 1-2000 of 2500\. Use offset=2001 to continue\.\)\n<\/content>$/)
    assert.doesNotMatch(big.output, /2001: line 2001/)
  })
})
