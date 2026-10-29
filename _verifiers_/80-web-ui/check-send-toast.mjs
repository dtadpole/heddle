import assert from 'node:assert/strict'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A refused send is a Toast, as DSH's composer shows it (`dsh-client-ui-conversation`): the reason in DSH's words,
 * announced (`role=alert`), above the composer, gone by itself after a few seconds, with the words given back to the
 * composer and nothing written into the conversation. The page wrote a permanent `denied` line into the transcript,
 * outside any live region (DSH parity R-developer-seven-1, row S27).
 *
 * The refusal is arranged in the page: `/api/turn` answers 409 through a replaced `fetch`, so both builds are judged on
 * the same answer, a writer-held refusal and a refusal with another code.
 */

const CAPABILITY = 'a Web UI on localhost with a live stream'

function startServer(label) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const home = isolatedHome(`send-toast-${label}`)
      const work = fixtureDir(`send-toast-${label}-work`)
      const { config } = scriptedConfig({ home, steps: [{ text: 'answer' }] })
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
          resolvePromise({ url: match[1], work, close: async () => { child.kill('SIGKILL'); removeDir(home); removeDir(work) } })
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

/** Make the next sends to `/api/turn` answer `status` with `body`, leaving every other request alone. */
function refuseTurns(browser, status, body) {
  return browser.evaluate(`(() => {
    window.__realFetch = window.__realFetch ?? window.fetch
    window.fetch = (input, init) => String(input).includes('/api/turn')
      ? Promise.resolve(new Response(${JSON.stringify(JSON.stringify(body))}, { status: ${status}, headers: { 'content-type': 'application/json' } }))
      : window.__realFetch(input, init)
    return true
  })()`)
}

async function send(browser, text) {
  await browser.evaluate(`(() => {
    const field = document.querySelector('#prompt textarea')
    field.focus()
    field.value = ${JSON.stringify(text)}
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
    return true
  })()`)
}

const toast = (browser) =>
  browser.evaluate(`(() => {
    const element = document.getElementById('composer-toast')
    if (element === null) return null
    return { shown: !element.hidden, role: element.getAttribute('role'), text: element.textContent.replace(/\\s+/g, ' ').trim() }
  })()`)

const deniedLines = (browser) => browser.evaluate(`document.querySelectorAll('#log .turn.denied').length`)
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a refused send is a Toast that names the reason and goes away by itself, as DSH does', async (t) => {
  if (!skipUnless(t, browserAvailable(), `needs ${CAPABILITY} and a browser`)) return
  const server = await startServer('main')
  const browser = await openBrowser({ width: 1400, height: 900 })
  try {
    await browser.goto(server.url)
    await browser.waitFor(`document.body.dataset.ready === 'true'`)
    const deniedBefore = await deniedLines(browser)

    await t.test('a session another process writes: DSH\'s sentence, announced, words given back', async () => {
      await refuseTurns(browser, 409, { error: 'session is held by pid 4242', code: 'session/writer-held' })
      await send(browser, 'this send is refused')
      await settle(700)
      const shown = await toast(browser)
      assert.ok(shown !== null, 'the page has a Toast')
      assert.equal(shown.shown, true, 'the Toast is shown')
      assert.equal(shown.role, 'alert', 'and announced')
      assert.match(shown.text, /This session is already in use/, `DSH's sentence: ${shown.text}`)
      assert.equal(await browser.evaluate(`document.querySelector('#prompt textarea').value`), 'this send is refused', 'the words go back to the composer')
      assert.equal(await deniedLines(browser), deniedBefore, 'nothing is written into the conversation')
    })

    await t.test('it goes away by itself', async () => {
      await settle(6800)
      assert.equal((await toast(browser))?.shown, false, 'gone after a few seconds')
    })

    await t.test('a refusal with another code reads sentence (code)', async () => {
      await refuseTurns(browser, 404, { error: 'no session session-x', code: 'session/not-found' })
      await browser.evaluate(`(() => { document.querySelector('#prompt textarea').value = ''; return true })()`)
      await send(browser, 'refused again')
      await settle(700)
      const shown = await toast(browser)
      assert.equal(shown?.shown, true)
      assert.equal(shown?.text.replace(/^⚠\s*/, ''), 'no session session-x (session/not-found)')
    })
  } finally {
    await browser.close()
    await server.close()
  }
})
