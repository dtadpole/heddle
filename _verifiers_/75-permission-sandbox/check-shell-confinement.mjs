import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, readTranscript, removeDir, repoRoot, runCli, sessionsUnder, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier 8, the shell-confinement half — the mode must govern `bash`, not only the file tools.
 *
 * The three-mode checks in `check.mjs` judge the harness's own file tools. This file judges the other consumer
 * DSH confines: a **shell**. The same command is made to write inside and outside the workspace under each
 * mode, and the mode is judged by the kernel's answer:
 *
 * - `workspace-write` permits the inside write and refuses the outside one — including from a **descendant**
 *   shell — and the refusal is reported as a denial, not as an ordinary command failure;
 * - `read-only` keeps a shell and lets it run, but every write is denied and `/dev/null` remains the one sink
 *   a shell expects;
 * - `danger-full-access` is the only bypass;
 * - with no backend usable, a confined shell call **fails closed**: the harness refuses to run it rather than
 *   running it unconfined, and nothing the command would have done happened;
 * - a command that merely *prints* the backend's denial sentence is not misclassified as denied.
 *
 * No browser: a scripted endpoint, the built CLI and the real platform runner are enough. The macOS rung is
 * the one this machine can judge; on another platform the kernel checks report why they were not judged, and
 * the fail-closed check still holds because it forces the absence of a backend.
 */

const CAPABILITY = 'a shell confined by the session’s sandbox mode'
const DARWIN = process.platform === 'darwin'

