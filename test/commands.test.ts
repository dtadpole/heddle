import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  compactCommand,
  describeGoal,
  exportCommand,
  feedbackCommand,
  FEEDBACK_EVENT,
  goalCommand,
  permissionCommand,
  type CompactionOutcome,
} from '../src/commands/builtins.ts'
import { handleCommandRequest, type CommandRouteHost } from '../src/commands/http.ts'
import {
  COMMAND_DONE_EVENT,
  COMMAND_RUN_EVENT,
  CommandRegistry,
  defaultLabel,
  parseCommandLine,
  type CommandLog,
} from '../src/commands/registry.ts'
import { GoalService } from '../src/goal/service.ts'
import type { SandboxMode } from '../src/sandbox/service.ts'
import { foldSurface, SessionStore } from '../src/session/store.ts'

/**
 * The host's slash commands: the parser, the registry's run, each built-in command and the two routes.
 *
 * The rules pinned hardest are the ones that decide whether a line reaches the model (R-developer-twelve-1,
 * R-developer-six-5): a registered command never does, an unknown `/word` always does, and a run is recorded in the log
 * without ever taking a place on the model's surface.
 */

const root = mkdtempSync(join(tmpdir(), 'heddle-commands-'))
after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0
function session() {
  counter += 1
  const store = new SessionStore(join(root, `store-${counter}`))
  const handle = store.create({ cwd: root })
  const log: CommandLog = { append: (target, event) => store.append(target, event) }
  return { store, handle, log }
}

test('a command line is /name at the start, ending at whitespace or the end', () => {
  assert.deepEqual(parseCommandLine('/compact'), { name: 'compact', rawInput: '' })
  assert.deepEqual(parseCommandLine('/goal ship the table'), { name: 'goal', rawInput: ' ship the table' })
  assert.deepEqual(parseCommandLine('/goal\nline two'), { name: 'goal', rawInput: '\nline two' })
  assert.equal(parseCommandLine('/Compact'), undefined, 'names are lower-case')
  assert.equal(parseCommandLine('/compact:now'), undefined, 'the name ends at whitespace, not punctuation')
  assert.equal(parseCommandLine(' /compact'), undefined, 'the line must open with the slash')
  assert.equal(parseCommandLine('/'), undefined)
  assert.equal(parseCommandLine('see /compact'), undefined)
  assert.equal(parseCommandLine('/usr/bin/env'), undefined, 'a path is not a command')
  assert.equal(defaultLabel('compact'), 'Compact')
})

test('the registry refuses a malformed name, an empty description and a second command of one name', () => {
  const registry = new CommandRegistry()
  const handler = () => ({ kind: 'success' as const })
  assert.throws(() => registry.register({ name: 'Bad', description: 'x', handler }), /lower-case/)
  assert.throws(() => registry.register({ name: '9x', description: 'x', handler }), /start with a letter/)
  assert.throws(() => registry.register({ name: 'ok', description: '  ', handler }), /needs a description/)
  const dispose = registry.register({ name: 'ok', description: 'fine', handler })
  assert.throws(() => registry.register({ name: 'ok', description: 'again', handler }), /already registered/)
  dispose()
  assert.equal(registry.has('ok'), false, 'the disposer removes it')
  registry.register({ name: 'ok', description: 'fine again', handler })
  assert.equal(registry.has('ok'), true)
})

test('the list is sorted, labelled and sectioned, and carries no handler', () => {
  const registry = new CommandRegistry()
  registry.register({ name: 'zeta', description: 'z', handler: () => ({ kind: 'success' }) })
  registry.register({ name: 'alpha', description: 'a', input: { hint: '<text>' }, handler: () => ({ kind: 'success' }) })
  registry.register({ name: 'mid', label: 'Middle', section: 'add', description: 'm', handler: () => ({ kind: 'success' }) })
  assert.deepEqual(registry.list(), [
    { name: 'alpha', label: 'Alpha', description: 'a', section: 'add', input: { hint: '<text>' } },
    { name: 'mid', label: 'Middle', description: 'm', section: 'add' },
    { name: 'zeta', label: 'Zeta', description: 'z', section: 'commands' },
  ])
})

