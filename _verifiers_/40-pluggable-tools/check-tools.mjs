import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, parseJson, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier 4 — pluggable tools.
 *
 * Judges one part of `ULTIMATE_GOAL.md`: tools are **configurable and pluggable**.
 *
 * The extension point is the claim, not the catalogue. So the checks are: the harness ships
 * tools that carry a description a model can read; a configuration chooses which of them exist;
 * a tool written **outside this repository** is loaded from a layer file and works; and a
 * configuration naming a tool that does not exist fails where it is written rather than at first
 * use.
 *
 * The out-of-repository tool is the important one. A tool that has to be added to `src/` is a
 * hardcoded tool with extra steps.
 */

const CAPABILITY = 'tools chosen by configuration and augmentable from outside the project'

/**
 * Whether the harness under test is a binary named by `HEDDLE_BIN` rather than the TypeScript build.
 *
 * The TypeScript build loads an outside tool as a `.ts` plugin. A Rust binary cannot load TypeScript, so under
 * `HEDDLE_BIN` each fixture tool is a **process** instead — part 4's Rust shape in `rust/ULTIMATE_GOAL.md`: the row
 * names a component manifest beside the profile (`program` + `args`, the shape D-031 froze), and the script speaks
 * line-delimited JSON-RPC 2.0 on stdio (`rust/crates/heddle-tools/PROTOCOL.md`). Each process declares the same spec
 * its plugin registers and answers a call the way the plugin's `run` does, so the claim judged is the same on either
 * build; only the vehicle differs.
 */
const binaryUnderTest = typeof process.env.HEDDLE_BIN === 'string' && process.env.HEDDLE_BIN.length > 0

/** A component manifest: the program that starts the tool process, and its script beside the profile. */
function manifestSource(base) {
  return `program: ${JSON.stringify(process.execPath)}
args:
  - ./${base}.mjs
`
}

/**
 * A tool as a process. `initialize` is answered with the declared specs; `tools/call` runs `call(params, ask)`, where
 * `ask(method, params)` sends a request back to the host (the `sandbox/*` back-channel) and resolves with its result
 * or rejects with its error; `shutdown` and `exit` end it.
 */
function componentSource({ tools, call }) {
  return `import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'

const tools = ${JSON.stringify(tools)}
const call = ${call}
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
const pending = new Map()
let next = 0
const ask = (method, params) =>
  new Promise((resolve, reject) => {
    const id = 's' + ++next
    pending.set(id, { resolve, reject })
    write({ id, method, params })
  })
createInterface({ input: process.stdin }).on('line', async (line) => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  if (message.method === undefined && pending.has(message.id)) {
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    return message.error ? waiter.reject(message.error) : waiter.resolve(message.result)
  }
  if (message.method === 'initialize') return write({ id: message.id, result: { tools } })
  if (message.method === 'shutdown') return write({ id: message.id, result: null })
  if (message.method === 'exit') return process.exit(0)
  if (message.id === undefined) return
  if (message.method !== 'tools/call') return write({ id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } })
  try {
    write({ id: message.id, result: await call({ ...message.params, id: message.id }, ask, writeFileSync) })
  } catch (error) {
    write({ id: message.id, error: { code: error.code ?? -32603, message: error.message ?? String(error), ...(error.data ? { data: error.data } : {}) } })
  }
})
`
}

/** The process form of each fixture plugin: the spec it declares and what a call does, the same as the plugin's. */
const PROCESS_TOOLS = {
  'shout-tool': {
    tools: [
      {
        name: 'shout',
        description: 'Write a shout file containing the text, uppercased.',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      },
    ],
    // As the plugin does: assert the workspace file writable through the host's sandbox, then write it.
    call: `async ({ args, context, id }, ask, writeFileSync) => {
  const admitted = await ask('sandbox/assertWritable', { path: context.workspaceRoot.replace(/\\/$/, '') + '/shout.txt', call: id })
  writeFileSync(admitted.path, String(args.text ?? '').toUpperCase())
  return { output: 'wrote shout.txt' }
}`,
  },
  'shadow-tool': {
    tools: [{ name: 'read_file', description: "the project's own read_file, which wins", parameters: { type: 'object', properties: {} } }],
    call: `async () => ({ output: 'the replacement ran' })`,
  },
  'bad-tool': {
    tools: [{ name: '', description: '' }],
    call: `async () => ({ output: '' })`,
  },
}

/** The row's `name:` for a fixture plugin: the `.ts` plugin, or the manifest the binary reads. */
const pluginFile = (name) => (binaryUnderTest ? name.replace(/\.ts$/, '.component.yml') : name)

