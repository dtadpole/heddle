import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The left sidebar keeps DSH's width contract: 280 pixels on a first visit, and 264 to 420 whatever the reader drags.
 *
 * DSH clamps the panel with `clampWidth(sidebar, 264, 420)` and gives a first visit (and a reopened panel)
 * `sidebar: 280` (`dsh-client-ui-layout`, `computeColumns`). Phase A measured heddle at a 1400-pixel window with a
 * 16-pixel root: 352 by default, 192 at Home, 768 at End (S48, R-developer-seven-13). The divider is driven the three
 * ways a reader drives it: a pointer drag past each edge, the keyboard's Home and End, and a double-click, and a width
 * remembered under the old bounds is loaded. Heddle's own difference stays: the chosen width survives a reload (S50).
 */

const CAPABILITY = 'the Web UI'
const DESKTOP = { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }
const KEY = 'heddle.layout.sidebar.v1'

async function supportsWeb() {
  return /web/.test((await runCli(['--help'])).stdout)
}

function startServer() {
  const home = isolatedHome('sidebar-bounds')
  const work = fixtureDir('sidebar-bounds-work')
  mkdirSync(work, { recursive: true })
  const { config } = scriptedConfig({ home, steps: [{ text: 'unused' }] })
  const child = spawn(
    ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]),
    { cwd: work, env: { ...process.env, NO_COLOR: '1', HEDDLE_HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`the server printed no URL within 15s\n${output}`)), 15_000)
    const read = (chunk) => {
      output += chunk
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolve({
          url: match[1],
          close: () => {
            child.kill('SIGKILL')
            removeDir(home)
            removeDir(work)
          },
        })
      }
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.on('exit', (code) => reject(new Error(`the server exited ${code}\n${output}`)))
  })
}

/** The panel's drawn width and what the divider reports. */
const WIDTH = `(() => {
  const gutter = document.getElementById('gutter-left')
  return {
    width: Math.round(document.getElementById('workspace-sidebar').getBoundingClientRect().width),
    sidebar: document.body.dataset.sidebar,
    now: gutter.getAttribute('aria-valuenow'),
    min: gutter.getAttribute('aria-valuemin'),
    max: gutter.getAttribute('aria-valuemax'),
    stored: localStorage.getItem(${JSON.stringify(KEY)}),
  }
})()`

/** A pointer drag on the divider from its own box to `clientX`, the way 87-resizable-panels drives it. */
const drag = (clientX) => `(() => {
  const gutter = document.getElementById('gutter-left')
  const box = gutter.getBoundingClientRect()
  const fire = (type, x) => gutter.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: box.top + box.height / 2, pointerId: 7 }))
  fire('pointerdown', box.left + 1)
  fire('pointermove', ${clientX})
  fire('pointerup', ${clientX})
  return true
})()`

const key = (name) => `(() => {
  const gutter = document.getElementById('gutter-left')
  gutter.focus()
  gutter.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true, cancelable: true }))
  return true
})()`

test('the sidebar opens at 280 pixels and stays within 264 to 420, as DSH\'s does', async (t) => {
  if (!skipUnless(t, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(t, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer()
  const browser = await openBrowser()
  const width = () => browser.evaluate(WIDTH)
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const visit = async () => {
    await browser.goto(server.url)
    await browser.waitFor(`document.getElementById('gutter-left') !== null && document.body.dataset.sidebar !== undefined`, 20_000)
    await settle(300)
  }
  try {
    await browser.send('Emulation.setDeviceMetricsOverride', DESKTOP)
    await visit()
    await browser.evaluate(`(localStorage.removeItem(${JSON.stringify(KEY)}), true)`)
    await visit()

    await t.test('a first visit draws the panel at DSH\'s 280 pixels, and the divider says so', async () => {
      const view = await width()
      assert.equal(view.sidebar, 'expanded', JSON.stringify(view))
      assert.equal(view.width, 280, `the default width: ${JSON.stringify(view)}`)
      assert.equal(view.min, '16.5', 'the divider\'s minimum is 264 pixels in rem')
      assert.equal(view.max, '26.25', 'and its maximum 420')
      assert.equal(view.now, '18', 'and it reports the width it shows, rounded to a rem')
      assert.equal(view.stored, null, 'a first visit stores nothing')
    })

    await t.test('a drag past either edge stops at 420 and at 264 pixels', async () => {
      await browser.evaluate(drag('window.innerWidth * 3'))
      const widest = await width()
      assert.equal(widest.width, 420, `dragged across the window: ${JSON.stringify(widest)}`)
      assert.equal(widest.stored, '26.25', 'and the choice is remembered as drawn')
      await browser.evaluate(drag(-9999))
      const narrowest = await width()
      assert.equal(narrowest.width, 264, `dragged off the left edge: ${JSON.stringify(narrowest)}`)
    })

    await t.test('End and Home go to the same bounds, and a double-click comes back to 280', async () => {
      await browser.evaluate(key('End'))
      assert.equal((await width()).width, 420, 'End')
      await browser.evaluate(key('Home'))
      assert.equal((await width()).width, 264, 'Home')
      await browser.evaluate(`(document.getElementById('gutter-left').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), true)`)
      const reset = await width()
      assert.equal(reset.width, 280, `the double-click's default: ${JSON.stringify(reset)}`)
    })

    await t.test('a width remembered under the old bounds is drawn inside the new ones', async () => {
      await browser.evaluate(`(localStorage.setItem(${JSON.stringify(KEY)}, '30'), true)`)
      await visit()
      const wide = await width()
      assert.equal(wide.width, 420, `a stored 30rem (480 pixels) is drawn at the maximum: ${JSON.stringify(wide)}`)
      assert.equal(wide.stored, '30', 'and a load does not rewrite the stored choice')
      await browser.evaluate(`(localStorage.setItem(${JSON.stringify(KEY)}, '12'), true)`)
      await visit()
      assert.equal((await width()).width, 264, 'a stored 12rem (192 pixels) is drawn at the minimum')
      await browser.evaluate(`(localStorage.setItem(${JSON.stringify(KEY)}, '20'), true)`)
      await visit()
      assert.equal((await width()).width, 320, 'and a width inside the bounds comes back as it was (S50)')
    })

    await t.test('collapsed, the panel is still DSH\'s 56-pixel rail', async () => {
      await browser.evaluate(`(document.getElementById('sidebar-toggle').click(), true)`)
      await settle(300)
      const rail = await width()
      assert.equal(rail.sidebar, 'collapsed', JSON.stringify(rail))
      assert.equal(rail.width, 56, `the rail: ${JSON.stringify(rail)}`)
    })
  } finally {
    await browser.close()
    server.close()
  }
})
