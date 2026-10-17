import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The check behind [`dsh-context.md`](dsh-context.md).
 *
 * It judges one thing: **does that reading still describe the DSH that is installed here?** The
 * reading grounds design decisions in this repository, so a reading that has drifted is worse than no
 * reading — it cites line numbers and constants that no longer exist, and the code that trusted it
 * looks arbitrary. Every assertion below is a fact the reading states, so a failure is a statement
 * about the document rather than about DSH.
 *
 * Nothing is started and nothing is spent: these are reads of shipped JavaScript.
 *
 * The install location is machine configuration, so it comes from `$HEDDLE_DSH_ROOT` first and from
 * the usual install paths otherwise, and a machine with no DSH reports **unjudged** — never a pass.
 */

const CAPABILITY = 'an installed DSH to read'

/** Where a DSH install is looked for, in order, unless `$HEDDLE_DSH_ROOT` says otherwise. */
const CANDIDATES = [
  join(homedir(), '.volta/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'),
  join(homedir(), '.volta/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai'),
  join(homedir(), '.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'),
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
]

/** Whether a directory holds DSH's packages rather than the scope that contains the CLI. */
function isPackageRoot(path) {
  return existsSync(join(path, 'dsh-session/lib/index.js'))
}

/** The package root this run reads, or `undefined` when the machine has none. */
function findPackageRoot() {
  const configured = process.env.HEDDLE_DSH_ROOT
  if (configured !== undefined && configured.length > 0) return isPackageRoot(configured) ? configured : undefined
  return CANDIDATES.find((candidate) => isPackageRoot(candidate))
}

const packageRoot = findPackageRoot()

/**
 * Read one shipped file, or `undefined` when the package is not installed.
 *
 * An unreadable file is not a silent pass: the callers turn `undefined` into a skip, and the runner
 * turns a skip into exit `3`.
 */
function source(pkg, file = 'lib/index.js') {
  if (packageRoot === undefined) return undefined
  try {
    return readFileSync(join(packageRoot, pkg, file), 'utf8')
  } catch {
    return undefined
  }
}

/** Assert that a source states a fact, naming the file when it does not. */
function states(text, needle, subject) {
  assert.ok(
    text.includes(needle),
    `${subject} no longer states ${JSON.stringify(needle)} — dsh-context.md must be re-read against this install`,
  )
}

/** Assert that a source no longer states a fact the reading was corrected away from. */
function statesNothing(text, needle, subject) {
  assert.ok(!text.includes(needle), `${subject} now contains ${JSON.stringify(needle)} — dsh-context.md must be re-read`)
}

/**
 * Begin a check that needs one package.
 *
 * A missing package is reported as unjudged rather than failed, because "this machine has no copy" and
 * "the reading is wrong" are different answers and only one of them is about the reading.
 */
function needs(context, pkg, file) {
  if (!skipUnless(context, packageRoot !== undefined, CAPABILITY)) return undefined
  const text = source(pkg, file)
  return skipUnless(context, text !== undefined, `${pkg}/${file ?? 'lib/index.js'}`) ? text : undefined
}

test('the message list comes from the surface, and the request carries what the reading says', async (context) => {
  const loop = needs(context, 'dsh-agent-loop')
  if (loop === undefined) return
  const session = needs(context, 'dsh-session')
  if (session === undefined) return

  states(loop, 'const boundaryMessages = session.deriveMessages()', 'dsh-agent-loop')
  states(loop, 'toolHistory: session.toolHistory()', 'dsh-agent-loop')
  states(loop, 'preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)', 'dsh-agent-loop')
  states(session, 'must omit header.system; use system/message', 'dsh-session')
})

test('the surface has five message-producing types, and derivation is projection-aware', async (context) => {
  const session = needs(context, 'dsh-session')
  if (session === undefined) return

  const block = /const SURFACE_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\)/.exec(session)
  assert.ok(block !== null, 'dsh-session no longer declares SURFACE_EVENT_TYPES as a set literal')
  const members = [...block[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1])
  assert.equal(
    members.length,
    5,
    `the surface has ${members.length} types (${members.join(', ')}) — dsh-context.md says five`,
  )
  assert.ok(members.includes('developer/message'), 'developer/message left the surface — the reading would say five and be wrong')
  states(session, 'case "developer/message":', 'dsh-session deriveEventMessage')
  states(session, 'projectedMessages?.get(event.seq)', 'dsh-session deriveEventMessage')
})

