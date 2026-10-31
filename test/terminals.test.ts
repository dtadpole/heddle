import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { seatbeltProfileArgs } from '../src/sandbox/seatbelt.ts'
import { TerminalRegistry, type TerminalEvent, type TerminalLimits } from '../src/server/terminals.ts'

/**
 * The page's interactive terminals, the server half (live-testing issue #85): one shell per terminal in a PTY,
 * owned by one session. Each one is bounded, confined like bash, and ended with its whole process tree.
 */

const darwin = process.platform === 'darwin'
const skip = darwin ? false : 'the PTY runs through BSD script(1); the util-linux form is not measured on this host'

/** A scratch workspace under the checkout. `/tmp` is writable under workspace-write, so it cannot be the outside. */
function scratch(): { readonly root: string; readonly workspace: string; readonly outside: string; readonly done: () => void } {
  const base = join(process.cwd(), '.heddle-tmp')
  mkdirSync(base, { recursive: true })
  const root = realpathSync(mkdtempSync(join(base, 'terminals-')))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  mkdirSync(workspace)
  mkdirSync(outside)
  return { root, workspace, outside, done: () => rmSync(root, { recursive: true, force: true }) }
}

const unconfined = (argv: readonly string[]): readonly string[] => argv

function registry(limits: Partial<TerminalLimits> = {}): TerminalRegistry {
  return new TerminalRegistry({ limits, pollMs: 60_000 })
}