test('an unknown /word is not a command: nothing runs and nothing is written, so it goes to the model', async () => {
  const { store, handle, log } = session()
  const registry = new CommandRegistry()
  registry.register({ name: 'compact', description: 'c', handler: () => assert.fail('must not run') })
  const before = store.read(handle).length
  assert.equal(await registry.execute(log, handle, '/compcat'), undefined)
  assert.equal(await registry.execute(log, handle, 'hello /compact'), undefined)
  assert.equal(await registry.execute(log, handle, '/Compact'), undefined)
  assert.equal(store.read(handle).length, before)
})

test('a run is command/run then command/done in the log, and neither takes a place on the model surface', async () => {
  const { store, handle, log } = session()
  const registry = new CommandRegistry()
  const seen: string[] = []
  registry.register({
    name: 'echo',
    description: 'say it back',
    input: { hint: '<text>' },
    handler: ({ args, rawInput, commandId }) => {
      seen.push(rawInput, commandId)
      return { kind: 'success', text: args, sourceEventSeq: 0 }
    },
  })
  const surfaceBefore = foldSurface(store.read(handle)).nodes
  const execution = await registry.execute(log, handle, '/echo  hello there ')
  assert.ok(execution !== undefined)
  assert.equal(execution.name, 'echo')
  assert.match(execution.commandId, /^cmd-[0-9a-f]{8}-1$/, 'DSH-shaped id: cmd-<8hex>-<n>')
  assert.deepEqual(execution.result, { kind: 'success', text: 'hello there', sourceEventSeq: 0 })
  assert.deepEqual(seen, ['  hello there ', execution.commandId], 'the raw input keeps its whitespace')

  const events = store.read(handle)
  const run = events.find((event) => event.type === COMMAND_RUN_EVENT)
  const done = events.find((event) => event.type === COMMAND_DONE_EVENT)
  assert.ok(run !== undefined && done !== undefined)
  assert.equal(run.commandId, execution.commandId)
  assert.equal(run.name, 'echo')
  assert.equal(run.args, 'hello there')
  assert.deepEqual(run.source, { kind: 'user' })
  assert.ok(run.seq < done.seq, 'run is written before the handler, done after')
  assert.equal(done.kind, 'success')
  assert.equal(done.text, 'hello there')
  assert.equal(done.sourceEventSeq, 0)
  assert.equal(execution.seq, done.seq)
  assert.deepEqual(foldSurface(events).nodes, surfaceBefore, 'a command is not part of the conversation')

  const second = await registry.execute(log, handle, '/echo again')
  assert.match(second?.commandId ?? '', /-2$/, 'ids count up within one registry')
})

test('a handler that throws is a run that ended in error, recorded as such', async () => {
  const { store, handle, log } = session()
  const registry = new CommandRegistry()
  registry.register({
    name: 'boom',
    description: 'fails',
    handler: () => {
      throw new Error('the disk is full')
    },
  })
  const execution = await registry.execute(log, handle, '/boom')
  assert.deepEqual(execution?.result, { kind: 'error', text: 'the disk is full' })
  const done = store.read(handle).find((event) => event.type === COMMAND_DONE_EVENT)
  assert.equal(done?.kind, 'error')
  assert.equal(done?.text, 'the disk is full')
  assert.equal(done?.sourceEventSeq, undefined)
})

