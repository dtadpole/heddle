import assert from 'node:assert/strict'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A refused send is DSH's composer Toast (`dsh-client-ui-conversation`, its `promptError` effect and
 * `Toast anchor={cardRef}`): the reason in DSH's words, announced (`role=alert`), just above the composer card, gone by
 * itself (the primitives' Toast: three seconds and a one-second fade), with the words given back to the composer and
 * nothing written into the conversation. The page wrote a permanent `denied` line, "the message could not be sent:
 * <raw body>", outside any live region (DSH parity R-developer-seven-1, row S27).
 *
 * The refusal is arranged in the page: `/api/turn` answers through a replaced `fetch`, so both builds are judged on the
 * same answers, a writer-held refusal and one with another code.
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
        /** `HEDDLE_HOME` too, so the workspace this check registers stays in the fixture whatever the shell exports. */
        { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
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

/** The Toast the page shows, where it sits against the composer card, and what the conversation holds. */
const state = (browser) =>
  browser.evaluate(`(() => {
    const toast = document.getElementById('session-toast')
    const card = document.getElementById('composer-card')?.getBoundingClientRect()
    const box = toast?.getBoundingClientRect()
    return {
      toast: toast === null ? null : {
        role: toast.getAttribute('role'),
        kind: toast.dataset.kind ?? null,
        tone: toast.dataset.tone ?? null,
        text: toast.textContent.replace(/\\s+/g, ' ').trim(),
        aboveCard: card !== undefined && Math.round(box.bottom) <= Math.round(card.top) && Math.round(card.top - box.bottom) <= 16,
        centred: card !== undefined && Math.abs((box.left + box.width / 2) - (card.left + card.width / 2)) <= 2,
      },
      draft: document.querySelector('#prompt textarea').value,
      denied: [...document.querySelectorAll('#log .turn.denied')].map((node) => node.textContent),
    }
  })()`)

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a refused send is a Toast above the composer that names the reason and goes away by itself, as DSH does', async (t) => {
  if (!skipUnless(t, browserAvailable(), `needs ${CAPABILITY} and a browser`)) return
  const server = await startServer('main')
  const browser = await openBrowser({ width: 1400, height: 900 })
  try {
    await browser.goto(server.url)
    await browser.waitFor(`document.body.dataset.ready === 'true'`, 20_000)
    /** A workspace to start in, so the send reaches `/api/turn` rather than stopping at "Choose a workspace first." */
    const registered = await browser.evaluate(`fetch('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify({ path: server.work }))} }).then((r) => r.status)`)
    assert.ok(registered < 300, `a workspace is registered (${registered})`)
    await browser.goto(server.url)
    await browser.waitFor(`document.body.dataset.ready === 'true'`, 20_000)
    const deniedBefore = (await state(browser)).denied

    await t.test("a session another process writes: DSH's sentence, announced, above the card, words given back", async () => {
      await refuseTurns(browser, 409, { error: 'session is held by pid 4242', code: 'session/writer-held' })
      await send(browser, 'this send is refused')
      assert.ok(await browser.waitFor(`document.getElementById('session-toast') !== null`, 5_000), 'a Toast is shown')
      const shown = await state(browser)
      assert.equal(shown.toast.role, 'alert', 'announced')
      assert.equal(shown.toast.kind, 'sendRefused')
      assert.equal(shown.toast.tone, 'warning')
      assert.match(shown.toast.text, /^This session is already in use, possibly by another running heddle/, `DSH's sentence: ${shown.toast.text}`)
      assert.equal(shown.toast.aboveCard, true, 'it sits just above the composer card, as DSH anchors it')
      assert.equal(shown.toast.centred, true, 'centred on the card')
      assert.equal(shown.draft, 'this send is refused', 'the words go back to the composer')
      assert.deepEqual(shown.denied, deniedBefore, 'nothing is written into the conversation')
    })

    await t.test('it goes away by itself after the Toast\u2019s three seconds and its fade', async () => {
      await settle(4_600)
      assert.equal((await state(browser)).toast, null, 'gone')
    })

    await t.test('a refusal with another code reads message (code), not the raw body', async () => {
      await refuseTurns(browser, 404, { error: 'no session session-x', code: 'session/not-found' })
      await browser.evaluate(`(() => { document.querySelector('#prompt textarea').value = ''; return true })()`)
      await send(browser, 'refused again')
      assert.ok(await browser.waitFor(`document.getElementById('session-toast') !== null`, 5_000), 'a Toast is shown')
      const shown = await state(browser)
      assert.equal(shown.toast.text, 'no session session-x (session/not-found)')
      assert.deepEqual(shown.denied, deniedBefore, 'and still nothing in the conversation')
    })
  } finally {
    await browser.close()
    await server.close()
  }
})
