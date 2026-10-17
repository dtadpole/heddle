import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, readTranscript, removeDir, repoRoot, runCli, sessionsUnder, skipUnless, tempDir } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier 8 — the permission sandbox.
 *
 * Judges one part of `ULTIMATE_GOAL.md`: a sandbox distinguishes **read-only, workspace-write and
 * full access**, the way DSH does it — and it is judged by **refusal rather than by declaration**.
 * A mode that has never refused anything is a mode nobody has tested.
 *
 * The three modes are exercised with the same action, so the difference between them is the
 * result rather than the fixture: a write inside the workspace, a write outside it, and a read
 * outside it. DSH's words are used (`read-only`, `workspace-write`, `danger-full-access`) because a
 * reader who knows one harness should not have to learn a second vocabulary for the same idea.
 */

const CAPABILITY = 'a permission sandbox whose three modes differ'

/** A profile whose sandbox row carries the mode and root the check wants. */
function sandboxProfile(home, options) {
  const dir = fixtureDir('sandbox-profile')
  // Plugin paths are relative to the profile directory, which is under `.heddle-tmp/` rather than
  // at the repository root. Measured: passing `undefined` here wrote `undefined/src/...`, the
  // loader logged a failed import, and the tree booted with no services — a run that "worked" and
  // created no session.
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
        workspaceRoot: ${options.workspaceRoot}
        tempRoot: ${options.tempRoot === true ? 'true' : 'false'}
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
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(join(dir, 'script.json'), `${JSON.stringify({ steps: options.steps })}\n`)
  writeFileSync(
    join(home, 'heddle.json'),
    `${JSON.stringify({ default: 'scripted', endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: join(dir, 'script.json'), model: 'scripted' }] }, null, 2)}\n`,
  )
  return dir
}

function harness(label, options) {
  const home = fixtureDir(`sandbox-home-${label}`)
  const workspace = fixtureDir(`sandbox-workspace-${label}`)
  /**
   * An absolute path outside the workspace, which is what a refusal is about. It is created before
   * the profile because the script that names it has to exist when the profile is written.
   */
  const outsidePath = join(tempDir(`sandbox-outside-${label}-`), 'outside.txt')
  const steps = options.steps ?? [
    { toolCall: { name: 'write_file', arguments: { path: 'inside.txt', content: 'inside' } } },
    { toolCall: { name: 'write_file', arguments: { path: outsidePath, content: 'outside' } } },
    { toolCall: { name: 'read_file', arguments: { path: outsidePath } } },
    { text: 'done' },
  ]
  const profileDir = sandboxProfile(home, { ...options, steps, workspaceRoot: workspace })
  return {
    home,
    workspace,
    outsidePath,
    profileDir,
    env: { HEDDLE_HOME: home, HEDDLE_CONFIG: join(home, 'heddle.json') },
    /** The headless run's arguments, with the profile filled in by the caller. */
    baseArgs: (profile) => ['--profile', profile, '--endpoint', 'scripted'],
  }
}

async function supportsSandbox() {
  const help = await runCli(['--help'])
  return /--profile/.test(help.stdout)
}

function resultsOf(home) {
  const session = sessionsUnder(join(home, 'sessions'))[0]
  const events = readTranscript(join(home, 'sessions', session))
  return events
    .filter((event) => event.type === 'message' && event.message?.role === 'tool')
    .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
}

test('workspace-write permits a write inside and refuses one outside', async (context) => {
  if (!skipUnless(context, await supportsSandbox(), CAPABILITY)) return
  const h = harness('workspace-write', {
    mode: 'workspace-write',
  })
  try {
    const run = await runCli([...h.baseArgs(h.profileDir), '--turn', 'write two files'], { env: h.env, timeoutMs: 60_000 })
    const results = resultsOf(h.home)
    assert.ok(existsSync(join(h.workspace, 'inside.txt')), `the write inside the workspace landed\n${run.stdout}`)
    assert.ok(
      results.some((text) => /outside the sandbox root/i.test(text)),
      `the write outside was refused, and the refusal names the boundary\nsaw: ${results.join(' | ').slice(0, 300)}`,
    )
    assert.equal(existsSync(h.outsidePath), false, 'the refused write left no file outside')
  } finally {
    removeDir(h.home)
    removeDir(h.workspace)
    // The parent of the outside file, which is a temp directory of its own.
    removeDir(dirname(h.outsidePath))
  }
})

test('read-only refuses the same inside write that workspace-write allowed', async (context) => {
  if (!skipUnless(context, await supportsSandbox(), CAPABILITY)) return
  const h = harness('read-only', {
    mode: 'read-only',
  })
  try {
    const run = await runCli([...h.baseArgs(h.profileDir), '--turn', 'write two files'], { env: h.env, timeoutMs: 60_000 })
    const results = resultsOf(h.home)
    assert.equal(existsSync(join(h.workspace, 'inside.txt')), false, `nothing was written in read-only mode\n${run.stdout}`)
    assert.ok(
      results.some((text) => /read-only/i.test(text)),
      `the refusal says the mode is read-only\nsaw: ${results.join(' | ').slice(0, 300)}`,
    )
  } finally {
    removeDir(h.home)
    removeDir(h.workspace)
    // The parent of the outside file, which is a temp directory of its own.
    removeDir(dirname(h.outsidePath))
  }
})