test('a compaction appends four events, replaces one range, and refuses a summary that does not shrink', async (context) => {
  const basic = needs(context, 'dsh-compaction-basic')
  if (basic === undefined) return
  const compaction = needs(context, 'dsh-compaction')
  if (compaction === undefined) return

  for (const event of ['compaction/start', 'compaction/summary', 'compaction/end']) {
    states(basic, `session.append("${event}"`, 'dsh-compaction-basic')
  }
  states(basic, 'session.append("user/message", checkpointMessage, {', 'dsh-compaction-basic')
  states(basic, 'op: "replace"', 'dsh-compaction-basic')
  states(basic, 'sourceEventSeqs: [', 'dsh-compaction-basic')
  states(basic, 'summary is not smaller than the shadowed content', 'dsh-compaction-basic')

  states(compaction, 'kind: "compact-checkpoint"', 'dsh-compaction')
  statesNothing(compaction, 'plugin: "compact"', 'dsh-compaction')
})

test('pruning is a surface rewrite, it runs inside compaction, and it does not rank', async (context) => {
  const basic = needs(context, 'dsh-compaction-basic')
  if (basic === undefined) return
  const pruner = needs(context, 'dsh-compaction-tool-result-pruner')
  if (pruner === undefined) return

  states(basic, 'ctx.get("toolResultPruner")', 'dsh-compaction-basic')
  assert.match(
    basic,
    /prune\.pruneSession\(agent\.session\);\s*measurement = meter\.measure\(agent\.session\)/,
    'dsh-compaction-basic no longer re-measures after pruning — the reading says it may skip summarizing',
  )
  states(pruner, 'session.append("compaction/prune"', 'dsh-compaction-tool-result-pruner')
  assert.match(
    pruner,
    /surfaceOp:\s*\{\s*op:\s*"replace",\s*startSeq:\s*seq,\s*endSeq:\s*seq/,
    'the pruner no longer replaces the pruned node — the reading says each prune mutates the surface',
  )
  states(pruner, 'thresholdChars: 8192', 'dsh-compaction-tool-result-pruner')
  states(pruner, 'headChars: 4096', 'dsh-compaction-tool-result-pruner')
  states(pruner, 'tailChars: 1024', 'dsh-compaction-tool-result-pruner')
  states(pruner, 'if (emittedChars > resolved.thresholdChars) throw', 'dsh-compaction-tool-result-pruner')
  states(pruner, 'for (const seq of [...session.surface.nodes])', 'dsh-compaction-tool-result-pruner')
  statesNothing(pruner, '.sort(', 'dsh-compaction-tool-result-pruner')
})

test('retention, the balanced cut, and the node-0 rule', async (context) => {
  const basic = needs(context, 'dsh-compaction-basic')
  if (basic === undefined) return

  states(basic, 'const DEFAULT_THRESHOLD_RATIO = .8;', 'dsh-compaction-basic')
  states(basic, 'const DEFAULT_RETAIN_RATIO = .16;', 'dsh-compaction-basic')
  states(basic, 'systemHead(session, surfaceNodes[0]) === void 0 ? 0 : 1', 'dsh-compaction-basic')
  states(basic, 'toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])', 'dsh-compaction-basic')
  states(basic, 'selectCompactableRange(agent.session, measurement, 0)', 'dsh-compaction-basic')
  states(basic, 'config.maxTokens ?? headroomTokens', 'dsh-compaction-basic')
  states(basic, 'config.headroomTokens ?? 65536', 'dsh-compaction-basic')
  statesNothing(basic, '8192', 'dsh-compaction-basic')
})

test('the token meter keeps the reading\u2019s constants, axes and three baselines', async (context) => {
  const meter = needs(context, 'dsh-token-meter')
  if (meter === undefined) return
  const estimate = needs(context, 'dsh-token-meter', 'lib/types/estimate.js')
  if (estimate === undefined) return

  states(estimate, 'const CHARS_PER_TOKEN = 4;', 'dsh-token-meter/estimate')
  states(estimate, 'const BLOCK_OVERHEAD = 4;', 'dsh-token-meter/estimate')
  states(estimate, 'export const ROLE_OVERHEAD = 4;', 'dsh-token-meter/estimate')
  states(estimate, 'Math.ceil(block.name.length / CHARS_PER_TOKEN)', 'dsh-token-meter/estimate')
  states(estimate, 'Math.ceil(block.arguments.length / CHARS_PER_TOKEN)', 'dsh-token-meter/estimate')
  states(estimate, 'export function estimateToolsTokens(header)', 'dsh-token-meter/estimate')
  statesNothing(estimate, 'tool-result', 'dsh-token-meter/estimate')

  states(meter, 'kind: "usage"', 'dsh-token-meter')
  states(meter, 'kind: "estimated"', 'dsh-token-meter')
  states(meter, 'kind: "none"', 'dsh-token-meter')
  states(meter, 'usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens', 'dsh-token-meter')
  states(meter, 'totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens)', 'dsh-token-meter')
})

test('the loop has two pre-request waterfalls, and the reading names both', async (context) => {
  const loop = needs(context, 'dsh-agent-loop')
  if (loop === undefined) return

  states(loop, 'waterfall("agent/request"', 'dsh-agent-loop')
  states(loop, 'waterfall("agent/request-error"', 'dsh-agent-loop')
})

test('the system prompt\u2019s order table', async (context) => {
  const prompt = needs(context, 'dsh-system-prompt')
  if (prompt === undefined) return

  states(prompt, 'HARNESS_IDENTITY: -1e3', 'dsh-system-prompt')
  states(prompt, 'DEPLOYMENT_PERSONA_PREFIX: 0', 'dsh-system-prompt')
  states(prompt, 'HARNESS_SOURCE: 1e4', 'dsh-system-prompt')
  states(prompt, 'WEB_SURFACE: 10100', 'dsh-system-prompt')
  states(prompt, 'DEPLOYMENT_PERSONA_SUFFIX: 10200', 'dsh-system-prompt')
  states(prompt, 'You are an AI agent powered by DeepSeek Harness.', 'dsh-system-prompt')
})

test('instruction files — scope, candidates, budget, framing and the root direction', async (context) => {
  const instructions = needs(context, 'dsh-agent-instructions')
  if (instructions === undefined) return

  states(instructions, 'const DEFAULT_INSTRUCTION_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md"];', 'dsh-agent-instructions')
  states(instructions, 'const DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES = ["AGENTS.local.md", "CLAUDE.local.md"];', 'dsh-agent-instructions')
  states(instructions, 'maxBytes: z.number().required()', 'dsh-agent-instructions')
  states(instructions, 'const USER_GLOBAL_FILE = "AGENTS.md";', 'dsh-agent-instructions')
  states(instructions, 'createHash("sha1").update(content).digest("hex")', 'dsh-agent-instructions')
  states(instructions, 'instructionContentSha1(content.trim())', 'dsh-agent-instructions')
  states(instructions, 'Workspace instruction budget', 'dsh-agent-instructions')
  states(instructions, 'existsAsMarker(join(current, marker)', 'dsh-agent-instructions')
})

test('the standard preset lives where the reading says, and configures what it says', async (context) => {
  if (!skipUnless(context, packageRoot !== undefined, CAPABILITY)) return
  const path = join(packageRoot, 'dsh-web-app/presets/standard.patch.yml')
  if (!skipUnless(context, existsSync(path), 'dsh-web-app/presets/standard.patch.yml')) return
  const preset = readFileSync(path, 'utf8')

  states(preset, "name: '@deepseek-ai/dsh-agent-instructions'", 'the standard preset')
  states(preset, 'maxBytes: 65536', 'the standard preset')
  states(preset, 'thresholdChars: 8192', 'the standard preset')
  assert.match(
    preset,
    /- id: compaction-basic\n\s+name: '@deepseek-ai\/dsh-compaction-basic'\n/,
    'the standard preset now configures compaction-basic — the reading says it mounts it with no config',
  )
  assert.ok(
    !existsSync(join(packageRoot, 'dsh-agent-presets')),
    'dsh-agent-presets now exists — the reading says the preset path v1.0.0 cited is not in this install',
  )
})

test('the spill policy keys on tokens, as the reading says', async (context) => {
  const spill = needs(context, 'dsh-spill-policy')
  if (spill === undefined) return

  states(spill, 'maxInlineTokens', 'dsh-spill-policy')
  statesNothing(spill, 'maxInlineBytes', 'dsh-spill-policy')
})

test('the reading itself states the facts this check guards', async (context) => {
  if (!skipUnless(context, packageRoot !== undefined, CAPABILITY)) return
  const reading = readFileSync(new URL('./dsh-context.md', import.meta.url), 'utf8')

  for (const fact of [
    'developer/message',
    'compact-checkpoint',
    'contentGeneration',
    'maxInlineTokens',
    'headroomTokens',
    'agent/request',
    'dsh-web-app/presets/standard.patch.yml',
    'is present',
  ]) {
    assert.ok(
      reading.includes(fact),
      `dsh-context.md does not state ${JSON.stringify(fact)} — every correction must be written into the reading, not only into this check`,
    )
  }
})
