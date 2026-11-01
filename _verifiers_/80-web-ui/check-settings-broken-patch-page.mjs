import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * #165: a hand edit that breaks the profile patch keeps the Settings dialog's Configuration forms, drawn from the
 * running configuration as DSH's are, and the note says why Save is refused in the server's words (the file, line and
 * reason), not "the server answered 422". No line of the file reaches the page.
 */
const CAPABILITY = 'web'

function scratchProfile(home) {
  const profile = join(home, 'settings-broken-page-profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`)
  writeFileSync(join(profile, 'heddle.patch.yml'), tree)
  return profile
}

async function startServer(home, profile, config) {
  const child = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--profile', profile]), {
    cwd: home,
    env: { ...process.env, HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  const url = await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const match = /heddle web: (http:\/\/\S+)/.exec(out)
      if (match) {
        clearInterval(timer)
        resolve(match[1])
      }
    }, 50)
    setTimeout(() => {
      clearInterval(timer)
      reject(new Error(`server did not start\n${out}`))
    }, 20_000)
  })
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]
  const api = async (path, init = {}) => {
    const response = await fetch(new URL(path, url), { ...init, headers: { cookie, 'content-type': 'application/json' } })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }
  return { url, api, close: () => child.kill('SIGKILL') }
}

const SECRET = 'sk-live-ABCDEF0123456789'

test('a broken profile patch keeps the Configuration forms and the note says why Save is refused', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'browser')) return
  const home = isolatedHome('settings-broken-page')
  const { config } = scriptedConfig({ home, steps: [{ text: 'ok' }] })
  const profile = scratchProfile(home)
  const patchFile = join(profile, 'heddle.patch.yml')
  const server = await startServer(home, profile, config)
  const browser = await openBrowser()
  try {
    const first = await server.api('/api/settings/tools', { method: 'POST', body: JSON.stringify({ update: { bashTimeoutMs: 45000 } }) })
    assert.equal(first.status, 200, 'a first write makes the block')
    writeFileSync(patchFile, `${readFileSync(patchFile, 'utf8')}proxyKey: ${SECRET}\nbroken: [unclosed\n`)
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("settings-open") !== null', 20_000)
    await browser.evaluate('document.getElementById("settings-open").click()')
    assert.ok(
      await browser.waitFor('document.querySelector(\'#settings-config details[data-ns="tools"]\') !== null', 15_000).catch(() => false),
      `the forms are drawn (${await browser.evaluate('document.getElementById("settings-config-note").textContent')})`,
    )
    const note = await browser.evaluate('document.getElementById("settings-config-note").textContent')
    assert.match(note, /is not valid YAML/, 'the note gives the server\'s reason')
    assert.match(note, /line \d+/, 'and the line')
    assert.doesNotMatch(note, /server answered/, 'not only a status code')
    assert.ok(!(await browser.evaluate('document.getElementById("settings-dialog").textContent')).includes(SECRET), 'and no line of the file')
    await browser.evaluate('document.querySelector(\'#settings-config details[data-ns="tools"]\').open = true')
    assert.equal(await browser.evaluate('document.getElementById("setting-tools-bashTimeoutMs").value'), '45000', 'the running value')
  } finally {
    browser.close()
    server.close()
    removeDir(home)
  }
})