test('danger-full-access permits the write the other two refused', async (context) => {
  if (!skipUnless(context, await supportsSandbox(), CAPABILITY)) return
  const h = harness('full-access', {
    mode: 'danger-full-access',
  })
  try {
    const run = await runCli([...h.baseArgs(h.profileDir), '--turn', 'write two files'], { env: h.env, timeoutMs: 60_000 })
    const results = resultsOf(h.home)
    assert.ok(existsSync(h.outsidePath), `the outside write landed under full access\n${run.stdout}`)
    assert.ok(
      !results.some((text) => /sandbox root/i.test(text)),
      `and nothing refused it\nsaw: ${results.join(' | ').slice(0, 300)}`,
    )
  } finally {
    removeDir(h.home)
    removeDir(h.workspace)
    // The parent of the outside file, which is a temp directory of its own.
    removeDir(dirname(h.outsidePath))
  }
})

test('a sibling directory with the workspace as a name prefix is outside it', async (context) => {
  if (!skipUnless(context, await supportsSandbox(), CAPABILITY)) return
  /**
   * The path comparison is by segment, not by string prefix. A workspace at `<tmp>/ws` and a
   * sibling at `<tmp>/ws-extra` are different directories, and a prefix test calls them the same.
   * Measured: this is the difference between a sandbox and a suggestion.
   */
  /**
   * The sibling path is built **before** the harness, because the script that names it has to exist
   * when the profile is written. Measured: computing it from the harness inside the steps closure
   * referred to `h` before it was initialised.
   */
  const workspacePath = fixtureDir('sandbox-prefix-workspace')
  const siblingPath = `${workspacePath}-extra`
  const h = harness('prefix', {
    mode: 'workspace-write',
    workspace: workspacePath,
    steps: [{ toolCall: { name: 'write_file', arguments: { path: `${siblingPath}/loot.txt`, content: 'no' } } }, { text: 'done' }],
  })
  try {
    const run = await runCli([...h.baseArgs(h.profileDir), '--turn', 'write beside the workspace'], { env: h.env, timeoutMs: 60_000 })
    const results = resultsOf(h.home)
    assert.ok(
      results.some((text) => /outside the sandbox root/i.test(text)),
      `a sibling whose name starts with the workspace's was refused\nsaw: ${results.join(' | ').slice(0, 300)}`,
    )
    assert.equal(existsSync(join(siblingPath, 'loot.txt')), false, 'and nothing was written there')
  } finally {
    removeDir(h.home)
    removeDir(h.workspace)
    // The parent of the outside file, which is a temp directory of its own.
    removeDir(dirname(h.outsidePath))
  }
})

test('the host temp directory is not writable unless the policy admits it', async (context) => {
  if (!skipUnless(context, await supportsSandbox(), CAPABILITY)) return
  /**
   * A confined mode that quietly permits the whole temp directory is not confining anything: on this
   * machine that is every path under `/var/folders/...`, shared by every process the user runs.
   *
   * Measured, and this is why the policy changed: `workspace-write` allowed a write there because the
   * temp root was always in the allow list. It is now opt-in, and this check holds both halves — the
   * same write is refused by default and allowed when the policy asks for it — so "off by default"
   * cannot quietly decay into "on".
   */
  const scratch = join(tempDir('sandbox-scratch-'), 'scratch.txt')
  const writeSteps = [{ toolCall: { name: 'write_file', arguments: { path: scratch, content: 'scratch' } } }, { text: 'done' }]

  const refused = harness('temp-off', { mode: 'workspace-write', steps: writeSteps })
  try {
    await runCli([...refused.baseArgs(refused.profileDir), '--turn', 'write to the temp directory'], { env: refused.env, timeoutMs: 60_000 })
    const results = resultsOf(refused.home)
    assert.equal(existsSync(scratch), false, 'the default policy does not admit the temp directory')
    assert.ok(
      results.some((text) => /outside the sandbox root/i.test(text)),
      `and says so\nsaw: ${results.join(' | ').slice(0, 300)}`,
    )
  } finally {
    removeDir(refused.home)
    removeDir(refused.workspace)
    removeDir(dirname(refused.outsidePath))
  }

  const admitted = harness('temp-on', { mode: 'workspace-write', tempRoot: true, steps: writeSteps })
  try {
    const run = await runCli([...admitted.baseArgs(admitted.profileDir), '--turn', 'write to the temp directory'], { env: admitted.env, timeoutMs: 60_000 })
    assert.ok(existsSync(scratch), `an admitted temp root permits the same write\n${run.stdout}${run.stderr}`)
  } finally {
    removeDir(admitted.home)
    removeDir(admitted.workspace)
    removeDir(dirname(admitted.outsidePath))
    removeDir(dirname(scratch))
  }
})
