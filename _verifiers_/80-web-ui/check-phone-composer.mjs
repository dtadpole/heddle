import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * At phone width the composer's control row and the status line under it stay readable (#117).
 *
 * Live testing at 390 pixels, both builds: the round send button was drawn over the model chip, so the model's name
 * read "first half, button, second half", and the status line was centred wider than its column, so its first words
 * were cut off at the left edge with nothing to scroll to. DSH's own CSS is the reference for both
 * (`dsh-client-ui-model-selection`, `dsh-client-ui-chat`): its model trigger is a block-level flex box with
 * `min-width: 0` whose label ellipsizes, and each status pill sits in an anchor with `min-width: 0` and carries
 * `max-width: 100%`, so a narrow dock shortens the pill labels instead of overflowing.
 *
 * The model's name is a long one on purpose, and the status line is given the figures a long session shows, because
 * the defect is about text that does not fit.
 */

const CAPABILITY = 'the Web UI'
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }
const MODEL = 'scripted-model-with-a-long-name'

function startServer() {
  const home = isolatedHome('phone-composer')
  const work = fixtureDir('phone-composer-work')
  mkdirSync(work, { recursive: true })
  const script = join(home, 'script.json')
  writeFileSync(script, JSON.stringify({ steps: [{ text: 'An answer, so the session has a turn to count.' }] }))
  const config = join(home, 'heddle.json')
  writeFileSync(config, JSON.stringify({ default: 'scripted', endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: script, model: MODEL }] }))
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

/** Where the composer's controls and the status line's items are drawn, and whether the model's name is cut short. */
const ROW = `(() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left * 2) / 2, right: Math.round(r.right * 2) / 2, width: Math.round(r.width) } }
  const label = document.getElementById('model-label')
  const status = document.getElementById('composer-status')
  return {
    innerWidth: window.innerWidth,
    label: label.textContent,
    labelCut: label.scrollWidth > label.clientWidth + 1,
    access: rect(document.getElementById('access')),
    trigger: rect(document.getElementById('model-trigger')),
    labelBox: rect(label),
    send: rect(document.getElementById('send')),
    card: rect(document.getElementById('composer-card')),
    status: status.hidden ? null : rect(status),
    items: status.hidden ? [] : Array.from(status.querySelectorAll('[data-stat-pill]')).filter((el) => !el.hidden).map(rect),
  }
})()`

/** The figures a long session shows, written into the status line's own fields. */
const LONG_SESSION = `(() => {
  const set = (name, text) => { const el = document.querySelector('#composer-status [data-stat="' + name + '"]'); if (el) { el.textContent = text; el.hidden = false } }
  set('turns', '16 turns'); set('steps', '48 steps'); set('tokens', '122 tok/s'); set('total', '121.6K tok'); set('cache', 'Cache hit 96%'); set('context', '61%')
  for (const sep of document.querySelectorAll('#composer-status .stat-sep')) sep.hidden = false
  for (const pill of document.querySelectorAll('#composer-status [data-stat-pill]')) pill.hidden = false
  document.getElementById('composer-status').hidden = false
  return true
})()`

test('at phone width the model chip stays beside the send button and the status line stays inside its column', async (t) => {
  if (!skipUnless(t, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(t, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer()
  const browser = await openBrowser()
  const metrics = (size) => browser.send('Emulation.setDeviceMetricsOverride', size)
  const settle = () => browser.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100))))`)
  try {
    await browser.goto(server.url)
    await browser.waitFor(`document.querySelector('#prompt textarea') !== null`)
    const answered = String(await browser.evaluate(`fetch('/api/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hello' }) }).then((r) => r.text())`, 15_000))
    const session = /"session":"(session-[^"]+)"/.exec(answered)?.[1]
    assert.ok(session, `the turn named its session\n${answered.slice(0, 200)}`)
    await metrics(PHONE)
    /** The page opens no session on its own (#17): the answered one is opened by name, as check-narrow-layout does. */
    await browser.gotoSession(server.url, session)
    await browser.waitFor(`document.body.dataset.ready === 'true' && document.getElementById('model-label').textContent === ${JSON.stringify(MODEL)}`, 15_000)
    await browser.evaluate(LONG_SESSION)
    await settle()
    const phone = await browser.evaluate(ROW)
    const seen = JSON.stringify(phone)
    assert.equal(phone.innerWidth, PHONE.width, 'the window is phone-wide')

    await t.test('the model chip ends before the send button and starts after the access chip', () => {
      assert.ok(phone.trigger.right <= phone.send.left + 0.5, `the send button is not drawn over the chip ${seen}`)
      assert.ok(phone.trigger.left >= phone.access.right - 0.5, `the chip does not run under the access chip ${seen}`)
      assert.ok(phone.labelBox.right <= phone.trigger.right + 0.5, `the name stays inside its chip ${seen}`)
      assert.equal(phone.labelCut, true, `a name too long for the row is shortened with an ellipsis ${seen}`)
    })

    await t.test('every item of the status line is inside the composer column', () => {
      assert.ok(phone.status !== null && phone.items.length >= 2, `the status line is shown ${seen}`)
      assert.ok(phone.status.left >= phone.card.left - 0.5 && phone.status.right <= phone.card.right + 0.5, `the line fits the card's width ${seen}`)
      for (const item of phone.items) {
        assert.ok(item.left >= phone.card.left - 0.5 && item.right <= phone.card.right + 0.5, `no item is cut off at either edge ${seen}`)
      }
    })

    await t.test('a desktop window still shows the whole name', async () => {
      await metrics(DESKTOP)
      await settle()
      const wide = await browser.evaluate(ROW)
      assert.equal(wide.labelCut, false, `the name is whole where it fits ${JSON.stringify(wide)}`)
      assert.ok(wide.trigger.right <= wide.send.left + 0.5, `and the chip still ends before the send button ${JSON.stringify(wide)}`)
    })
  } finally {
    await browser.close()
    server.close()
  }
})
