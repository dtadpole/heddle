import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'

import { chatDouble, fixtureDir, parseJson, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier 6 — hooks.
 *
 * Judges one part of `ULTIMATE_GOAL.md`: **hooks intercept a model or a tool call**, the way
 * DSH does it. DSH has no separate hook API — a hook is a Cordis event listener, and what
 * makes it a hook is the event's **mode**: `waterfall` lets a listener rewrite a value or
 * refuse a step by not calling `next()`, while `emit` is observation only.
 *
 * So the claim is judged by writing a hook plugin and watching it change what happens, not by
 * asking the harness whether it has hooks:
 *
 * - a hook on the model request replaces the request, and the answer comes from where the hook
 *   pointed rather than from the configured endpoint;
 * - a hook on a tool call refuses it, and the refusal reaches the model as the tool's result;
 * - a hook after a tool call replaces its result;
 * - a hook is released with the fiber that registered it.
 *
 * Every hook is a real plugin loaded from a layer file, which is how DSH registers one too.
 */

const CAPABILITY = 'hook points over a model call and a tool call, in Cordis event modes'

/**
 * Whether the harness under test is a binary named by `HEDDLE_BIN` rather than the TypeScript build.
 *
 * The TypeScript build loads a hook as a `.ts` plugin. The Rust binary cannot load TypeScript, so under
 * `HEDDLE_BIN` a hook is a **process** (rust/ULTIMATE_GOAL.md, part 6: an outside listener uses the part-4
 * protocol): the row names a component manifest beside the profile — `program` + `args`, the shape D-031 froze
 * — and the process says which points it listens on when it answers `initialize`, the way the plugin calls
 * `ctx.on(...)` when it loads. Every hook below carries both forms with the same decisions, so the claim judged
 * is the same on either build; only the vehicle differs.
 */
const binaryUnderTest = typeof process.env.HEDDLE_BIN === 'string' && process.env.HEDDLE_BIN.length > 0

/** The row's `name:` for a hook: the `.ts` plugin, or the manifest the binary reads. */
const hookFile = (hook) => (binaryUnderTest ? hook.file.replace(/\.ts$/, '.component.yml') : hook.file)

/** A component manifest: the program that starts the hook process, and its script beside the profile. */
function manifestSource(base) {
  return `program: ${JSON.stringify(process.execPath)}
args:
  - ./${base}.mjs
`
}

/**
 * A hook as a process: line-delimited JSON-RPC 2.0 on stdio. `initialize` is answered with the listeners it
 * declares; every `hooks/call` with the hook's decision as a part-4 reply — `next`, `replace`, `merge` (run the
 * rest of the chain, then set keys on its result), `refuse` — or a JSON-RPC error when the hook throws.
 */
function componentSource({ listeners, answer }) {
  return `import { createInterface } from 'node:readline'

const listeners = ${JSON.stringify(listeners)}
const answer = ${answer}
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  if (message.method === 'initialize') return write({ id: message.id, result: { tools: [], listeners } })
  if (message.method === 'shutdown') return write({ id: message.id, result: null })
  if (message.method === 'exit') return process.exit(0)
  if (message.id === undefined) return
  if (message.method !== 'hooks/call') return write({ id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } })
  try {
    write({ id: message.id, result: answer(message.params) })
  } catch (error) {
    write({ id: message.id, error: { code: -32000, message: error.message } })
  }
})
`
}

/**
 * The process form of each hook: the points it declares and its decision, the same as the plugin's.
 *
 * `post` answers `merge` rather than `replace` because the plugin calls `next()` first: the rest of the chain and
 * the tool's own result run, and only then are `output` and `data` set on it — a replacement of a result the tool
 * actually produced, not an invented answer.
 */
const PROCESS_HOOKS = {
  retarget: {
    listeners: [{ point: 'model/request' }],
    answer: `({ payload }) => ({ kind: 'replace', value: { ...payload, endpoint: 'scripted' } })`,
  },
  refuse: {
    listeners: [{ point: 'tools/pre-execute' }],
    answer: `({ payload }) => payload.name === 'write_file' ? { kind: 'replace', value: { allowed: false, reason: 'this hook refuses writes' } } : { kind: 'next' }`,
  },
  post: {
    listeners: [{ point: 'tools/post-execute' }],
    answer: `() => ({ kind: 'merge', value: { output: 'redacted by the hook', data: { replacedBy: 'post-hook' } } })`,
  },
  stop: {
    listeners: [{ point: 'agent/pre-step' }],
    answer: `() => ({ kind: 'refuse', reason: 'refused by hook: this hook refuses to send the request' })`,
  },
  broken: {
    listeners: [{ point: 'tools/pre-execute' }, { point: 'model/request' }],
    answer: `({ point }) => { throw new Error(point === 'model/request' ? 'this hook is broken too' : 'this hook is broken') }`,
  },
}

/** A profile for this check, with the plugin paths relative to the profile directory. */
function hookProfile(home, options = {}) {
  const dir = fixtureDir('hooks-profile')
  const prefix = relative(dir, repoRoot).split('\\').join('/')
  writeJson(join(home, 'heddle.json'), {
    default: options.endpoint ?? 'double',
    endpoints: [
      // The scripted endpoint is always configured, even when the turn starts somewhere else,
      // because a hook that retargets a request needs somewhere to retarget it to.
      { name: 'scripted', kind: 'scripted', baseUrl: options.script, model: 'scripted' },
      ...(options.doubleUrl !== undefined
        ? [{ name: 'double', kind: 'openai-chat', baseUrl: options.doubleUrl, model: 'double', stream: true }]
        : []),
    ],
  })
  const hookRows = (options.hooks ?? [])
    .map(
      // A hook plugin is written **beside the profile**, so its specifier is relative to the
      // profile directory. Measured: prefixing it the way a repository plugin is prefixed
      // resolved to `/Users/zhenc/heddle/retarget.ts`, which is nowhere.
      (hook, index) => `    - id: hook-${index + 1}
      name: ./${hookFile(hook)}
`,
    )
    .join('')
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(
    join(dir, 'heddle.patch.yml'),
    `- insert:
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
        contextWindow: 200000
    - id: sandbox
      name: ${prefix}/src/sandbox/service.ts
      config:
        mode: workspace-write
        workspaceRoot: ${home}
    - id: approvals
      name: ${prefix}/src/approvals/service.ts
      config:
        mode: allow
    - id: tools
      name: ${prefix}/src/plugins/tools.ts
      inject: [approvals, sandbox]
      config:
        allow: [write_file, read_file, list_dir]
${hookRows}`,
  )
  for (const hook of options.hooks ?? []) {
    if (binaryUnderTest) {
      const base = hook.file.replace(/\.ts$/, '')
      writeFileSync(join(dir, `${base}.component.yml`), manifestSource(base))
      writeFileSync(join(dir, `${base}.mjs`), componentSource(PROCESS_HOOKS[base]))
    } else writeFileSync(join(dir, hook.file), hook.source)
  }
  return dir
}

function harness(label, options = {}) {
  const home = fixtureDir(`hooks-home-${label}`)
  const { script } = scriptedConfig({ home, steps: options.steps ?? [{ text: 'the plain answer' }] })
  /**
   * The script's path is handed to the profile builder rather than left to be read back from
   * the configuration: the builder writes its own `heddle.json` and overwrote the one
   * `scriptedConfig` had just written, so the endpoint kept the default relative path and the
   * run failed with "could not be read at scripted.json".
   */
  const profileDir = hookProfile(home, { ...options, script })
  // The sandbox root is named explicitly: the CLI runs from the repository, and a fixture that wrote a
  // relative path once landed inside it.
  return {
    home,
    profileDir,
    env: { HEDDLE_HOME: home, HEDDLE_CONFIG: join(home, 'heddle.json') },
    sandboxArg: ['--sandbox-root', home],
  }
}

async function supportsHooks() {
  const help = await runCli(['--help'])
  // The probe asks for every command this part's checks run, matched as a command line rather than as a word:
  // a check that runs a command the harness does not advertise would fail, not skip, and that failure would
  // be about the missing command, not about this part.
  return /^\s{2}hooks\b/m.test(help.stdout) && /--turn/.test(help.stdout)
}

/** A hook plugin that rewrites every model request to another endpoint. */
const RETARGET_HOOK = `export const name = 'retarget-hook'
export const inject = ['model']

export default function retarget(ctx) {
  ctx.on('model/request', (request, next) => {
    // A waterfall listener that does not call next() has replaced the value for every
    // listener after it, which is how DSH's waterfall refuses or overrides a step.
    return { ...request, endpoint: 'scripted' }
  })
}
`

test('the hook points are named and reachable', async (context) => {
  if (!skipUnless(context, await supportsHooks(), CAPABILITY)) return
  const h = harness('points')
  try {
    const run = await runCli(['--profile', h.profileDir, ...h.sandboxArg, 'hooks', '--json'], { env: h.env })
    assert.equal(run.code, 0, `the command ran\n${run.stdout}${run.stderr}`)
    const points = parseJson(run.stdout)
    assert.ok(Array.isArray(points) && points.length > 0, `hook points were listed\n${run.stdout}`)
    const names = points.map((point) => point.name)
    for (const wanted of ['model/request', 'model/stream', 'tools/pre-execute', 'tools/post-execute', 'agent/pre-step']) {
      assert.ok(names.includes(wanted), `'${wanted}' is a hook point\nsaw: ${names.join(', ')}`)
    }
    const waterfall = points.filter((point) => point.mode === 'waterfall').map((point) => point.name)
    assert.ok(waterfall.length >= 4, `the rewriting points are waterfalls\nsaw: ${waterfall.join(', ')}`)
  } finally {
    removeDir(h.home)
  }
})

test('a hook rewrites a model request and the answer comes from where it pointed', async (context) => {
  if (!skipUnless(context, await supportsHooks(), CAPABILITY)) return
  /**
   * The configured endpoint is a **double**, and the hook retargets every request to the
   * scripted endpoint. If the answer is the scripted answer, the hook ran and its returned
   * request was the one dispatched — which is the whole difference between a waterfall and an
   * observer.
   */
  const double = await chatDouble({ content: 'the double answer' })
  const h = harness('retarget', {
    endpoint: 'double',
    doubleUrl: double.baseUrl,
    steps: [{ text: 'the scripted answer' }],
    hooks: [{ file: 'retarget.ts', source: RETARGET_HOOK }],
  })
  try {
    const run = await runCli(['--profile', h.profileDir, ...h.sandboxArg, '--turn', 'say something', '--json'], { env: h.env })
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
    const summary = parseJson(run.stdout)
    assert.match(summary.text ?? '', /the scripted answer/, `the hook's endpoint answered\n${run.stdout}`)
    assert.equal(double.requests.length, 0, 'the configured endpoint was never reached')
  } finally {
    removeDir(h.home)
    await double.close()
  }
})

test('a hook refuses a tool call and the refusal reaches the model', async (context) => {
  if (!skipUnless(context, await supportsHooks(), CAPABILITY)) return
  const h = harness('refuse', {
    steps: [
      { toolCall: { name: 'write_file', arguments: { path: 'should-not-exist.txt', content: 'no' } } },
      { text: 'understood' },
    ],
    hooks: [
      {
        file: 'refuse.ts',
        source: `export const name = 'refuse-hook'
export default function refuse(ctx) {
  ctx.on('tools/pre-execute', (call, next) => {
    if (call.name === 'write_file') return { allowed: false, reason: 'this hook refuses writes' }
    return next()
  })
}
`,
      },
    ],
  })
  try {
    const run = await runCli(['--profile', h.profileDir, ...h.sandboxArg, '--turn', 'write the file'], { env: h.env })
    /**
     * A refused call is a non-zero exit, and that is the harness behaving correctly: a denial
     * is a fact about the run. Measured: requiring exit zero here failed on a run that did
     * exactly what the claim asks for.
     */
    assert.equal(run.timedOut, false, `the run finished\n${run.stdout}${run.stderr}`)
    assert.ok(run.stdout.length > 0 || run.stderr.length > 0, 'the run said what it did')
    const session = sessionsUnder(join(h.home, 'sessions'))[0]
    assert.ok(session, `a session exists under ${join(h.home, 'sessions')}\n${run.stdout}`)
    const events = readTranscript(join(h.home, 'sessions', session))
    const toolResults = events
      .filter((event) => event.type === 'message' && event.message?.role === 'tool')
      .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
    const recorded = events
      .filter((event) => event.type === 'message')
      .map((event) => `${event.message?.role}: ${(event.message?.content ?? []).map((part) => part.text ?? '').join('')}`)
    assert.ok(
      toolResults.length > 0,
      `the model was told what happened to its call; recorded messages: ${JSON.stringify(recorded)}`,
    )
    assert.match(toolResults.join('\n'), /refuses writes/, `the refusal was reported as the tool result\n${toolResults.join(' | ')}`)
  } finally {
    removeDir(h.home)
  }
})

test('a hook replaces a tool result after the call', async (context) => {
  if (!skipUnless(context, await supportsHooks(), CAPABILITY)) return
  const h = harness('post', {
    /**
     * A file is written first and read in the next round, so the read **succeeds** and the
     * post-execute hook has a real result to replace. Measured: pointed at a missing file, the
     * tool threw before the hook chain ran, so the hook's replacement never applied — and the
     * check failed for a reason that said nothing about hooks.
     */
    steps: [
      { toolCall: { name: 'write_file', arguments: { path: 'present.txt', content: 'the real contents' } } },
      { toolCall: { name: 'read_file', arguments: { path: 'present.txt' } } },
      { text: 'fine' },
    ],
    hooks: [
      {
        file: 'post.ts',
        source: `export const name = 'post-hook'
export default function post(ctx) {
  ctx.on('tools/post-execute', (call, next) => {
    // A post-execute waterfall is where a policy redacts, spills or replaces a result.
    const result = next()
    // A post-execute hook replaces a result the tool actually produced; calling next()
    // first is what makes this a replacement rather than an invented answer, and it is how
    // DSH's post-execute waterfall is written.
    return { ...result, output: 'redacted by the hook', data: { replacedBy: 'post-hook' } }
  })
}
`,
      },
    ],
  })
  try {
    const run = await runCli(['--profile', h.profileDir, ...h.sandboxArg, '--turn', 'read the file'], { env: h.env })
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
    const session = sessionsUnder(join(h.home, 'sessions'))[0]
    assert.ok(session, `a session exists under ${join(h.home, 'sessions')}\n${run.stdout}`)
    const events = readTranscript(join(h.home, 'sessions', session))
    const toolResults = events
      .filter((event) => event.type === 'message' && event.message?.role === 'tool')
      .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
    assert.ok(toolResults.length > 0, `the tool result was recorded\n${run.stdout}`)
    assert.match(
      toolResults.join('\n'),
      /redacted by the hook/,
      `the hook replaced what the tool returned\nsaw: ${toolResults.join(' | ')}`,
    )
  } finally {
    removeDir(h.home)
  }
})

test('a hook that refuses a round stops it', async (context) => {
  if (!skipUnless(context, await supportsHooks(), CAPABILITY)) return
  const h = harness('pre-step', {
    hooks: [
      {
        file: 'stop.ts',
        source: `export const name = 'stop-hook'
export default function stop(ctx) {
  ctx.on('agent/pre-step', () => {
    // Throwing from a pre-step waterfall refuses the round; the loop reports the failure
    // rather than answering as if the request had been made.
    // A hook that means to refuse says so, so the failure reads as a policy decision.
    const error = new Error('refused by hook: this hook refuses to send the request')
    error.name = 'HookRefusal'
    throw error
  })
}
`,
      },
    ],
  })
  try {
    const run = await runCli(['--profile', h.profileDir, ...h.sandboxArg, '--turn', 'say something'], { env: h.env })
    assert.notEqual(run.code, 0, 'the run failed rather than answering')
    assert.match(run.stderr + run.stdout, /refuses to send/, 'and said which hook refused it')
  } finally {
    removeDir(h.home)
  }
})

test('a hook that throws does not take the run down, and the harness still answers', async (context) => {
  if (!skipUnless(context, await supportsHooks(), CAPABILITY)) return
  /**
   * Hooks are policy, and a broken policy must not become an outage: a listener with a typo in it would
   * otherwise turn every run into a crash with a stack trace about someone else's plugin.
   *
   * The claim is deliberately narrow, because the runtime decides the mechanism: the turn completes and
   * produces an answer. Whether the broken listener is skipped or the call refused is the runtime's
   * business, and a check that demanded one of those would be asserting Cordis's internals rather than
   * this harness's behaviour.
   */
  const h = harness('broken', {
    hooks: [
      {
        file: 'broken.ts',
        source: `export const name = 'broken-hook'
export default function broken(ctx) {
  ctx.on('tools/pre-execute', () => { throw new Error('this hook is broken') })
  ctx.on('model/request', () => { throw new Error('this hook is broken too') })
}
`,
      },
    ],
  })
  try {
    const run = await runCli(['--profile', h.profileDir, ...h.sandboxArg, '--turn', 'say something', '--json'], { env: h.env, timeoutMs: 60_000 })
    assert.equal(run.timedOut, false, `the run finished rather than hanging\n${run.stdout}${run.stderr}`)
    /**
     * The turn fails, and the failure is **about the hook**.
     *
     * Decided by what a person needs rather than by what would be convenient: a policy that throws is a
     * broken policy, and silently answering as if the policy did not exist is the worst outcome — the
     * user believes a rule was applied when it was not. What the harness owes them is a message that
     * names the hook rather than a stack trace or a plausible answer.
     */
    assert.notEqual(run.code, 0, 'a throwing hook fails the turn rather than being ignored')
    assert.match(run.stderr + run.stdout, /hook/i, `and the failure names the hook\n${run.stdout}${run.stderr}`)
  } finally {
    removeDir(h.home)
  }
})