/** Attach to a terminal and collect its output; `until` waits for a pattern. */
function watch(terminals: TerminalRegistry, session: string, id: string) {
  let text = ''
  const exits: Array<number | null> = []
  const attached = terminals.attach(session, id, (event: TerminalEvent) => {
    if (event.type === 'output') text += event.data
    else exits.push(event.code)
  })
  assert.ok(attached !== undefined, 'the terminal can be attached')
  return {
    text: () => text,
    exits,
    detach: attached.detach,
    until: async (pattern: RegExp, ms = 8000): Promise<RegExpExecArray> => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        const match = pattern.exec(text)
        if (match !== null) return match
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.fail(`no ${pattern} within ${ms} ms; saw ${JSON.stringify(text.slice(-400))}`)
    },
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('a terminal runs a shell in a PTY of the asked size, and a resize reaches it', { skip }, async () => {
  const s = scratch()
  const terminals = registry()
  try {
    const info = terminals.create({ session: 's1', cwd: s.workspace, mode: 'danger-full-access', cols: 90, rows: 25, confine: unconfined, env: { ...process.env, SHELL: '/bin/sh' } })
    assert.notEqual(info, 'limit')
    if (info === 'limit') return
    assert.equal(info.shell, '/bin/sh')
    const out = watch(terminals, 's1', info.id)
    terminals.input('s1', info.id, 'stty size; pwd; echo "SUM-$((6*7))"\n')
    await out.until(/SUM-42/)
    assert.match(out.text(), /25 90/, 'the PTY starts at the asked size')
    assert.ok(out.text().includes(s.workspace), 'in the session folder')
    assert.equal(await terminals.resize('s1', info.id, 120, 40), 'ok')
    terminals.input('s1', info.id, 'stty size\n')
    await out.until(/40 120/)
    assert.equal(await terminals.resize('s1', info.id, 501, 40), 'out-of-range', 'DSH caps columns at 500')
  } finally {
    await terminals.closeAll()
    s.done()
  }
})

test('the shell exit status is reported, and an exited terminal takes no input', { skip }, async () => {
  const s = scratch()
  const terminals = registry()
  try {
    const info = terminals.create({ session: 's1', cwd: s.workspace, mode: 'danger-full-access', cols: 80, rows: 24, confine: unconfined, env: { ...process.env, SHELL: '/bin/sh' } })
    if (info === 'limit') return assert.fail('limit')
    const out = watch(terminals, 's1', info.id)
    terminals.input('s1', info.id, 'exit 3\n')
    const deadline = Date.now() + 8000
    while (out.exits.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
    assert.deepEqual(out.exits, [3])
    assert.equal(terminals.list('s1')[0]?.exited, true, 'it stays listed until closed, as in DSH')
    assert.equal(terminals.input('s1', info.id, 'echo late\n'), 'exited')
  } finally {
    await terminals.closeAll()
    s.done()
  }
})

test('a session holds at most maxTerminals, and one session cannot reach another session’s terminal', { skip }, async () => {
  const s = scratch()
  const terminals = registry({ maxTerminals: 2 })
  try {
    const spec = { cwd: s.workspace, mode: 'danger-full-access', cols: 80, rows: 24, confine: unconfined, env: { ...process.env, SHELL: '/bin/sh' } }
    const first = terminals.create({ ...spec, session: 'a' })
    terminals.create({ ...spec, session: 'a' })
    assert.equal(terminals.create({ ...spec, session: 'a' }), 'limit')
    assert.notEqual(terminals.create({ ...spec, session: 'b' }), 'limit', 'the cap is per session')
    if (first === 'limit') return
    assert.equal(terminals.list('b').some((terminal) => terminal.id === first.id), false)
    assert.equal(terminals.input('b', first.id, 'echo nope\n'), 'missing')
    assert.equal(terminals.attach('b', first.id, () => {}), undefined)
    assert.equal(await terminals.resize('b', first.id, 100, 30), 'missing')
    assert.equal(await terminals.close('b', first.id), false)
    assert.equal(terminals.list('a').length, 2, 'and the owner still has it')
  } finally {
    await terminals.closeAll()
    s.done()
  }
})

test('closing a terminal ends its background jobs too', { skip }, async () => {
  const s = scratch()
  const terminals = registry()
  try {
    const info = terminals.create({ session: 's1', cwd: s.workspace, mode: 'danger-full-access', cols: 80, rows: 24, confine: unconfined, env: { ...process.env, SHELL: '/bin/sh' } })
    if (info === 'limit') return assert.fail('limit')
    const out = watch(terminals, 's1', info.id)
    terminals.input('s1', info.id, 'sleep 300 & echo BG=$!\n')
    const pid = Number((await out.until(/BG=(\d+)/))[1])
    assert.ok(alive(pid), 'the job is running')
    assert.equal(await terminals.close('s1', info.id), true)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(alive(pid), false, 'the job ended with its terminal')
    assert.equal(terminals.list('s1').length, 0)
  } finally {
    await terminals.closeAll()
    s.done()
  }
})

test('closing a session’s terminals and closing all of them end every shell', { skip }, async () => {
  const s = scratch()
  const terminals = registry()
  try {
    const spec = { cwd: s.workspace, mode: 'danger-full-access', cols: 80, rows: 24, confine: unconfined, env: { ...process.env, SHELL: '/bin/sh' } }
    const pids: number[] = []
    for (const session of ['a', 'a', 'b']) {
      const info = terminals.create({ ...spec, session })
      if (info === 'limit') return assert.fail('limit')
      const out = watch(terminals, session, info.id)
      terminals.input(session, info.id, 'sleep 300 & echo BG=$!\n')
      pids.push(Number((await out.until(/BG=(\d+)/))[1]))
    }
    assert.equal(await terminals.closeSession('a'), 2)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.deepEqual(pids.map(alive), [false, false, true], 'the archive path ends only that session’s terminals')
    await terminals.closeAll()
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(alive(pids[2] as number), false, 'shutdown ends the rest')
  } finally {
    await terminals.closeAll()
    s.done()
  }
})

test('the replay keeps only the newest replayBytes, never starting inside a character', { skip }, async () => {
  const s = scratch()
  const terminals = registry({ replayBytes: 1000 })
  try {
    const info = terminals.create({ session: 's1', cwd: s.workspace, mode: 'danger-full-access', cols: 80, rows: 24, confine: unconfined, env: { ...process.env, SHELL: '/bin/sh' } })
    if (info === 'limit') return assert.fail('limit')
    const out = watch(terminals, 's1', info.id)
    terminals.input('s1', info.id, 'i=0; while [ $i -lt 400 ]; do printf "你好"; i=$((i+1)); done; echo; echo REPLAY-$((40+2))\n')
    await out.until(/REPLAY-42\r?\n/)
    out.detach()
    const again = terminals.attach('s1', info.id, () => {})
    const snapshot = again?.snapshot
    again?.detach()
    assert.ok(snapshot !== undefined)
    assert.ok(Buffer.byteLength(snapshot.data, 'utf8') <= 1000, 'bounded in bytes')
    assert.equal(snapshot.truncated, true, 'and says that older output was dropped')
    assert.ok(snapshot.data.includes('REPLAY-42'), 'keeping the newest output')
    assert.equal(snapshot.data.includes('\ufffd'), false, 'with no broken character at the cut')
  } finally {
    await terminals.closeAll()
    s.done()
  }
})

test('a terminal nobody watches and nobody uses is reclaimed after unattendedMs', { skip }, async () => {
  const s = scratch()
  const terminals = registry({ unattendedMs: 300 })
  try {
    const info = terminals.create({ session: 's1', cwd: s.workspace, mode: 'danger-full-access', cols: 80, rows: 24, confine: unconfined, env: { ...process.env, SHELL: '/bin/sh' } })
    if (info === 'limit') return assert.fail('limit')
    const out = watch(terminals, 's1', info.id)
    terminals.input('s1', info.id, 'echo READY-$((40+2))\n')
    await out.until(/READY-42/)
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(await terminals.reclaim(), 0, 'a watched terminal is kept')
    out.detach()
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(await terminals.reclaim(), 1, 'an unwatched, quiet one is closed')
    assert.equal(terminals.list('s1').length, 0)
  } finally {
    await terminals.closeAll()
    s.done()
  }
})

test('under workspace-write the shell writes inside the workspace and is refused outside it, as bash is', { skip }, async () => {
  const s = scratch()
  const terminals = registry()
  try {
    const confine = (argv: readonly string[]) => ['/usr/bin/sandbox-exec', ...seatbeltProfileArgs({ mode: 'workspace-write', workspaceRoot: s.workspace, extraWritableRoots: [] }), '--', ...argv]
    const info = terminals.create({ session: 's1', cwd: s.workspace, mode: 'workspace-write', cols: 80, rows: 24, confine, env: { ...process.env, SHELL: '/bin/sh' } })
    if (info === 'limit') return assert.fail('limit')
    const out = watch(terminals, 's1', info.id)
    terminals.input('s1', info.id, `echo in > ${s.workspace}/in.txt; echo out > ${s.outside}/out.txt; ( echo child > ${s.outside}/child.txt ); echo WRITES-$((40+2))\n`)
    await out.until(/WRITES-42/)
    assert.equal(existsSync(join(s.workspace, 'in.txt')), true, 'the inside write lands')
    assert.equal(existsSync(join(s.outside, 'out.txt')), false, 'the outside write is refused')
    assert.equal(existsSync(join(s.outside, 'child.txt')), false, 'from a subshell too')
    assert.match(out.text(), /Operation not permitted/)
  } finally {
    await terminals.closeAll()
    s.done()
  }
})