/** A profile whose tool row carries the allow list the check wants, plus any fixture plugins. */
function toolProfile(home, options = {}) {
  const dir = fixtureDir('tools-profile')
  const prefix = relative(dir, repoRoot).split('\\').join('/')
  writeJson(join(home, 'heddle.json'), {
    default: 'scripted',
    endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: options.script, model: 'scripted' }],
  })
  for (const file of options.plugins ?? []) {
    if (binaryUnderTest) {
      const base = file.name.replace(/\.ts$/, '')
      writeFileSync(join(dir, `${base}.component.yml`), manifestSource(base))
      writeFileSync(join(dir, `${base}.mjs`), componentSource(PROCESS_TOOLS[base]))
    } else writeFileSync(join(dir, file.name), file.source)
  }
  const pluginRows = (options.plugins ?? [])
    .map(
      (plugin, index) => `    - id: plugin-${index + 1}
      name: ./${pluginFile(plugin.name)}
      inject: [tools, sandbox]
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
        mode: ${options.mode ?? 'allow'}
    - id: tools
      name: ${prefix}/src/plugins/tools.ts
      inject: [approvals, sandbox]
      config:
        allow: ${JSON.stringify(options.allow ?? ['write_file', 'read_file', 'list_dir'])}
${pluginRows}`,
  )
  return dir
}

function harness(label, options = {}) {
  const home = fixtureDir(`tools-home-${label}`)
  const { script } = scriptedConfig({ home, steps: options.steps ?? [{ text: 'done' }] })
  const profileDir = toolProfile(home, { ...options, script })
  // The built CLI is run from the repository, so the sandbox root is named explicitly: measured, a
  // fixture without this let a relative `write_file` land in the repository itself.
  return {
    home,
    profileDir,
    env: { HEDDLE_HOME: home, HEDDLE_CONFIG: join(home, 'heddle.json') },
    sandboxArg: ['--sandbox-root', home],
  }
}

async function supportsTools() {
  const help = await runCli(['--help'])
  // The probe asks for every command this part's checks run, matched as a command line rather than as a word:
  // a check that runs a command the harness does not advertise would fail, not skip, and that failure would
  // be about the missing command, not about this part.
  return /^\s{2}tools\b/m.test(help.stdout) && /--turn/.test(help.stdout)
}

test('the tools the configuration allows are the tools that exist', async (context) => {
  if (!skipUnless(context, await supportsTools(), CAPABILITY)) return
  const h = harness('allow', { allow: ['read_file'] })
  try {
    const run = await runCli(['--profile', h.profileDir, ...h.sandboxArg, 'tools', '--json'], { env: h.env })
    assert.equal(run.code, 0, `the command ran\n${run.stdout}${run.stderr}`)
    const tools = parseJson(run.stdout)
    assert.ok(Array.isArray(tools), `it printed a list\n${run.stdout}`)
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['read_file'],
      'only the tool the configuration allowed is registered',
    )
    assert.ok((tools[0].description ?? '').length > 10, 'and it carries a description a model can read')
  } finally {
    removeDir(h.home)
  }
})

test('a configuration naming a tool that does not exist fails where it is written', async (context) => {
  if (!skipUnless(context, await supportsTools(), CAPABILITY)) return
  const h = harness('unknown', { allow: ['read_file', 'definitely_not_a_tool'] })
  try {
    const run = await runCli(['--profile', h.profileDir, ...h.sandboxArg, '--turn', 'say something'], { env: h.env })
    assert.notEqual(run.code, 0, 'the run fails rather than starting without it')
    assert.match(run.stderr + run.stdout, /definitely_not_a_tool/, 'and the failure names the tool')
  } finally {
    removeDir(h.home)
  }
})

test('a tool written outside this repository can be plugged in and used', async (context) => {
  if (!skipUnless(context, await supportsTools(), CAPABILITY)) return
  /**
   * The fixture plugin lives beside the profile, registers a tool through the same service the
   * built-ins use, and writes a file when called. The script asks for it by name, so the check
   * proves three things at once: it loaded, the model was told about it, and calling it ran the
   * code from outside the repository.
   */
  const h = harness('plugin', {
    allow: ['write_file', 'read_file', 'list_dir', 'shout'],
    steps: [{ toolCall: { name: 'shout', arguments: { text: 'from the plugin' } } }, { text: 'done' }],
    plugins: [
      {
        name: 'shout-tool.ts',
        source: `export const name = 'shout-tool'
export const inject = ['tools', 'sandbox']

export default function shout(ctx) {
  ctx.tools.register({
    spec: {
      name: 'shout',
      description: 'Write a shout file containing the text, uppercased.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
    run: async (args) => {
      const { writeFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      const target = join(ctx.sandbox.workspaceRoot, 'shout.txt')
      ctx.sandbox.assertWritable(target)
      writeFileSync(target, String(args.text ?? '').toUpperCase())
      return { output: 'wrote shout.txt' }
    },
  })
}
`,
      },
    ],
  })
  try {
    const listing = await runCli(['--profile', h.profileDir, ...h.sandboxArg, 'tools', '--json'], { env: h.env })
    const tools = parseJson(listing.stdout)
    assert.ok(
      Array.isArray(tools) && tools.some((tool) => tool.name === 'shout'),
      `the plugin's tool is registered\n${listing.stdout}`,
    )

    const run = await runCli(['--profile', h.profileDir, ...h.sandboxArg, '--turn', 'shout something'], { env: h.env })
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
    const session = sessionsUnder(join(h.home, 'sessions'))[0]
    const events = readTranscript(join(h.home, 'sessions', session))
    const toolResults = events
      .filter((event) => event.type === 'message' && event.message?.role === 'tool')
      .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
    assert.match(toolResults.join('\n'), /wrote shout\.txt/, 'the out-of-repository tool ran')
  } finally {
    removeDir(h.home)
  }
})

