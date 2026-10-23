import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

import {
  fixtureDir,
  parseJson,
  readTranscript,
  removeDir,
  repoRoot,
  runCli,
  sessionsUnder,
  skipUnless,
  tempDir,
  writeJson,
} from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier 3 — context management.
 *
 * Judges one part of `ULTIMATE_GOAL.md`, and it is written from a **consumer's seat** rather than
 * from the shape of the code. Six things a person or a program relying on this harness can feel,
 * and each is one check:
 *
 * 1. **A rewrite shadows a conversation without erasing it** — the model stops seeing the span, a
 *    transcript still shows it, and the checkpoint is read exactly once.
 * 2. **The budget is the window the endpoint declares**, not a number somebody typed into the
 *    harness, and the run reports the pressure it was under.
 * 3. **Cheap before expensive** — trimming one oversized tool result can end the pressure, and then
 *    no summary is paid for.
 * 4. **A cut cannot corrupt a turn** — no span separates a tool call from its result, and the
 *    model is never left without its system prompt.
 * 5. **A summary that does not shrink is refused**, and the conversation is left exactly as it was.
 * 6. **A provider that says the conversation did not fit gets one reduction and one retry**, and
 *    only one.
 *
 * Every one is judged **through the command line**, so the same check judges the TypeScript build and
 * a `HEDDLE_BIN` binary. Four and five used to call `dist/` modules in process, on the reasoning that
 * a scripted provider cannot aim a cut or refuse a summary. It can: a scripted compaction step returns
 * a summary larger than its span, and a cut is aimed through sizes — a tool result priced over the
 * retained budget on its own, read last — so the tail must stop between a call and its answer. The
 * engine's aimed unit cases stay where they belong, in each build's unit suite.
 */

const CAPABILITY = 'context management as a surface with a budget'

/** A profile whose context plugin carries the budget the check wants to exercise. */
function contextProfile(home, options = {}) {
  const dir = fixtureDir('context-profile')
  /**
   * Plugin paths are written relative to the profile directory, which is under
   * `.heddle-tmp/` rather than at the repository root. Measured: a fixture that wrote
   * `./src/plugins/...` booted an empty tree, because a relative specifier resolves against
   * the base layer's own directory — and the loader reports a failed import only in a log
   * line, so the run looked like a profile with no plugins rather than a broken path.
   */
  const prefix = relative(dir, repoRoot).split('\\').join('/')
  const endpoint = {
    name: 'scripted',
    kind: 'scripted',
    baseUrl: options.script ?? join(home, 'script.json'),
    model: 'scripted',
    ...(options.endpoint ?? {}),
  }
  writeJson(join(home, 'heddle.json'), { default: endpoint.name, endpoints: [endpoint] })

  const contextConfig = [
    `        contextWindow: ${options.contextWindow ?? 200_000}`,
    `        instructions: ${options.instructions === false ? 'false' : 'true'}`,
    ...(options.instructionsMaxBytes !== undefined ? [`        instructionsMaxBytes: ${options.instructionsMaxBytes}`] : []),
    ...(options.thresholdTokens !== undefined ? [`        thresholdTokens: ${options.thresholdTokens}`] : []),
    ...(options.retainTokens !== undefined ? [`        retainTokens: ${options.retainTokens}`] : []),
  ].join('\n')

  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(
    join(dir, 'heddle.patch.yml'),
    `- insert:
    # The console exporter is part of the tree, not decoration: without a row for it the
    # profile is a different tree from the one a run normally loads.
    - id: console
      name: ${prefix}/src/plugins/console-exporter.ts
    - id: session
      name: ${prefix}/src/plugins/session.ts
      config:
        root: ${join(home, 'sessions')}
    - id: model
      name: ${prefix}/src/plugins/model.ts
    - id: context
      name: ${prefix}/src/context/service.ts
      inject: [model, session]
      config:
${contextConfig}
    - id: workspace
      name: ${prefix}/src/workspace/service.ts
      inject: [session]
    - id: sandbox
      name: ${prefix}/src/sandbox/service.ts
      config:
        mode: workspace-write
        workspaceRoot: ${options.workspace ?? home}
    - id: approvals
      name: ${prefix}/src/approvals/service.ts
      config:
        mode: allow
    - id: tools
      name: ${prefix}/src/plugins/tools.ts
      inject: [approvals, sandbox]
      config:
        allow: [write_file, read_file, list_dir]
`,
  )
  return dir
}

