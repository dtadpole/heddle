import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ContextService } from '../src/context/service.ts'
import { SessionStore } from '../src/session/store.ts'

/**
 * A Stop during a turn's automatic compaction is honoured (#154).
 *
 * Live on both builds: the summary call ran on after the Stop, its replacement landed six seconds later, and TS then
 * called the model and answered in full. DSH's `dsh-compaction-basic` passes the turn's signal to the summary request
 * ("Cancellation stays authoritative throughout"): an abort mid-request throws and no replacement lands. A summary that
 * had already returned is committed, as DSH's automatic compaction commits it.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-compaction-stop-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let fixtures = 0

/** A session over its trigger, and a context service whose summary call is the one `complete` given. */
function fixture(complete: (request: { readonly signal?: AbortSignal }) => Promise<string>) {
  fixtures += 1
  const store = new SessionStore(join(scratch, `sessions-${fixtures}`))
  const context = new ContextService(new Context(), store, { instructions: false, contextWindow: 900 }, { complete })
  const workspace = join(scratch, `workspace-${fixtures}`)
  const session = store.create({ cwd: workspace })
  store.message(session, { role: 'user', content: [{ type: 'text', text: 'u'.repeat(1500) }] })
  store.message(session, { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(1500) }] })
  store.message(session, { role: 'user', content: [{ type: 'text', text: 'q'.repeat(1500) }] })
  const types = () => store.read(session).map((event) => event.type)
  return { store, context, session, workspace, types }
}

test('a Stop while the summary call is in flight cancels it, and nothing lands', async () => {
  let seen: AbortSignal | undefined
  const { store, context, session, workspace, types } = fixture(
    (request) =>
      new Promise<string>((_resolve, reject) => {
        seen = request.signal
        // The call ends the way the wire ends an aborted request: with an error, once the signal fires.
        request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
  )
  const controller = new AbortController()
  const generation = store.surface(session).replaceGeneration
  const prepared = context.prepare(session, { cwd: workspace, endpoint: 'local', signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(seen, controller.signal, 'the summary call carries the turn’s signal')
  controller.abort()
  const report = await prepared

  assert.equal(report.compacted, false, 'the stopped compaction did not compact')
  assert.equal(store.surface(session).replaceGeneration, generation, 'no replacement landed')
  assert.ok(!types().includes('compaction/summary') && !types().includes('compaction/end'), `no summary or end was written (${types().join(', ')})`)
  const failed = store.read(session).find((event) => event.type === 'compaction/failed') as { stopped?: unknown; refused?: unknown; reason?: unknown } | undefined
  assert.ok(failed, 'the span is closed with compaction/failed')
  assert.equal(failed.stopped, true, 'as stopped')
  assert.equal(failed.refused, undefined, 'not as refused, which /compact reports as an error')
  assert.equal(failed.reason, 'stopped by the caller')
})

test('a summary that returned before the Stop is committed, as DSH commits an automatic one', async () => {
  const controller = new AbortController()
  const { store, context, session, workspace } = fixture(async () => {
    // The Stop comes once the call has answered in full: after this task, not inside the call.
    setTimeout(() => controller.abort(), 0)
    return 'the briefing'
  })
  const generation = store.surface(session).replaceGeneration
  const report = await context.prepare(session, { cwd: workspace, endpoint: 'local', signal: controller.signal })
  assert.equal(report.compacted, true)
  assert.ok(store.surface(session).replaceGeneration > generation, 'the replacement landed; the loop’s own check stops the turn')
})

/**
 * #200: a streamed summary cut by a Stop does not throw. The completion hands back the text it had read, or none, once
 * its signal fires. TS committed the cut text as the checkpoint (and /compact answered "Compacted …"), or refused an
 * empty cut as "the summariser returned nothing"; Rust records both as stopped.
 */
for (const [form, cut] of [
  ['part of the summary', 'a compact brief'],
  ['nothing yet', ''],
] as const) {
  test(`a Stop that cuts the streamed summary after ${form} lands nothing and is recorded as stopped (#200)`, async () => {
    const { store, context, session, workspace, types } = fixture(
      (request) =>
        new Promise<string>((resolve) => {
          // The call ends the way a cut stream ends: it resolves with what it had read once the signal fires.
          request.signal?.addEventListener('abort', () => resolve(cut), { once: true })
        }),
    )
    const controller = new AbortController()
    const generation = store.surface(session).replaceGeneration
    const prepared = context.prepare(session, { cwd: workspace, endpoint: 'local', signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    const report = await prepared

    assert.equal(report.compacted, false, 'the cut summary did not compact')
    assert.equal(store.surface(session).replaceGeneration, generation, 'no replacement landed')
    assert.ok(!types().includes('compaction/summary') && !types().includes('compaction/end'), `no summary or end was written (${types().join(', ')})`)
    const failed = store.read(session).find((event) => event.type === 'compaction/failed') as { stopped?: unknown; refused?: unknown; reason?: unknown } | undefined
    assert.equal(failed?.stopped, true, `the span is closed as stopped (${JSON.stringify(failed)})`)
    assert.equal(failed?.refused, undefined, 'not as refused')
    assert.equal(failed?.reason, 'stopped by the caller', 'not as "the summariser returned nothing"')
  })
}

test('a compaction with no signal, or one that never fires, runs to the end as before', async () => {
  const quiet = fixture(async (request) => {
    assert.equal(request.signal, undefined, 'no signal is invented')
    return 'the briefing'
  })
  assert.equal((await quiet.context.prepare(quiet.session, { cwd: quiet.workspace, endpoint: 'local' })).compacted, true)

  const idle = fixture(async () => 'the briefing')
  const report = await idle.context.prepare(idle.session, { cwd: idle.workspace, endpoint: 'local', signal: new AbortController().signal })
  assert.equal(report.compacted, true)
  assert.ok(idle.types().includes('compaction/end'))
})

test('a summary that fails for another reason is still refused, with its reason', async () => {
  const { store, context, session, workspace } = fixture(async () => {
    throw new Error('the gateway answered 502')
  })
  await context.prepare(session, { cwd: workspace, endpoint: 'local', signal: new AbortController().signal })
  const failed = store.read(session).find((event) => event.type === 'compaction/failed') as { refused?: unknown; stopped?: unknown; reason?: unknown } | undefined
  assert.equal(failed?.refused, true)
  assert.equal(failed?.stopped, undefined)
  assert.match(String(failed?.reason), /the summariser failed — the gateway answered 502/)
})
