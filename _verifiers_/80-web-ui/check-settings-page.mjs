import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The Settings dialog edits configuration the way DSH's settings page does.
 *
 * The claim: a profile entry's field is changed in the page and saved into the active profile's own patch (the rest
 * of the file kept byte for byte); a field the profile overrides can be reset from the page, which restores the file;
 * and a form read before someone else changed the entry is refused rather than overwriting that change, with a
 * sentence the person can act on. The server is booted from a scratch profile so every write lands there.
 */

const CAPABILITY = 'web'

function scratchProfile(home) {
  const profile = join(home, 'settings-page-profile')
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

/** Open Settings and the tools entry, and resolve once its form is drawn. */
async function openToolsForm(browser) {
  await browser.evaluate('document.getElementById("settings-open").click()')
  await browser.waitFor('document.querySelector(\'#settings-config details[data-ns="tools"]\') !== null', 15_000)
  await browser.evaluate('document.querySelector(\'#settings-config details[data-ns="tools"]\').open = true')
  await browser.waitFor('document.getElementById("setting-tools-bashTimeoutMs") !== null', 10_000)
}

const setField = (browser, value) =>
  browser.evaluate(`(() => {
    const input = document.getElementById('setting-tools-bashTimeoutMs')
    input.value = ${JSON.stringify(String(value))}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  })()`)

const statusText = 'document.querySelector(\'#settings-config details[data-ns="tools"] .settings-status\')?.textContent ?? ""'

test('the Settings dialog saves, resets and refuses a stale form as DSH settings do', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'browser')) return
  const home = isolatedHome('settings-page')
  const { config } = scriptedConfig({ home, steps: [{ text: 'ok' }] })
  const profile = scratchProfile(home)
  const patchFile = join(profile, 'heddle.patch.yml')
  const original = readFileSync(patchFile, 'utf8')
  const server = await startServer(home, profile, config)
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("settings-open") !== null', 20_000)

    // 1. A declared field the profile does not set yet is offered, changed in the page and saved.
    await openToolsForm(browser)
    const before = JSON.parse(await browser.evaluate(`JSON.stringify((() => {
      const form = document.querySelector('#settings-config details[data-ns="tools"] form')
      return { editable: !document.getElementById('setting-tools-bashTimeoutMs').disabled, note: document.getElementById('settings-config-note').textContent, labels: [...form.querySelectorAll('label')].map((label) => label.textContent) }
    })())`))
    assert.equal(before.editable, true, 'the profile\'s own entry is editable')
    assert.match(before.note, /written to this profile/, 'the dialog says where a change goes')
    assert.ok(before.labels.includes('bashTimeoutMs'), `the schema's fields are offered: ${before.labels.join(', ')}`)
    await setField(browser, 47000)
    await browser.evaluate('document.querySelector(\'#settings-config details[data-ns="tools"] button[type="submit"]\').click()')
    await browser.waitFor(`(${statusText}).startsWith("Saved")`, 15_000)
    const saved = readFileSync(patchFile, 'utf8')
    assert.ok(saved.startsWith(original), 'the profile\'s own text is kept byte for byte')
    assert.match(saved.slice(original.length), /"bashTimeoutMs": 47000/, 'the value is written to the profile patch')
    assert.equal((await server.api('/api/settings/tools')).body.value.bashTimeoutMs, 47000, 'and the server reads it back')

    // 2. Reset restores the value beneath the profile, which here restores the file.
    await browser.waitFor('(() => { const row = document.getElementById("setting-tools-bashTimeoutMs"); return row !== null && row.nextElementSibling?.hidden === false })()', 10_000)
    await browser.evaluate('document.getElementById("setting-tools-bashTimeoutMs").nextElementSibling.click()')
    await browser.waitFor(`(${statusText}).startsWith("Saved")`, 15_000)
    assert.equal(readFileSync(patchFile, 'utf8'), original, 'resetting the only change leaves the file as it was')

    // 3. A form read before another writer changed the entry is refused, and the page says what to do.
    await browser.evaluate('document.getElementById("settings-dialog").close()')
    await openToolsForm(browser)
    const read = (await server.api('/api/settings/tools')).body.revision
    const elsewhere = await server.api('/api/settings/tools', { method: 'POST', body: JSON.stringify({ update: { bashTimeoutMs: 1000 }, expectedRevision: read }) })
    assert.equal(elsewhere.status, 200, 'another writer changes the entry')
    await setField(browser, 2000)
    await browser.evaluate('document.querySelector(\'#settings-config details[data-ns="tools"] button[type="submit"]\').click()')
    await browser.waitFor(`(${statusText}).includes("changed since Settings opened")`, 15_000)
    assert.equal(
      await browser.evaluate('document.querySelector(\'#settings-config details[data-ns="tools"] .settings-status\').dataset.kind'),
      'error',
      'shown as a refusal',
    )
    assert.match(readFileSync(patchFile, 'utf8'), /"bashTimeoutMs": 1000/, 'the other writer\'s value stands')
  } finally {
    await browser.close()
    server.close()
    removeDir(home)
  }
})