test('a tool is only reachable through the registry, so an unknown name is refused', async (context) => {
  if (!skipUnless(context, await supportsTools(), CAPABILITY)) return
  const h = harness('unknown-call', {
    allow: ['read_file'],
    steps: [{ toolCall: { name: 'write_file', arguments: { path: 'x.txt', content: 'no' } } }, { text: 'understood' }],
  })
  try {
    const run = await runCli(['--profile', h.profileDir, ...h.sandboxArg, '--turn', 'write something'], { env: h.env })
    const session = sessionsUnder(join(h.home, 'sessions'))[0]
    const events = readTranscript(join(h.home, 'sessions', session))
    const toolResults = events
      .filter((event) => event.type === 'message' && event.message?.role === 'tool')
      .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
    assert.match(toolResults.join('\n'), /UNKNOWN_TOOL|no tool named/, `an unregistered tool is refused by name\n${run.stdout}`)
  } finally {
    removeDir(h.home)
  }
})

test('a plugin that registers a name already taken displaces it, and the listing says which won', async (context) => {
  if (!skipUnless(context, await supportsTools(), CAPABILITY)) return
  /**
   * Two plugins can legitimately want the same tool name — a project replacing a built-in with its
   * own `read_file` is the ordinary case. What a user needs is that the outcome is **defined and
   * visible** rather than order-dependent and silent, so the claim is: the later registration wins,
   * exactly one tool answers to the name, and `heddle tools` shows the replacement's description.
   */
  const h = harness('shadow', {
    /**
     * The allow list names the built-in and the replacement. It is a filter over what a build
     * registers, and a replacement is registered by a plugin — so a profile that listed only the
     * built-in would filter the replacement out before the question of precedence arose. Measured:
     * the first version did exactly that and asserted about a tool that had never loaded.
     */
    allow: ['read_file', 'shadow_read'],
    steps: [{ text: 'done' }],
    plugins: [
      {
        name: 'shadow-tool.ts',
        source: `export const name = 'shadow-tool'
export const inject = ['tools']

export default function shadow(ctx) {
  // The same name the built-in uses, registered from outside the project.
  ctx.tools.register({
    spec: { name: 'read_file', description: "the project's own read_file, which wins", parameters: { type: 'object', properties: {} } },
    run: async () => ({ output: 'the replacement ran' }),
  })
}
`,
      },
    ],
  })
  try {
    const listing = parseJson((await runCli(['--profile', h.profileDir, ...h.sandboxArg, 'tools', '--json'], { env: h.env })).stdout)
    const readFile = (listing ?? []).filter((tool) => tool.name === 'read_file')
    assert.equal(readFile.length, 1, `exactly one tool answers to the name\n${JSON.stringify(listing)}`)
    assert.match(readFile[0].description, /wins/, 'and the listing describes the replacement rather than the built-in')
  } finally {
    removeDir(h.home)
  }
})

test('a plugin that registers a tool with a malformed spec is refused at registration', async (context) => {
  if (!skipUnless(context, await supportsTools(), CAPABILITY)) return
  /**
   * A tool without a name or a description is one a model cannot be told about, so it must fail where
   * it is registered rather than appearing in a prompt as `undefined`.
   */
  const h = harness('bad-spec', {
    allow: ['read_file'],
    steps: [{ text: 'done' }],
    plugins: [
      {
        name: 'bad-tool.ts',
        source: `export const name = 'bad-tool'
export const inject = ['tools']

export default function bad(ctx) {
  ctx.tools.register({ spec: { name: '', description: '' }, run: async () => ({ output: '' }) })
}
`,
      },
    ],
  })
  try {
    const run = await runCli(['--profile', h.profileDir, ...h.sandboxArg, 'tools', '--json'], { env: h.env })
    assert.notEqual(run.code, 0, `registering an unnamed tool fails the run rather than listing it\n${run.stdout}${run.stderr}`)
    assert.match(run.stderr + run.stdout, /name|description/i, 'and the failure says what was missing')
  } finally {
    removeDir(h.home)
  }
})
