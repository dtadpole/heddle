import assert from 'node:assert/strict'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The session shortcuts fire on the **physical key**, judged with the key events a browser really delivers.
 *
 * Chrome on a Mac applies Option to `KeyboardEvent.key` (Chromium `DomKeyFromNSEvent`): ⌥⌘A arrives as `å`, ⌥⌘K as
 * `˚`, ⌥⌘G as `©`, ⌥⌘B as `∫`, ⌥⌘, as `≤`, and ⌥⌘N as a dead key, while `code` stays `KeyA` and so on. DSH's
 * `dsh-client-shortcuts` matches `code` with an abstract `Mod` (Command on a Mac, Control elsewhere) and an exact
 * modifier set, so its chords work there; a page that matched `key` answered none of its Option chords on a Mac
 * (DSH parity R-developer-seven-7). The events here go through the protocol's `Input.dispatchKeyEvent`, so the page
 * receives them exactly as it would from a keyboard, `code`, `key` and modifier flags included.
 *
 * Off a Mac the same chords carry the plain letters with Control, which is what such a keyboard delivers, so the
 * check judges whichever platform the browser reports.
 */

const CAPABILITY = 'a Web UI on localhost with a live stream'

/** Modifier bits of `Input.dispatchKeyEvent`. */
const ALT = 1
const CTRL = 2
const META = 4
const SHIFT = 8

/** The chords, with the `key` Chrome delivers for each on a Mac and off one. */
const CHORDS = {
  archive: { code: 'KeyA', macKey: 'å', key: 'a', keyCode: 65, alt: true },
  rename: { code: 'KeyG', macKey: '©', key: 'g', keyCode: 71, alt: true },
  search: { code: 'KeyK', macKey: '˚', key: 'k', keyCode: 75, alt: true },
  sidebar: { code: 'KeyB', macKey: '∫', key: 'b', keyCode: 66, alt: true },
  newSession: { code: 'KeyN', macKey: 'Dead', key: 'n', keyCode: 78, alt: true },
  settings: { code: 'Comma', macKey: '≤', key: ',', keyCode: 188, alt: true },
  fork: { code: 'KeyF', macKey: 'F', key: 'F', keyCode: 70, shift: true },
}

function startServer(label) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const home = isolatedHome(`shortcut-keys-${label}`)
      const work = fixtureDir(`shortcut-keys-${label}-work`)
      const { config } = scriptedConfig({ home, steps: [{ text: 'answer one' }, { text: 'answer two' }] })
      const child = spawn(
        ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', `${home}/sessions`]),
        { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({
            url: match[1],
            work,
            close: async () => {
              child.kill('SIGKILL')
              removeDir(home)
              removeDir(work)
            },
          })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => {
        if (!settled) {
          settled = true
          reject(new Error(`the server exited ${code} before printing a URL\n${output}`))
        }
      })
      setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill('SIGKILL')
          reject(new Error(`the server printed no URL within 15s\n${output}`))
        }
      }, 15_000).unref()
    })()
  })
}

/** A same-origin call from the page, so the page's own cookie authorises it. */
function call(browser, method, path, body) {
  return browser.evaluate(
    `fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json' }${
      body === undefined ? '' : `, body: ${JSON.stringify(JSON.stringify(body))}`
    } }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }))`,
  )
}

async function sessions(browser) {
  const answer = await call(browser, 'GET', '/api/sessions')
  return Array.isArray(answer.json) ? answer.json : (answer.json?.sessions ?? [])
}

/** Press and release one chord as a keyboard does; `extra` adds modifier bits, `repeat` sends a held repeat. */
async function press(browser, chord, { onMac, extra = 0, primary, repeat = false } = {}) {
  const mod = primary ?? (onMac ? META : CTRL)
  const modifiers = mod | (chord.alt ? ALT : 0) | (chord.shift ? SHIFT : 0) | extra
  const key = onMac ? chord.macKey : chord.key
  const base = { key, code: chord.code, windowsVirtualKeyCode: chord.keyCode, nativeVirtualKeyCode: chord.keyCode, modifiers }
  await browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  if (repeat) await browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, autoRepeat: true })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms))