function harness(label, options = {}) {
  const home = fixtureDir(`context-home-${label}`)
  writeJson(join(home, 'script.json'), { steps: options.steps ?? [{ text: 'a short answer' }] })
  const profileDir = contextProfile(home, options)
  return { home, profileDir, env: { HEDDLE_HOME: home, HEDDLE_CONFIG: join(home, 'heddle.json') } }
}

async function supportsContext() {
  const help = await runCli(['--help'])
  return /context/.test(help.stdout)
}

/** The one session a fixture recorded. */
function sessionOf(home) {
  const session = sessionsUnder(join(home, 'sessions'))[0]
  assert.ok(session, 'a session was recorded')
  return session
}

/** Every event of that session, as recorded — the human's view. */
function eventsOf(home, session) {
  return readTranscript(join(home, 'sessions', session))
}

/**
 * What the model would read, asked of the harness rather than re-derived here.
 *
 * This is the seam the checks lean on: a budget is checkable from numbers, but "the summary is in
 * there once, where the span was" is a claim about the messages themselves, so the checks read the
 * messages the harness says it would send.
 */
async function derived(h, session) {
  const run = await runCli(['--profile', h.profileDir, 'context', session, '--json'], { env: h.env })
  assert.equal(run.code, 0, `the derived context was readable\n${run.stdout}${run.stderr}`)
  return parseJson(run.stdout)
}

/**
 * The page's display fold, which is what a reader is shown.
 *
 * Imported from the build rather than re-implemented here: the claim is about *the panel*, and a
 * check that folded the log itself would only be judging its own idea of the panel.
 */
let panelFold
async function transcriptTurns(events) {
  panelFold ??= (await import(pathToFileURL(join(repoRoot, 'dist', 'server', 'web.js')).href)).transcriptTurns
  return panelFold(events)
}

test('a compaction shadows a span, the log keeps it, and the model reads the summary once', async (context) => {
  if (!skipUnless(context, await supportsContext(), CAPABILITY)) return
  const h = harness('shadow', {
    contextWindow: 900,
    thresholdTokens: 700,
    retainTokens: 100,
    instructions: false,
    steps: [
      { text: 'x'.repeat(300) },
      { text: 'second answer' },
      { purpose: 'compaction', text: 'the briefing' },
    ],
  })
  try {
    const first = await runCli(
      ['--profile', h.profileDir, '--endpoint', 'scripted', '--turn', `first ${'y'.repeat(300)}`],
      { env: h.env },
    )
    assert.equal(first.code, 0, `the first turn ran\n${first.stdout}${first.stderr}`)
    const session = sessionOf(h.home)

    const second = await runCli(
      ['--profile', h.profileDir, '--endpoint', 'scripted', '--resume', session, '--turn', `second ${'z'.repeat(4000)}`, '--json'],
      { env: h.env },
    )
    assert.equal(second.code, 0, `the second turn ran\n${second.stdout}${second.stderr}`)
    const summary = parseJson(second.stdout)
    assert.equal(summary?.context?.compacted, true, `the run reported a compaction\n${second.stdout}`)

    const events = eventsOf(h.home, session)
    assert.ok(events.some((event) => event.type === 'compaction/summary'), 'the summary was recorded')
    assert.ok(events.some((event) => event.type === 'compaction/end'), 'and the transaction closed')
    // The checkpoint and the notes the harness writes are `context/note` events, not messages: a
    // transcript is a view of what a person said, and this is where that distinction is judged.
    const replacements = events.filter((event) => event.type === 'context/note' && event.surfaceOp?.op === 'replace')
    assert.equal(replacements.length, 1, 'exactly one replacement landed, which is the whole rewrite')

    // The log still holds what the model can no longer see.
    assert.ok(
      events.some((event) => JSON.stringify(event.message ?? '').includes('yyyy')),
      'the shadowed span is still readable in the log',
    )

    const view = await derived(h, session)
    const texts = view.messages.map((message) => message.text ?? '')
    assert.equal(
      texts.filter((text) => text.includes('the briefing')).length,
      1,
      `the checkpoint is read exactly once\n${texts.filter((t) => t.includes('the briefing')).length} copies`,
    )
    assert.ok(
      !texts.some((text) => text.includes('yyyy')),
      'and the span it shadows is not sent beside it',
    )
  } finally {
    removeDir(h.home)
  }
})