/** A profile whose sandbox row carries the deployment mode, root and backend choice. */
function profile(home, options) {
  const dir = fixtureDir('shell-profile')
  const prefix = relative(dir, repoRoot).split('\\').join('/')
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
        mode: ${options.mode}
        workspaceRoot: ${options.workspace}
        backend: ${options.backend ?? 'auto'}
    - id: approvals
      name: ${prefix}/src/approvals/service.ts
      config:
        mode: allow
    - id: tools
      name: ${prefix}/src/plugins/tools.ts
      inject: [approvals, sandbox]
      config:
        allow: [write_file, read_file, list_dir, bash]
`,
  )
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(join(dir, 'script.json'), `${JSON.stringify({ steps: options.steps })}\n`)
  writeFileSync(
    join(home, 'heddle.json'),
    `${JSON.stringify({ default: 'scripted', endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: join(dir, 'script.json'), model: 'scripted' }] }, null, 2)}\n`,
  )
  return dir
}

/** One fixture: isolated home, workspace, outside path, profile. */
function harness(label, options) {
  const home = fixtureDir(`shell-home-${label}`)
  const work = fixtureDir(`shell-workspace-${label}`)
  /**
   * The outside path must be outside the policy's writable roots; the host temp areas are now part of
   * `workspace-write` (DSH's set), so a fixture folder under the checkout is the outside this check uses.
   */
  const outsideDir = fixtureDir(`shell-outside-${label}`)
  const outsidePath = join(outsideDir, 'outside.txt')
  const childPath = join(outsideDir, 'child.txt')
  const steps = typeof options.steps === 'function' ? options.steps({ outsidePath, childPath }) : options.steps
  const profileDir = profile(home, { ...options, steps, workspace: work })
  return { home, work, outsideDir, outsidePath, childPath, profileDir, env: { HEDDLE_HOME: home, HEDDLE_CONFIG: join(home, 'heddle.json') } }
}

/** Run one scripted turn and answer with the text of each tool result. */
async function turn(h, prompt = 'run the commands') {
  const run = await runCli([`--profile`, h.profileDir, '--endpoint', 'scripted', '--turn', prompt], { env: h.env, timeoutMs: 60_000 })
  /**
   * A turn that contains a denial exits non-zero by design, so the exit code is not this helper's claim; the
   * session's tool results are. The boot output is kept in the failure message through the assertions below.
   */
  const session = sessionsUnder(join(h.home, 'sessions'))[0]
  assert.ok(session !== undefined, 'the turn created a session')
  const events = readTranscript(join(h.home, 'sessions', session))
  return events
    .filter((event) => event.type === 'message' && event.message?.role === 'tool')
    .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
}

async function withHarness(label, options, body) {
  const h = harness(label, options)
  try {
    await body(h)
  } finally {
    removeDir(h.home)
    removeDir(h.work)
    removeDir(h.outsideDir)
  }
}

test('workspace-write confines the shell to the workspace, including its descendants', { skip: DARWIN ? false : 'the macOS Seatbelt rung is the one this machine can judge' }, async (context) => {
  if (!skipUnless(context, (await runCli(['--help'])).stdout.includes('--profile'), CAPABILITY)) return
  await withHarness(
    'workspace-write',
    {
      mode: 'workspace-write',
      steps: ({ outsidePath, childPath }) => [
        { toolCall: { name: 'bash', arguments: { command: `echo inside > inside.txt` } } },
        { toolCall: { name: 'bash', arguments: { command: `echo outside > ${JSON.stringify(outsidePath)}` } } },
        { toolCall: { name: 'bash', arguments: { command: `sh -c 'echo child > ${childPath}'` } } },
        { toolCall: { name: 'bash', arguments: { command: 'echo ok > /dev/null && echo devnull-ok' } } },
        { toolCall: { name: 'bash', arguments: { command: 'echo "Operation not permitted"' } } },
        { text: 'done' },
      ],
    },
    async (h) => {
      const results = await turn(h)
      assert.equal(existsSync(join(h.work, 'inside.txt')), true, `the inside write landed\nsaw: ${results.join(' | ').slice(0, 400)}`)
      assert.ok(
        results.some((text) => /file access denied under workspace-write mode/.test(text)),
        `the outside write was denied and the denial is reported\nsaw: ${results.join(' | ').slice(0, 500)}`,
      )
      assert.equal(existsSync(h.outsidePath), false, 'the outside write left no file')
      assert.equal(existsSync(h.childPath), false, 'a descendant shell is confined with its parent')
      assert.ok(results.some((text) => /devnull-ok/.test(text)), '/dev/null stays writable, so a shell still works')
      const signaturePrint = results.find((text) => text.includes('Operation not permitted'))
      assert.ok(signaturePrint !== undefined, 'the false-positive command ran')
      assert.ok(
        !/file access denied/.test(signaturePrint),
        `a command that merely prints the denial sentence is not reported as denied (${signaturePrint})`,
      )
    },
  )
})

test('read-only keeps a shell but denies every write', { skip: DARWIN ? false : 'the macOS Seatbelt rung is the one this machine can judge' }, async (context) => {
  if (!skipUnless(context, (await runCli(['--help'])).stdout.includes('--profile'), CAPABILITY)) return
  await withHarness(
    'read-only',
    {
      mode: 'read-only',
      steps: [
        { toolCall: { name: 'bash', arguments: { command: 'echo the-shell-ran' } } },
        { toolCall: { name: 'bash', arguments: { command: 'echo denied > inside.txt' } } },
        { text: 'done' },
      ],
    },
    async (h) => {
      const results = await turn(h)
      assert.ok(results.some((text) => /the-shell-ran/.test(text)), `the shell runs under read-only\nsaw: ${results.join(' | ').slice(0, 400)}`)
      assert.ok(
        results.some((text) => /file access denied under read-only mode/.test(text)),
        `its write is denied by the kernel\nsaw: ${results.join(' | ').slice(0, 500)}`,
      )
      assert.equal(existsSync(join(h.work, 'inside.txt')), false, 'and nothing landed')
    },
  )
})

test('danger-full-access is the only bypass', { skip: DARWIN ? false : 'the macOS Seatbelt rung is the one this machine can judge' }, async (context) => {
  if (!skipUnless(context, (await runCli(['--help'])).stdout.includes('--profile'), CAPABILITY)) return
  await withHarness(
    'full-access',
    {
      mode: 'danger-full-access',
      steps: ({ outsidePath }) => [
        { toolCall: { name: 'bash', arguments: { command: `echo outside > ${JSON.stringify(outsidePath)}` } } },
        { text: 'done' },
      ],
    },
    async (h) => {
      const results = await turn(h)
      assert.equal(existsSync(h.outsidePath), true, `full access lets the shell write outside\nsaw: ${results.join(' | ').slice(0, 400)}`)
      assert.ok(!results.some((text) => /file access denied/.test(text)), 'and nothing reports a denial')
    },
  )
})

test('a confined call fails closed when no backend is usable', async (context) => {
  if (!skipUnless(context, (await runCli(['--help'])).stdout.includes('--profile'), CAPABILITY)) return
  await withHarness(
    'fail-closed',
    {
      mode: 'workspace-write',
      backend: 'none',
      steps: [
        { toolCall: { name: 'bash', arguments: { command: 'echo ran > inside.txt; echo outside > ../../outside.txt' } } },
        { text: 'done' },
      ],
    },
    async (h) => {
      const results = await turn(h)
      assert.ok(
        results.some((text) => /SANDBOX_UNAVAILABLE|no sandbox backend/i.test(text)),
        `the call reports that no backend can enforce the mode\nsaw: ${results.join(' | ').slice(0, 500)}`,
      )
      assert.equal(existsSync(join(h.work, 'inside.txt')), false, 'the command never ran: its first write did not happen')
      assert.equal(existsSync(h.outsidePath), false, 'and its outside write did not happen either')
    },
  )
})
