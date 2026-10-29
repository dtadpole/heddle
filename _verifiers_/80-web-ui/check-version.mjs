import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * heddle reports its release where DSH does (DSH parity S72, S74).
 *
 * DSH prints its release for `dsh -V` / `--version` and exits 0, and ends General Settings with "Current version:
 * {version}". Measured on both builds before the fix: `--version` and `-V` exited 1 with "unknown argument", `/healthz`
 * answered `{ok, service, port}` only, and the Settings dialog showed no version. The check asks the build under test
 * (the TypeScript build, or the binary through `HEDDLE_BIN`) for its version, then requires the same release from a
 * running `heddle web` in `/healthz` and at the bottom of the Settings dialog.
 */

const CAPABILITY = 'the Web UI'

function startServer(home, work, config) {
  const child = spawn(
    ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]),
    { cwd: work, env: { ...process.env, HEDDLE_HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const url = new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = setInterval(() => {
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match) {
        clearInterval(poll)
        resolve(match[1])
      } else if (child.exitCode !== null || Date.now() - started > 20_000) {
        clearInterval(poll)
        reject(new Error(`the server did not start\n${output}`))
      }
    }, 50)
  })
  url.catch(() => {})
  return {
    url,
    logs: () => output,
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill()
      await new Promise((resolve) => child.once('exit', resolve))
    },
  }
}

test('--version, /healthz and the Settings dialog report the same release', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return

  // The command line: DSH's `-V, --version` prints the release alone and exits 0.
  const long = await runCli(['--version'])
  const short = await runCli(['-V'])
  assert.equal(long.code, 0, `--version exits 0; it said ${JSON.stringify(long.stdout + long.stderr)}`)
  assert.equal(short.code, 0, `-V exits 0; it said ${JSON.stringify(short.stdout + short.stderr)}`)
  const version = long.stdout.trim()
  assert.match(version, /^\d+\.\d+\.\d+\S*$/, `the output is the release alone: ${JSON.stringify(long.stdout)}`)
  assert.equal(short.stdout, long.stdout, '-V says the same')

  const home = isolatedHome('version')
  const work = fixtureDir('version-work')
  const { config } = scriptedConfig({ home, steps: [{ text: 'idle' }] })
  const server = startServer(home, work, config)
  const browser = await openBrowser()
  try {
    const url = await server.url
    const health = await (await fetch(new URL('/healthz', url))).json()
    assert.equal(health.version, version, `/healthz names the release; it answered ${JSON.stringify(health)}`)

    await browser.goto(url)
    const row = JSON.parse(
      await browser.evaluate(`(async () => {
        document.getElementById('settings-open').click()
        const started = Date.now()
        let row = document.getElementById('settings-version')
        while ((row === null || row.hidden || row.textContent === '') && Date.now() - started < 5000) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          row = document.getElementById('settings-version')
        }
        const dialog = document.getElementById('settings-dialog')
        const body = document.getElementById('settings-body')
        return JSON.stringify({
          open: dialog?.open === true,
          text: row === null || row.hidden ? null : row.textContent,
          last: row !== null && body !== null && body.lastElementChild === row,
        })
      })()`, 15_000),
    )
    assert.equal(row.open, true, 'the Settings dialog opened')
    assert.equal(row.text, `Current version: ${version}`, `Settings shows DSH's "Current version" row; it showed ${JSON.stringify(row)}`)
    assert.equal(row.last, true, 'as the dialog\'s last row, where DSH puts it')
  } finally {
    await browser.close()
    await server.close()
    removeDir(home)
    removeDir(work)
  }
})
