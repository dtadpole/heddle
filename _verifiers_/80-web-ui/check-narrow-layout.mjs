import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Below 1024 pixels the sidebar collapses to its rail, and the conversation and composer keep the width.
 *
 * Live-testing draft developer-ten-9: at 390 pixels the sidebar kept about four fifths of the window, the transcript
 * wrapped a few letters per line, and the composer and its send button fell off the screen with no scrollbar to reach
 * them, on both builds. DSH collapses its sidebar below 1024 pixels (`dsh-client-ui-layout`, `SIDEBAR_AUTO_COLLAPSE`),
 * keeps the 56-pixel rail, and lets the toggle open the panel there until it is toggled back or the window crosses the
 * breakpoint, which also leaves the wide preference alone. The window is resized with the protocol's device metrics,
 * as the live journey did.
 */

const CAPABILITY = 'the Web UI'
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }

async function supportsWeb() {
  return /web/.test((await runCli(['--help'])).stdout)
}

function startServer() {
  const home = isolatedHome('narrow-layout')
  const work = fixtureDir('narrow-layout-work')
  mkdirSync(work, { recursive: true })
  const { config } = scriptedConfig({ home, steps: [{ text: 'An answer long enough to wrap across a few lines of a narrow column, which is what a reader on a phone has to read.' }] })
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

/** What a reader of the window can see: the sidebar's state and width, and where the conversation and composer sit. */
const LAYOUT = `(() => {
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width } }
  return {
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    sidebar: document.body.dataset.sidebar,
    aside: rect(document.getElementById('workspace-sidebar')),
    log: rect(document.getElementById('log')),
    field: rect(document.querySelector('#prompt textarea')),
    send: rect(document.getElementById('send')),
  }
})()`

test('below 1024 pixels the sidebar is a rail and the conversation and composer keep the window, as in DSH', async (t) => {
  if (!skipUnless(t, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(t, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer()
  const browser = await openBrowser()
  const metrics = (size) => browser.send('Emulation.setDeviceMetricsOverride', size)
  const layout = () => browser.evaluate(LAYOUT)
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    await browser.goto(server.url)
    await browser.waitFor(`document.querySelector('#prompt textarea') !== null`)
    // One answered turn, so the conversation has text to squeeze.
    await browser.evaluate(`fetch('/api/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hello' }) }).then((r) => r.text())`, 15_000)
    await metrics(PHONE)
    await browser.goto(server.url)
    await browser.waitFor(`document.querySelector('#prompt textarea') !== null && document.body.dataset.sidebar !== undefined`)
    await settle(400)

    await t.test('a phone-width visit starts on the rail and keeps the composer and its send button on screen', async () => {
      const view = await layout()
      assert.equal(view.innerWidth, PHONE.width, 'the window is phone-wide')
      assert.equal(view.sidebar, 'collapsed', `the sidebar is the rail: ${JSON.stringify(view)}`)
      assert.ok(view.aside.width <= 64, `the rail is narrow: ${view.aside.width}px`)
      assert.ok(view.log.width >= 250, `the conversation keeps a readable width: ${view.log.width}px`)
      assert.ok(view.field.width >= 200 && view.field.right <= view.innerWidth + 1, `the message field is on screen: ${JSON.stringify(view.field)}`)
      assert.ok(view.send.right <= view.innerWidth + 1 && view.send.left >= 0, `the send button is on screen: ${JSON.stringify(view.send)}`)
      assert.ok(view.scrollWidth <= view.innerWidth + 1, `nothing overflows sideways: ${view.scrollWidth} > ${view.innerWidth}`)
    })

    await t.test('while narrow, the toggle opens the panel and closes it again', async () => {
      await browser.evaluate(`document.getElementById('sidebar-toggle').click()`)
      await settle(200)
      assert.equal((await layout()).sidebar, 'expanded', 'opened over the squeezed conversation')
      await browser.evaluate(`document.getElementById('sidebar-toggle').click()`)
      await settle(200)
      assert.equal((await layout()).sidebar, 'collapsed', 'back to the rail')
    })

    await t.test('crossing the breakpoint forgets the narrow opening and leaves the wide preference alone', async () => {
      await browser.evaluate(`document.getElementById('sidebar-toggle').click()`)
      await settle(200)
      assert.equal((await layout()).sidebar, 'expanded', 'opened while narrow')
      await metrics(DESKTOP)
      await settle(300)
      assert.equal((await layout()).sidebar, 'expanded', 'wide: the wide default, the open panel')
      await browser.evaluate(`document.getElementById('sidebar-toggle').click()`)
      await settle(200)
      assert.equal((await layout()).sidebar, 'collapsed', 'collapsed by preference while wide')
      await metrics(PHONE)
      await settle(300)
      assert.equal((await layout()).sidebar, 'collapsed', 'narrow again: the rail, the earlier opening forgotten')
      await metrics(DESKTOP)
      await settle(300)
      assert.equal((await layout()).sidebar, 'collapsed', 'wide again: the wide preference survived the trip')
    })

    await t.test('a desktop-width visit still starts with the panel open', async () => {
      await metrics(DESKTOP)
      await browser.goto(server.url)
      await browser.waitFor(`document.querySelector('#prompt textarea') !== null && document.body.dataset.sidebar !== undefined`)
      await settle(300)
      const view = await layout()
      assert.equal(view.sidebar, 'expanded', 'the wide panel, as before')
      assert.ok(view.aside.width > 150, `the panel is wide: ${view.aside.width}px`)
    })
  } finally {
    await browser.close()
    server.close()
  }
})