test('/goal sets, shows, edits, pauses, resumes and clears the goal through the goal service', async () => {
  const { store, handle, log } = session()
  const goals = new GoalService(new Context(), store)
  const registry = new CommandRegistry()
  registry.register(goalCommand(goals))
  const run = async (line: string) => (await registry.execute(log, handle, line))?.result

  assert.deepEqual(await run('/goal'), { kind: 'success', text: 'No goal is set. Use /goal <objective> to set one.' })
  assert.deepEqual(await run('/goal ship the parity table'), { kind: 'success', text: 'Goal set: ship the parity table' })
  assert.equal(goals.get(handle)?.objective, 'ship the parity table')
  assert.deepEqual(await run('/goal something else'), {
    kind: 'error',
    text: 'A goal is already active. Use /goal edit <objective> to change it, or /goal clear to remove it.',
  })
  const shown = await run('/goal')
  assert.equal(shown?.kind, 'success')
  assert.match(shown?.text ?? '', /^Status: active\nObjective: ship the parity table\nRounds: 0\/\d+\nActivation: (armed|disarmed)\nCommands: /)
  assert.deepEqual(await run('/goal edit'), { kind: 'error', text: 'Usage: /goal edit <objective>' })
  assert.deepEqual(await run('/goal edit ship it twice'), { kind: 'success', text: 'Goal updated: ship it twice' })
  assert.deepEqual(await run('/goal PAUSE'), { kind: 'success', text: 'Goal paused.' }, 'the words are case-insensitive')
  assert.equal(goals.get(handle)?.phase, 'paused')
  assert.deepEqual(await run('/goal resume'), { kind: 'success', text: 'Goal resumed.' })
  assert.equal(goals.get(handle)?.phase, 'active')
  assert.deepEqual(await run('/goal clear'), { kind: 'success', text: 'Goal cleared.' })
  assert.equal(goals.get(handle), undefined)
  assert.deepEqual(await run('/goal pause'), { kind: 'error', text: 'There is no goal to pause.' })
  assert.deepEqual(await run('/goal edit x'), { kind: 'error', text: 'There is no goal to edit. Use /goal <objective> to set one.' })
  assert.ok(store.read(handle).some((event) => event.type === 'goal/change'), 'the goal service wrote its own events')
})

test('a goal is described with its status, objective, rounds, activation and commands', () => {
  assert.equal(
    describeGoal({ id: 'g', revision: 1, objective: 'o', phase: 'paused', maxGoalRounds: 9, roundsStarted: 2 }),
    'Status: paused\nObjective: o\nRounds: 2/9\nCommands: /goal edit <objective> · /goal pause · /goal resume · /goal clear',
  )
})

test('/compact takes no arguments, reports what it compacted, and says when there was nothing to compact', async () => {
  const { handle, log } = session()
  const outcomes: CompactionOutcome[] = [{ compacted: true, items: 12, tokens: 3400, summarySeq: 7 }, { compacted: false }, { compacted: true }]
  let calls = 0
  const registry = new CommandRegistry()
  registry.register(
    compactCommand({
      compactNow: async () => {
        calls += 1
        return outcomes.shift() ?? { compacted: false }
      },
    }),
  )
  const run = async (line: string) => (await registry.execute(log, handle, line))?.result
  assert.deepEqual(await run('/compact now'), { kind: 'error', text: 'Usage: /compact (no arguments)' })
  assert.equal(calls, 0, 'an argument is refused before anything is compacted')
  assert.deepEqual(await run('/compact'), { kind: 'success', text: 'Compacted 12 history items (~3400 tokens).', sourceEventSeq: 7 })
  assert.deepEqual(await run('/compact'), { kind: 'success', text: 'No compactable history yet.' })
  assert.deepEqual(await run('/compact'), { kind: 'success', text: 'Compacted older history.' })
})

test('/compact passes a compaction failure on as the run error', async () => {
  const { handle, log } = session()
  const registry = new CommandRegistry()
  registry.register(compactCommand({ compactNow: () => Promise.reject(new Error('Compaction is unavailable because the context service is not loaded.')) }))
  assert.deepEqual((await registry.execute(log, handle, '/compact'))?.result, {
    kind: 'error',
    text: 'Compaction is unavailable because the context service is not loaded.',
  })
})

test('/feedback records the text in its own event, keeps it out of command/run, and needs text', async () => {
  const { store, handle, log } = session()
  const registry = new CommandRegistry()
  registry.register(feedbackCommand(log, () => '00000000-0000-4000-8000-000000000000'))
  assert.deepEqual((await registry.execute(log, handle, '/feedback'))?.result, {
    kind: 'error',
    text: 'Feedback text is required. Usage: /feedback <text>',
  })
  const result = (await registry.execute(log, handle, '/feedback the menu is lovely'))?.result
  assert.deepEqual(result, {
    kind: 'success',
    text: `Feedback recorded for session ${handle.id}\nAnonymous user: 00000000-0000-4000-8000-000000000000.`,
  })
  const events = store.read(handle)
  const feedback = events.filter((event) => event.type === FEEDBACK_EVENT)
  assert.equal(feedback.length, 1)
  assert.equal(feedback[0]?.text, 'the menu is lovely')
  const runs = events.filter((event) => event.type === COMMAND_RUN_EVENT)
  assert.ok(runs.every((event) => event.args === undefined), 'recordInput:false keeps the text out of command/run')
})