test('the budget is the window the endpoint declares, and the run reports the pressure', async (context) => {
  if (!skipUnless(context, await supportsContext(), CAPABILITY)) return
  for (const window of [1000, 2000]) {
    const h = harness(`endpoint-window-${window}`, {
      contextWindow: 5000,
      instructions: false,
      endpoint: { contextWindow: window },
    })
    try {
      const run = await runCli(
        ['--profile', h.profileDir, '--endpoint', 'scripted', '--turn', 'say something', '--json'],
        { env: h.env },
      )
      assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
      const summary = parseJson(run.stdout)
      assert.equal(
        summary?.context?.thresholdTokens,
        Math.floor(window * 0.8),
        `the trigger is eighty percent of the endpoint's own window (${window})`,
      )
      const session = sessionOf(h.home)
      const request = eventsOf(h.home, session).find((event) => event.type === 'model/request')
      assert.ok(request, 'the request was recorded')
      assert.ok(
        typeof request.estimatedTokens === 'number' && request.estimatedTokens > 0,
        'and the pressure it was sent under is on the record',
      )
    } finally {
      removeDir(h.home)
    }
  }
})

test('trimming one oversized result can clear the pressure, and then nothing is summarised', async (context) => {
  if (!skipUnless(context, await supportsContext(), CAPABILITY)) return
  const big = 'x'.repeat(30_000)
  const h = harness('prune-first', {
    contextWindow: 3000,
    instructions: false,
    steps: [
      { toolCall: { name: 'write_file', arguments: { path: 'big.txt', content: big } } },
      { toolCall: { name: 'read_file', arguments: { path: 'big.txt' } } },
      { text: 'read it' },
    ],
  })
  try {
    const run = await runCli(
      ['--profile', h.profileDir, '--endpoint', 'scripted', '--turn', 'make a big file and read it back', '--json'],
      { env: h.env },
    )
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
    const summary = parseJson(run.stdout)
    assert.ok((summary?.context?.pruned ?? 0) >= 1, `the run reported a pruning\n${run.stdout}`)

    const session = sessionOf(h.home)
    const events = eventsOf(h.home, session)
    assert.ok(events.some((event) => event.type === 'compaction/prune'), 'the pruning was recorded as a shadow price')
    assert.ok(
      !events.some((event) => event.type === 'compaction/summary'),
      'and no summary was paid for, because the trimming was enough',
    )

    // The log keeps the whole result; the model is sent the trimmed one.
    const original = events.find(
      (event) => event.type === 'message' && event.message?.role === 'tool' && JSON.stringify(event.message).includes('xxxx'),
    )
    assert.ok(original, 'the full tool result is still in the log')
    const view = await derived(h, session)
    const tool = view.messages.filter((message) => message.role === 'tool').map((message) => message.text ?? '')
    assert.ok(
      tool.some((text) => text.includes('pruned')),
      `the model is sent the marker instead of the body\n${tool.map((t) => t.slice(0, 60)).join(' | ')}`,
    )
  } finally {
    removeDir(h.home)
  }
})

/**
 * The conversation both cut checks run on, aimed **through sizes** rather than through an injected
 * `retainTokens` or a module call, so the binary is judged exactly as the TypeScript build is.
 *
 * One turn, because a scripted endpoint replays its steps from the first in every new process: it
 * records a system prompt, writes a file, then reads it back. The read's result is 6000 characters —
 * under the 8192 a result has to exceed before it is pruned, so it keeps its full price — and it is
 * the **newest node** when the pressure check runs before the turn's third request. Priced alone at
 * well over `retainTokens`, it is the node at which the retained tail reaches its budget, so the tail
 * keeps the result and the cut lands between the call and its answer. That is the one position that
 * exercises the rule: the cut must back off before the call. The threshold sits between the second
 * request (after the write) and the third (after the read), so nothing compacts earlier.
 */
const PAIR = { threshold: 3200, retain: 600 }
const PAIR_FILE = 'the quick brown fox jumps over the lazy dog, '.repeat(134).slice(0, 6000)

