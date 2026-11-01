import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

import { settle } from '../src/boot.ts'

/**
 * `settle` is the boot barrier: a command or a turn runs only after every row has finished loading.
 *
 * The bug it was fixed for: the filter waited for `pending` (0) only, so a row whose `apply` was still
 * running (`loading`, 1) did not count — the turn started, and the profile's own tool was refused as an
 * unknown tool. These tests pin both unsettled states and the healthy case.
 */

function fakeCtx(states: number[]): { loader: { entries: () => { fiber: { state: number }; options: { id: string } }[] } } {
  return {
    loader: {
      entries: () => states.map((state, index) => ({ fiber: { state }, options: { id: `row-${index}` } })),
    },
  }
}

test('settle waits while a row is loading, not only while it is pending', async () => {
  const states = [2, 1, 0]
  const settled = settle(fakeCtx(states) as never, 200)
  // The fake never changes; the point is which rows are reported, and that it did not return empty.
  const pending = await settled
  assert.deepEqual([...pending], ['row-1', 'row-2'], 'a loading row is unsettled, exactly like a pending one')
})

test('settle returns an empty list once every row is active, failed or disposed', async () => {
  assert.deepEqual(await settle(fakeCtx([2, 3, 4, 5]) as never, 200), [])
})

test('settle gives up at its deadline and reports what is still unsettled', async () => {
  const started = Date.now()
  const pending = await settle(fakeCtx([1]) as never, 60)
  assert.deepEqual([...pending], ['row-0'])
  assert.ok(Date.now() - started >= 50, 'it waited for the deadline rather than returning at once')
})

test('the daemon plist names the profile, so a wrong working directory cannot hide it', () => {
  /**
   * **A served page is not evidence that the profile loaded.** Measured three times in one session: a `heddle web`
   * process started from another directory booted no base layer and no project patch, so the workspace plugin was
   * absent and the panel said so — while the source, the build and the checks were all correct. The agent now names
   * `--config <checkout>/cordis.yml`, which keeps the profile a property of the installation rather than of the shell
   * that happened to start it.
   *
   * Since live-deploy's 8d13568d (the supervisor that keeps the server up where launchd does not), the template
   * carries `@PROGRAM_ARGUMENTS@` and `install.sh` writes the argument list into it, so the claim is judged on what
   * `install.sh --print` renders for this checkout rather than on the template's text. The binary stands in for the
   * build, so no `dist/` is needed, and the render changes nothing on the machine.
   */
  const repo = join(import.meta.dirname, '..')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HEDDLE_')))
  const render = spawnSync('sh', [join(repo, '_tools_', 'web-daemon', 'install.sh'), '--print'], {
    encoding: 'utf8',
    env: { ...env, HEDDLE_WEB_PLATFORM: 'darwin', HEDDLE_ALLOW_DIRTY_INSTALL: '1', HEDDLE_BIN: process.execPath, HEDDLE_NODE: process.execPath },
  })
  assert.equal(render.status, 0, `install.sh --print renders the plist: ${render.stderr}`)
  const programArguments = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(render.stdout)?.[1] ?? ''
  const args = [...programArguments.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1])
  const config = args.indexOf('--config')
  assert.ok(config >= 0, `the profile is passed explicitly: ${JSON.stringify(args)}`)
  assert.equal(args[config + 1], `${repo}/cordis.yml`, 'and it is the cordis.yml beside this checkout')
  assert.equal(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(render.stdout)?.[1], repo, 'and the checkout is still the working directory')
})