test('/permission shows, refuses an unknown preset, narrows freely, and leaves widening to full access to the chip', async () => {
  const { handle, log } = session()
  let mode: SandboxMode = 'workspace-write'
  const writes: SandboxMode[] = []
  const registry = new CommandRegistry()
  registry.register(
    permissionCommand({
      current: () => mode,
      set: (_, next) => {
        writes.push(next)
        const changed = next !== mode
        mode = next
        return { changed }
      },
    }),
  )
  const run = async (line: string) => (await registry.execute(log, handle, line))?.result
  const available = 'read-only, workspace-write, danger-full-access'
  assert.deepEqual(await run('/permission'), { kind: 'success', text: `current preset workspace-write (available: ${available})` })
  assert.deepEqual(await run('/permission root'), { kind: 'error', text: `unknown preset "root" (available: ${available})` })
  assert.deepEqual(await run('/permission danger-full-access'), {
    kind: 'error',
    text: "widening to 'danger-full-access' needs the risk gate: choose it from the access control in the composer",
  })
  assert.deepEqual(writes, [], 'nothing was written for a refusal')
  assert.deepEqual(await run('/permission read-only'), { kind: 'success', text: 'preset read-only' })
  assert.deepEqual(await run('/permission workspace-write'), { kind: 'success', text: 'preset workspace-write' })
  assert.deepEqual(writes, ['read-only', 'workspace-write'])
  mode = 'danger-full-access'
  assert.deepEqual(await run('/permission danger-full-access'), { kind: 'success', text: 'preset danger-full-access' }, 'not a widening when already there')
})

test('/export asks the page to download the same bytes as Download log, and refuses a path', async () => {
  const { handle, log } = session()
  const registry = new CommandRegistry()
  registry.register(exportCommand())
  assert.deepEqual((await registry.execute(log, handle, '/export /tmp/x.zip'))?.result, {
    kind: 'error',
    text: 'The Web /export command does not accept a path.',
  })
  assert.deepEqual((await registry.execute(log, handle, '/export'))?.result, {
    kind: 'success',
    text: 'Session log download requested.',
    action: { kind: 'download', href: `/api/sessions/${handle.id}/log` },
  })
})

test('the built-in commands carry DSH names, descriptions, inputs and menu sections', () => {
  const registry = new CommandRegistry()
  const log: CommandLog = { append: () => assert.fail('not called') }
  const goals = new GoalService(new Context(), new SessionStore(join(root, 'listing')))
  registry.register(goalCommand(goals))
  registry.register(compactCommand({ compactNow: async () => ({ compacted: false }) }))
  registry.register(feedbackCommand(log, () => 'u'))
  registry.register(permissionCommand({ current: () => 'read-only', set: () => ({ changed: false }) }))
  registry.register(exportCommand())
  assert.deepEqual(
    registry.list().map((entry) => [entry.name, entry.label, entry.section, entry.input?.hint ?? null, entry.description]),
    [
      ['compact', 'Compact', 'commands', null, 'Compact older conversation history'],
      ['export', 'Export', 'commands', null, 'Download this session log'],
      ['feedback', 'Feedback', 'add', '<text>', 'Record feedback about this session'],
      ['goal', 'Goal', 'add', '[<objective>|clear|edit <objective>|pause|resume]', 'Set or view the goal for a long-running task'],
      ['permission', 'Permission', 'commands', '<preset>', 'Switch the permission preset (sandbox mode + approval policy)'],
    ],
  )
})