function pairSteps(compactionStep) {
  return [
    { toolCall: { name: 'write_file', arguments: { path: 'pair.txt', content: PAIR_FILE } } },
    { toolCall: { name: 'read_file', arguments: { path: 'pair.txt' } } },
    { text: 'read it' },
    compactionStep,
  ]
}

/** Run the turn and return the session, its log, and the call and result the cut must keep together. */
async function pairConversation(h) {
  const run = await runCli(
    ['--profile', h.profileDir, '--endpoint', 'scripted', '--system', 'be brief', '--turn', `write then read ${'y'.repeat(2000)}`, '--json'],
    { env: h.env },
  )
  assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
  const session = sessionOf(h.home)
  const events = eventsOf(h.home, session)
  const system = events.find((event) => event.type === 'context/note' && event.origin === 'system-prompt')
  assert.ok(system, 'the system prompt was recorded')
  const call = events.find(
    (event) => event.type === 'assistant/chunk' && event.chunk?.type === 'tool-call' && event.chunk?.name === 'read_file',
  )
  const shape = events.map((event) => event.type + (event.chunk?.name ? `:${event.chunk.name}` : '') + (event.message?.role ? `:${event.message.role}` : '')).join(' ')
  assert.ok(call, `the read call was recorded\n${shape}`)
  const result = events.find(
    (event) => event.type === 'message' && event.message?.role === 'tool' && event.message?.toolCallId === call.chunk.id,
  )
  assert.ok(result, 'and its result')
  assert.ok(
    JSON.stringify(result.message).length > PAIR_FILE.length,
    'the result carries the whole file, so it is priced over the retained budget on its own',
  )
  return { session, events, system, call, result, summary: parseJson(run.stdout) }
}

test('a cut never splits a tool call from its result, and the model keeps its system prompt', async (context) => {
  if (!skipUnless(context, await supportsContext(), CAPABILITY)) return
  const h = harness('cut-pair', {
    contextWindow: 100_000,
    thresholdTokens: PAIR.threshold,
    retainTokens: PAIR.retain,
    instructions: false,
    steps: pairSteps({ purpose: 'compaction', text: 'the briefing' }),
  })
  try {
    const { session, events, system, call, result } = await pairConversation(h)
    const start = events.find((event) => event.type === 'compaction/start')
    assert.ok(start, `a compaction was planned\n${events.map((event) => event.type).join(' ')}`)
    const shadowed = start.shadowedSeqs ?? []
    assert.ok(shadowed.length > 0, 'the plan shadowed something')
    assert.equal(
      shadowed.includes(call.seq),
      shadowed.includes(result.seq),
      `the call and its result were taken together\nshadowed: ${JSON.stringify(shadowed)} call ${call.seq} result ${result.seq}`,
    )
    assert.ok(!shadowed.includes(result.seq), 'and the cut backed off before the pair rather than through it')

    // What the model reads after the rewrite. The system prompt is still read: through the command line it is a
    // note appended when the round starts, after the first prompt, so the plan may shadow that note — the claim a
    // consumer relies on is that the model is never left without it, and the next round restores it.
    const view = await derived(h, session)
    assert.ok(
      view.messages.some((message) => message.role === 'system' && (message.text ?? '').includes('be brief')),
      `the model still reads the system prompt after the rewrite (recorded at seq ${system.seq})`,
    )
    // And every tool message still follows the call that asked for it.
    view.messages.forEach((message, index) => {
      if (message.role !== 'tool') return
      const previous = view.messages[index - 1]
      assert.equal(previous?.role, 'assistant', `tool message ${index} follows an assistant message`)
      assert.match(previous?.text ?? '', /^→ /, `tool message ${index} follows the call that asked for it`)
    })
  } finally {
    removeDir(h.home)
  }
})