test('the session shortcuts fire on the physical key, with the key values the browser delivers', async (t) => {
  if (!skipUnless(t, browserAvailable(), `needs ${CAPABILITY} and a browser`)) return
  const server = await startServer('main')
  const browser = await openBrowser({ width: 1400, height: 900 })
  try {
    await browser.goto(server.url)
    await browser.waitFor(`document.body.dataset.ready === 'true'`)
    /** DSH's own platform test (`dsh-client-shortcuts` `detectEnvironment`), the one the page uses. */
    const onMac = await browser.evaluate(`/darwin|mac|iphone|ipad/iu.test(navigator.platform || '')`)
    t.diagnostic(`navigator.platform reads as ${onMac ? 'a Mac' : 'not a Mac'}`)
    assert.equal((await call(browser, 'POST', '/api/workspaces', { path: server.work })).status < 300, true, 'a workspace is registered')
    const created = await call(browser, 'POST', '/api/sessions', { branch: server.work, title: 'chord target' })
    assert.ok(created.json?.session, 'a session is created')
    const target = created.json.session
    /** Fork refuses a session with no completed turn (409), so the target gets one turn first. */
    const seeded = await browser.evaluate(
      `fetch('/api/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: ${JSON.stringify(target)}, prompt: 'seed the session' }) }).then(async (r) => ({ status: r.status, length: (await r.text()).length }))`,
    )
    assert.equal(seeded.status, 200, 'the target session has a completed turn')
    await browser.goto(server.url)
    await browser.waitFor(`document.body.dataset.ready === 'true'`)
    await browser.waitFor(`!!document.querySelector('#tree li[data-session-id="${target}"] > .row')`)
    await browser.evaluate(`document.querySelector('#tree li[data-session-id="${target}"] > .row').click()`)
    await settle()
    const sidebarState = () => browser.evaluate(`document.body.dataset.sidebar`)

    await t.test('search: Mod+Alt+K opens a collapsed sidebar and focuses the field', async () => {
      await browser.evaluate(`(() => { if (document.body.dataset.sidebar !== 'collapsed') document.getElementById('sidebar-toggle').click(); document.activeElement?.blur(); return true })()`)
      assert.equal(await sidebarState(), 'collapsed', 'the sidebar starts collapsed')
      await press(browser, CHORDS.search, { onMac })
      await settle()
      assert.equal(await sidebarState(), 'expanded', 'the chord opens the sidebar')
      assert.equal(await browser.evaluate(`document.activeElement?.id ?? null`), 'session-search', 'and focuses the search field')
    })

    await t.test('sidebar: Mod+Alt+B collapses and restores the sidebar', async () => {
      await browser.evaluate(`(() => { document.activeElement?.blur(); return true })()`)
      await press(browser, CHORDS.sidebar, { onMac })
      await settle()
      assert.equal(await sidebarState(), 'collapsed', 'the first press collapses')
      await press(browser, CHORDS.sidebar, { onMac })
      await settle()
      assert.equal(await sidebarState(), 'expanded', 'the second press restores')
    })

    await t.test('a held chord runs once: the repeat is taken and not run', async () => {
      await press(browser, CHORDS.sidebar, { onMac, repeat: true })
      await settle()
      assert.equal(await sidebarState(), 'collapsed', 'one toggle, not two')
      await press(browser, CHORDS.sidebar, { onMac })
      await settle()
    })

    await t.test('settings: Mod+Alt+Comma opens the settings dialog', async () => {
      await press(browser, CHORDS.settings, { onMac })
      await settle(600)
      assert.equal(await browser.evaluate(`document.getElementById('settings-dialog').open`), true, 'settings is open')
      await browser.evaluate(`document.getElementById('settings-dialog').close()`)
    })

    await t.test('new session: Mod+Alt+N starts a session', async () => {
      const before = (await sessions(browser)).length
      await press(browser, CHORDS.newSession, { onMac })
      await settle(1200)
      assert.equal((await sessions(browser)).length, before + 1, 'one more session')
    })

    await t.test('rename: Mod+Alt+G asks for a title and keeps the answer', async () => {
      await browser.waitFor(`!!document.querySelector('#tree li[data-session-id="${target}"] > .row')`)
      await browser.evaluate(`document.querySelector('#tree li[data-session-id="${target}"] > .row').click()`)
      await settle()
      await browser.evaluate(`(() => { window.__askedFor = null; window.prompt = (message) => { window.__askedFor = message; return 'renamed by chord' }; return true })()`)
      await press(browser, CHORDS.rename, { onMac })
      await settle(900)
      assert.equal(await browser.evaluate(`window.__askedFor`), 'Rename this session', 'the rename prompt opened')
      assert.equal((await sessions(browser)).find((s) => s.id === target)?.title, 'renamed by chord', 'and the title changed')
    })

    await t.test('fork: Mod+Shift+F forks the open session', async () => {
      const before = (await sessions(browser)).length
      await press(browser, CHORDS.fork, { onMac })
      await settle(1200)
      assert.equal((await sessions(browser)).length, before + 1, 'one more session')
    })

    await t.test('the modifier set must match: an extra Shift, or Control in place of Command on a Mac, does nothing', async () => {
      await browser.evaluate(`document.querySelector('#tree li[data-session-id="${target}"] > .row').click()`)
      await settle()
      await press(browser, CHORDS.archive, { onMac, extra: SHIFT })
      await settle(900)
      const untouched = (await sessions(browser)).find((s) => s.id === target)
      assert.ok(untouched !== undefined && untouched.archived !== true, 'Shift added: still listed and not archived')
      if (onMac) {
        await browser.evaluate(`(() => { document.activeElement?.blur(); return true })()`)
        await press(browser, CHORDS.sidebar, { onMac, primary: CTRL })
        await settle()
        assert.equal(await sidebarState(), 'expanded', 'Control+Option+B on a Mac leaves the sidebar alone')
      }
    })

    await t.test('archive: Mod+Alt+A archives the open session', async () => {
      await press(browser, CHORDS.archive, { onMac })
      await settle(1200)
      const after = (await sessions(browser)).find((s) => s.id === target)
      assert.equal(after?.archived, true, 'the session is listed as archived')
    })
  } finally {
    await browser.close()
    await server.close()
  }
})