/** The two routes behind a real socket, as the server hands them over. */
async function routes(host: CommandRouteHost): Promise<{ base: string; server: Server }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    void handleCommandRequest(host, request, response, url).then((handled) => {
      if (!handled) {
        response.writeHead(418)
        response.end('not mine\n')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return { base: `http://127.0.0.1:${address.port}`, server }
}

test('the routes list commands, run a registered line, and answer matched:false for anything else', async () => {
  const { store, handle, log } = session()
  const registry = new CommandRegistry()
  registry.register(exportCommand())
  const { base, server } = await routes({ registry, log, open: (id) => store.open(id) })
  try {
    const listed = await fetch(`${base}/api/commands`)
    assert.equal(listed.status, 200)
    assert.deepEqual(await listed.json(), {
      commands: [{ name: 'export', label: 'Export', description: 'Download this session log', section: 'commands' }],
    })

    const post = (id: string, body: string) =>
      fetch(`${base}/api/sessions/${id}/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })

    const ran = await post(handle.id, JSON.stringify({ line: '/export' }))
    assert.equal(ran.status, 200)
    const answer = (await ran.json()) as Record<string, unknown>
    assert.equal(answer.matched, true)
    assert.equal(answer.name, 'export')
    assert.equal(answer.kind, 'success')
    assert.equal(answer.text, 'Session log download requested.')
    assert.deepEqual(answer.action, { kind: 'download', href: `/api/sessions/${handle.id}/log` })
    assert.equal(typeof answer.seq, 'number')

    const refused = (await (await post(handle.id, JSON.stringify({ line: '/export somewhere' }))).json()) as Record<string, unknown>
    assert.equal(refused.kind, 'error', 'a refusal is still a run, with status 200')
    assert.equal(refused.action, undefined)

    const before = store.read(handle).length
    assert.deepEqual(await (await post(handle.id, JSON.stringify({ line: 'just a message' }))).json(), { matched: false })
    assert.deepEqual(await (await post(handle.id, JSON.stringify({ line: '/unknown thing' }))).json(), { matched: false })
    assert.equal(store.read(handle).length, before, 'an unmatched line writes nothing')

    assert.equal((await post('not-a-session', '{}')).status, 400)
    assert.equal((await post('session-00000000-0000-4000-8000-000000000000', JSON.stringify({ line: '/export' }))).status, 404)
    assert.equal((await post(handle.id, 'not json')).status, 400)
    assert.equal((await post(handle.id, JSON.stringify({ line: 7 }))).status, 400)
    assert.equal((await post(handle.id, JSON.stringify(['/export']))).status, 400)
    assert.equal((await post(handle.id, JSON.stringify({ line: `/export ${'x'.repeat(70 * 1024)}` }))).status, 413)
    assert.equal((await fetch(`${base}/api/elsewhere`)).status, 418, 'any other route is left to the server')
    assert.equal((await fetch(`${base}/api/commands`, { method: 'DELETE' })).status, 418)
  } finally {
    server.close()
  }
})

test("a session's history shows each command as its own row, settled by its done event, outside the conversation", async () => {
  const { transcriptTurns } = await import('../src/server/web.ts')
  const turns = transcriptTurns([
    { type: 'message', seq: 0, message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    { type: 'command/run', seq: 1, commandId: 'cmd-0000abcd-1', name: 'goal', args: 'ship it', source: { kind: 'user' } },
    { type: 'goal/change', seq: 2 },
    { type: 'command/done', seq: 3, commandId: 'cmd-0000abcd-1', kind: 'success', text: 'Goal set: ship it' },
    { type: 'command/run', seq: 4, commandId: 'cmd-0000abcd-2', name: 'export' },
    { type: 'command/done', seq: 5, commandId: 'cmd-0000abcd-2', kind: 'error', text: 'The Web /export command does not accept a path.' },
    { type: 'command/run', seq: 6, commandId: 'cmd-0000abcd-3', name: 'compact' },
  ])
  const commands = turns.filter((turn) => turn.kind === 'command')
  assert.deepEqual(commands, [
    { kind: 'command', text: 'Goal set: ship it', commandId: 'cmd-0000abcd-1', name: 'goal', args: 'ship it', state: 'done' },
    { kind: 'command', text: 'The Web /export command does not accept a path.', commandId: 'cmd-0000abcd-2', name: 'export', state: 'error' },
    { kind: 'command', text: '', commandId: 'cmd-0000abcd-3', name: 'compact', state: 'running' },
  ])
  assert.equal(turns[0]?.kind, 'user', 'the conversation keeps its place')
})