test('a summary that does not shrink is refused, and the conversation is left as it was', async (context) => {
  if (!skipUnless(context, await supportsContext(), CAPABILITY)) return
  const h = harness('cut-refused', {
    contextWindow: 100_000,
    thresholdTokens: PAIR.threshold,
    retainTokens: PAIR.retain,
    instructions: false,
    steps: pairSteps({ purpose: 'compaction', text: 'z'.repeat(20_000) }),
  })
  try {
    const { session, events } = await pairConversation(h)
    assert.ok(
      events.some((event) => event.type === 'compaction/failed' && event.refused === true),
      `the refusal is recorded rather than swallowed\n${events.map((event) => event.type).join(' ')}`,
    )
    assert.ok(!events.some((event) => event.type === 'compaction/summary'), 'no summary was accepted')
    assert.ok(
      !events.some((event) => event.type === 'context/note' && event.surfaceOp?.op === 'replace'),
      'and no replacement landed, so the surface is exactly as it was',
    )
    const view = await derived(h, session)
    const texts = view.messages.map((message) => message.text ?? '')
    assert.ok(!texts.some((text) => text.includes('zzzz')), 'no part of the refused summary reached the model')
    assert.ok(texts.some((text) => text.includes('yyyy')), 'and the span it would have shadowed is still sent')
  } finally {
    removeDir(h.home)
  }
})

test('a provider that refused the call gets one reduction and one retry, and only one', async (context) => {
  if (!skipUnless(context, await supportsContext(), CAPABILITY)) return

  const state = { fail: 0 }
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      requests.push(body)
      const wantsSummary = body.includes('Summarise the conversation above')
      const answer = (text) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        response.write('data: [DONE]\n\n')
        response.end()
      }
      if (wantsSummary) return answer('a compact briefing')
      if (state.fail > 0) {
        state.fail -= 1
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: "This model's maximum context length is 4096 tokens", type: 'invalid_request_error' } }))
        return
      }
      return answer('answered')
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()))
  const port = server.address().port
  const h = harness('recovery', {
    /**
     * A window the tool schemas and two turns do not by themselves exceed.
     *
     * Measured while writing this: at 600 tokens the request was over the trigger before the
     * provider ever refused, so the round compacted on its own and the recovery had nothing left
     * to take. The check would then be judging the trigger rather than the recovery.
     */
    contextWindow: 3000,
    instructions: false,
    endpoint: { kind: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/ds`, stream: true },
  })
  try {
    /**
     * The first turn is made substantial on purpose.
     *
     * A checkpoint has to be **smaller** than the span it shadows, and a two-message conversation
     * cannot be: the frame around a one-line summary costs more than the messages do. A check whose
     * history is tiny would therefore be judging the shrink rule rather than recovery.
     */
    const first = await runCli(['--profile', h.profileDir, '--endpoint', 'scripted', '--turn', `hello ${'w'.repeat(500)}`], { env: h.env })
    assert.equal(first.code, 0, `the first turn ran\n${first.stdout}${first.stderr}`)
    const session = sessionOf(h.home)

    state.fail = 1
    const before = requests.length
    const second = await runCli(
      ['--profile', h.profileDir, '--endpoint', 'scripted', '--resume', session, '--turn', `again ${'q'.repeat(600)}`],
      { env: h.env },
    )
    assert.equal(second.code, 0, `the refused turn recovered\n${second.stdout}${second.stderr}`)
    const events = eventsOf(h.home, session)
    const retry = events.find((event) => event.type === 'turn/retry')
    assert.ok(retry, 'the retry was recorded')
    assert.equal(retry.code, 'CONTEXT_WINDOW_EXCEEDED', 'and it says what it was recovering from')
    assert.ok(events.some((event) => event.type === 'compaction/summary'), 'the reduction happened before the retry')
    assert.ok(
      requests.slice(before).length >= 3,
      `the refused call, the summary call and the retry all reached the provider (${requests.slice(before).length})`,
    )

    // The bound: two refusals in a row is a turn that fails rather than a turn that loops.
    state.fail = 5
    const third = await runCli(
      ['--profile', h.profileDir, '--endpoint', 'scripted', '--resume', session, '--turn', 'once more'],
      { env: h.env },
    )
    assert.notEqual(third.code, 0, `a second refusal in one round fails the turn\n${third.stdout}${third.stderr}`)
  } finally {
    removeDir(h.home)
    await new Promise((resolvePromise) => server.close(() => resolvePromise()))
  }
})

test('instructions are one durable baseline that follows an edit', async (context) => {
  if (!skipUnless(context, await supportsContext(), CAPABILITY)) return
  /**
   * Two folders, because the rule under test is **which** one supplies the baseline.
   *
   * `workspace` is where the person runs, and so the folder the conversation is bound to. The profile's
   * sandbox root is a **different** directory holding a decoy `AGENTS.md`, so a baseline read from the
   * sandbox root instead of from the session's own folder announces itself as the wrong safe word rather
   * than passing quietly. Pointing both settings at one folder — as this check first did — cannot tell the
   * two readings apart, and measured: the baseline followed the sandbox root, so a resumed session could
   * be handed another project's house rules.
   */
  const workspace = tempDir('heddle-instructions-')
  const elsewhere = tempDir('heddle-instructions-sandbox-')
  const h = harness('instructions', {
    contextWindow: 100_000,
    workspace: elsewhere,
    steps: [{ text: 'done' }, { text: 'done again' }],
  })
  try {
    writeFileSync(join(workspace, 'AGENTS.md'), '# house rules\n\nThe safe word is ALPHA.\n')
    writeFileSync(join(elsewhere, 'AGENTS.md'), '# another project\n\nThe safe word is ELSEWHERE.\n')
    const first = await runCli(['--profile', h.profileDir, '--endpoint', 'scripted', '--turn', 'hello'], {
      env: h.env,
      cwd: workspace,
    })
    assert.equal(first.code, 0, `the first turn ran\n${first.stdout}${first.stderr}`)
    const session = sessionOf(h.home)

    /**
     * What the **turn** read, taken from the log and read before asking the harness anything.
     *
     * The order is a correction, not a style: `derived()` runs the `context` command, which re-derives the
     * surface and writes its own baseline. A check that asked it first would see the command's correct
     * answer even when the turn had read the wrong folder — measured, a deliberately broken loop passed
     * for exactly that reason. The log is the record of what the turn did, and a replaced note stays in
     * it, so a turn that read the sandbox root's rules cannot hide behind a later correction.
     */
    const read = eventsOf(h.home, session)
      .filter((event) => event.origin === 'instructions')
      .map((event) => JSON.stringify(event.message ?? {}))
    assert.ok(read.length > 0, 'the turn recorded an instruction baseline')
    assert.ok(read.some((text) => text.includes('ALPHA')), 'the baseline carries the session folder’s rules')
    assert.ok(
      !read.some((text) => text.includes('ELSEWHERE')),
      'and the sandbox root’s rules were never read at all, not merely replaced afterwards',
    )

    const view = await derived(h, session)
    const reminders = view.messages.filter((message) => (message.text ?? '').includes('<system-reminder>'))
    assert.equal(reminders.length, 1, 'the instructions arrive as one block, not one message per file')
    assert.ok(reminders[0].text.includes('ALPHA'), 'and they carry what the file says')
    assert.ok(
      !reminders[0].text.includes('ELSEWHERE'),
      'the baseline comes from the session’s own folder, not from the sandbox root',
    )

    writeFileSync(join(workspace, 'AGENTS.md'), '# house rules\n\nThe safe word is BETA.\n')
    const second = await runCli(
      ['--profile', h.profileDir, '--endpoint', 'scripted', '--resume', session, '--turn', 'again'],
      { env: h.env, cwd: workspace },
    )
    assert.equal(second.code, 0, `the second turn ran\n${second.stdout}${second.stderr}`)

    const after = await derived(h, session)
    const refreshed = after.messages.filter((message) => (message.text ?? '').includes('<system-reminder>'))
    assert.equal(refreshed.length, 1, 'an edited baseline is replaced rather than piled up')
    assert.ok(refreshed[0].text.includes('BETA'), 'the new text is what the model reads')
    assert.ok(!refreshed[0].text.includes('ALPHA'), 'and the old text is gone from the surface')

    const events = eventsOf(h.home, session)
    assert.ok(
      events.some((event) => event.type === 'context/note' && event.origin === 'instructions' && event.surfaceOp?.op === 'replace'),
      'the refresh landed as a replacement',
    )
    assert.ok(
      events.some((event) => event.type === 'context/note' && JSON.stringify(event.message ?? {}).includes('ALPHA')),
      'while the log keeps the baseline it replaced',
    )
  } finally {
    removeDir(h.home)
    removeDir(workspace)
    removeDir(elsewhere)
  }
})

test('a long conversation can be compacted more than once, and the reader still sees the conversation', async (context) => {
  if (!skipUnless(context, await supportsContext(), CAPABILITY)) return
  /**
   * Repeated compaction is its own capability, and it is the one a tuned fixture hides.
   *
   * A replacement is written later than what it shadows, so the second compaction of a session
   * shadows a span that **contains** one: its seqs are not in order, and the first version of this
   * harness refused exactly that — every session could be compacted once and never again. The
   * scripted endpoint is only here to make four turns fit a small window.
   */
  const h = harness('repeat', {
    contextWindow: 1200,
    instructions: false,
    steps: [{ text: 'answer one' }, { text: 'answer two' }, { text: 'answer three' }, { text: 'answer four' }, { purpose: 'compaction', text: 'a briefing' }],
  })
  try {
    let session
    for (const index of [1, 2, 3, 4]) {
      const args = ['--profile', h.profileDir, '--endpoint', 'scripted', '--turn', `turn ${index} ${'p'.repeat(2500)}`]
      if (session !== undefined) args.push('--resume', session)
      const run = await runCli(args, { env: h.env })
      assert.equal(run.code, 0, `turn ${index} ran\n${run.stdout}${run.stderr}`)
      session = sessionOf(h.home)
    }

    const events = eventsOf(h.home, session)
    const ended = events.filter((event) => event.type === 'compaction/end')
    assert.ok(ended.length >= 2, `the session compacted more than once (${ended.length})`)
    assert.equal(
      events.filter((event) => String(event.type).startsWith('compaction/start')).length,
      ended.length,
      'every transaction that opened also closed',
    )

    const view = await derived(h, session)
    const checkpoints = view.messages.filter((message) => (message.text ?? '').includes('<compacted-summary>'))
    assert.equal(checkpoints.length, 1, 'the model reads the newest checkpoint, not a pile of them')

    // And the reader's view is the conversation: the harness's own notes are not turns.
    const panel = await transcriptTurns(events)
    assert.equal(panel.filter((turn) => turn.kind === 'user').length, 4, 'the four prompts are the four user turns')
    assert.ok(
      !panel.some((turn) => (turn.text ?? '').includes('<compacted-summary>') || (turn.text ?? '').includes('<system-reminder>')),
      'and no checkpoint or instruction baseline is shown as something a person said',
    )
  } finally {
    removeDir(h.home)
  }
})

test('an instruction budget drops whole files before it truncates one, and names what it dropped', async (context) => {
  if (!skipUnless(context, await supportsContext(), CAPABILITY)) return
  const workspace = tempDir('heddle-budget-')
  const nested = join(workspace, 'sub')
  mkdirSync(join(workspace, '.git'), { recursive: true })
  mkdirSync(nested, { recursive: true })
  const broad = `broad rules ${'b'.repeat(400)}`
  const narrow = `narrow rules ${'n'.repeat(400)}`
  writeFileSync(join(workspace, 'AGENTS.md'), broad)
  writeFileSync(join(nested, 'AGENTS.md'), narrow)

  const h = harness('budget', {
    contextWindow: 100_000,
    workspace: nested,
    instructionsMaxBytes: 500,
    steps: [{ text: 'done' }],
  })
  try {
    /**
     * The run happens **in** `nested`: the baseline is read from the session's own folder, so that is the
     * directory whose two files this check is about, and `workspace`'s `.git` is what makes the walk from
     * it accept the broader file as a candidate worth dropping.
     */
    const run = await runCli(['--profile', h.profileDir, '--endpoint', 'scripted', '--turn', 'hello'], {
      env: h.env,
      cwd: nested,
    })
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
    const view = await derived(h, sessionOf(h.home))
    const baseline = view.messages.map((message) => message.text ?? '').find((text) => text.includes('<system-reminder>'))
    assert.ok(baseline, 'a baseline was sent')
    assert.ok(
      baseline.includes('Workspace instruction budget'),
      `the budget says what it did\n${baseline.slice(0, 300)}`,
    )
    assert.ok(!baseline.includes('bbbb'), 'the broader file was dropped whole rather than truncated')
    assert.ok(baseline.includes('nnnn'), 'and the file nearest the working directory is the one that survived')
  } finally {
    removeDir(h.home)
    removeDir(workspace)
  }
})
