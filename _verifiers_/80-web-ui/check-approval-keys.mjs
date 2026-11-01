import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The approval card answers from the **keyboard**, judged with the key events a browser really delivers (#158).
 *
 * DSH's `ApprovalFlow` (`dsh-client-ui-approval`) handles keys on the card: with focus in it and not in a field,
 * Escape answers `rejected` and Enter `allowed-once`, except on a button or link, which keeps its own Enter; a key
 * with a modifier, a held repeat or a composing input method answers nothing. The card's body is focusable (tabIndex
 * 0, role group), so Enter has a target that is not a button, and the keyboard reference lists both keys in an
 * "Approval area" group. Live testing found the card took no key at all: Escape on its focused Reject button left the
 * question waiting on every page.
 *
 * The keys go through the protocol's `Input.dispatchKeyEvent`, so the page receives them as it would from a keyboard,
 * Enter's keypress (a button's native activation) included. Every answer the page posts is recorded, so a key that
 * answers twice, or answers the wrong way, is seen as such.
 */

const CAPABILITY = 'a Web UI on localhost with a live stream'

/** Start a server whose scripted turn is refused under workspace-write and then asks to widen to full access. */
function startServer(label) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const home = isolatedHome(`approval-keys-${label}`)
      const work = fixtureDir(`approval-keys-${label}-work`)
      const outsideDir = fixtureDir(`approval-keys-${label}-outside`)
      const outsidePath = join(outsideDir, 'outside.txt')
      const write = `echo outside > ${JSON.stringify(outsidePath)}`
      const { config } = scriptedConfig({
        home,
        steps: [
          { toolCall: { name: 'bash', arguments: { command: write } } },
          {
            toolCall: {
              name: 'bash',
              arguments: { command: write, sandbox_permissions: 'danger-full-access', justification: 'the write target is outside the workspace' },
            },
          },
          { text: 'done' },
        ],
      })
      const child = spawn(
        ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions'), '--sandbox-root', work]),
        { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
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
            outsidePath,
            close: async () => {
              child.kill('SIGKILL')
              removeDir(home)
              removeDir(work)
              removeDir(outsideDir)
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

/** Modifier bits of `Input.dispatchKeyEvent`. */
const CTRL = 2
const META = 4
const SHIFT = 8

const KEYS = {
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  /** Enter carries its text, so the browser also delivers the keypress a focused button activates on. */
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' },
}

/** Press and release one key as a keyboard does. */
async function press(browser, name, modifiers = 0) {
  const { text, unmodifiedText, ...base } = KEYS[name]
  const down = text === undefined ? { type: 'rawKeyDown', ...base, modifiers } : { type: 'keyDown', ...base, text, unmodifiedText, modifiers }
  await browser.send('Input.dispatchKeyEvent', down)
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base, modifiers })
}

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms))

const CARD_SHOWN = 'document.getElementById("approval-card").hidden === false'

test('the approval card answers from the keyboard: Escape rejects, Enter on its body allows once, a button keeps its Enter', async (t) => {
  if (!skipUnless(t, browserAvailable(), `needs ${CAPABILITY} and a browser`)) return
  const server = await startServer('main')
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 20_000)
    await browser.waitFor('document.getElementById("composer-card") !== null', 20_000)
    /** Record every answer the page posts, in order, by wrapping the fetch the card's answer goes through. */
    await browser.evaluate(`(() => {
      window.__answers = []
      const original = window.fetch
      window.fetch = function (input, init) {
        const url = String(input && input.url !== undefined ? input.url : input)
        if (url.includes('/api/approvals/') && init && init.method === 'POST') window.__answers.push(JSON.parse(init.body).outcome)
        return original.apply(this, arguments)
      }
      return true
    })()`)
    const answers = async () => browser.evaluate('JSON.stringify(window.__answers)').then((text) => JSON.parse(text))
    const clearAnswers = () => browser.evaluate('(() => { window.__answers = []; return true })()')
    const focus = (selector) =>
      browser.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.focus(); return document.activeElement === element })()`)
    /** Send one message through the composer and wait for the question it raises. */
    const ask = async (text) => {
      await browser.waitFor('document.getElementById("send").hidden === false', 20_000)
      await clearAnswers()
      await browser.evaluate(`(() => {
        const field = document.querySelector('#prompt textarea')
        field.value = ${JSON.stringify(text)}
        field.dispatchEvent(new Event('input', { bubbles: true }))
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
        return true
      })()`)
      assert.ok(await browser.waitFor(CARD_SHOWN, 20_000), 'the turn asks for approval')
    }
    const settledTurn = async () => {
      assert.ok(await browser.waitFor('document.getElementById("approval-card").hidden === true', 10_000), 'the answer closes the card')
      assert.ok(await browser.waitFor('document.getElementById("send").hidden === false', 20_000), 'and the turn finishes')
    }

    await t.test('keys that are not the card\'s leave the question waiting', async () => {
      await ask('write outside the workspace, first time')
      /** Two Escapes in the composer: not in the card, and the card breaks the Esc Esc stop, as DSH's does. */
      assert.equal(await focus('#prompt textarea'), true, 'the composer has the focus')
      await press(browser, 'Escape')
      await settle(100)
      await press(browser, 'Escape')
      await settle(1200)
      assert.deepEqual(await answers(), [], 'Escape in the composer answers nothing')
      assert.equal(await browser.evaluate(CARD_SHOWN), true, 'the card still waits')
      assert.equal(await browser.evaluate('document.getElementById("stop").hidden'), false, 'and the turn was not stopped')
      /** A modifier makes the key someone else's. */
      assert.equal(await focus('#approval-body'), true, 'the card\'s body takes the focus')
      await press(browser, 'Escape', SHIFT)
      await press(browser, 'Enter', SHIFT)
      await settle(1000)
      assert.deepEqual(await answers(), [], 'Shift+Escape and Shift+Enter answer nothing')
      assert.equal(await browser.evaluate(CARD_SHOWN), true, 'and the card still waits')
    })

    await t.test('Escape in the card rejects, even with Allow once focused', async () => {
      assert.equal(await focus('#approval-allow'), true, 'Allow once has the focus')
      await press(browser, 'Escape')
      await settledTurn()
      assert.deepEqual(await answers(), ['rejected'], 'one answer, and it is rejected')
      assert.equal(existsSync(server.outsidePath), false, 'the rejected call wrote nothing')
      assert.ok(await browser.waitFor('document.getElementById("log").innerText.includes("rejected")', 10_000), 'and the transcript says the ask was rejected')
    })

    await t.test('Enter on a focused Reject button is the button\'s own: it rejects, once', async () => {
      await ask('write outside the workspace, second time')
      assert.equal(await focus('#approval-reject'), true, 'Reject has the focus')
      await press(browser, 'Enter')
      await settledTurn()
      assert.deepEqual(await answers(), ['rejected'], 'the button\'s answer, and no allow from the card')
      assert.equal(existsSync(server.outsidePath), false, 'the rejected call wrote nothing')
    })

    await t.test('Enter on the card\'s body allows once, and a second press posts nothing more', async () => {
      await ask('write outside the workspace, third time')
      assert.equal(await focus('#approval-body'), true, 'the card\'s body takes the focus')
      const body = await browser.evaluate(`(() => {
        const body = document.getElementById('approval-body')
        return JSON.stringify({ role: body.getAttribute('role'), label: body.getAttribute('aria-label'), tabIndex: body.tabIndex, holdsReason: body.contains(document.getElementById('approval-reason')) })
      })()`)
      assert.deepEqual(JSON.parse(body), { role: 'group', label: 'Approval details', tabIndex: 0, holdsReason: true }, 'DSH\'s focusable body, holding the question')
      await press(browser, 'Enter')
      await press(browser, 'Enter')
      await settledTurn()
      assert.deepEqual(await answers(), ['allowed-once'], 'one answer, and it allows once')
      assert.equal(existsSync(server.outsidePath), true, 'the allowed retry wrote the file')
      assert.equal(await browser.evaluate('document.getElementById("access-label").textContent'), 'Workspace Write', 'and the session\'s own mode did not move')
    })

    await t.test('the keyboard reference lists the card\'s keys as "Approval area"', async () => {
      const onMac = await browser.evaluate(`/darwin|mac|iphone|ipad/iu.test(navigator.platform || '')`)
      const slash = { key: '/', code: 'Slash', windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191, modifiers: onMac ? META : CTRL }
      await focus('#prompt textarea')
      await browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...slash })
      await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...slash })
      assert.ok(await browser.waitFor('document.getElementById("shortcut-reference").open === true', 5000), 'Mod+/ opens the reference')
      const seen = JSON.parse(
        await browser.evaluate(`JSON.stringify((() => {
          const list = document.getElementById('shortcut-reference-list')
          const groups = [...list.querySelectorAll('.group')].map((heading) => heading.textContent)
          const rows = []
          let group = null
          for (const child of list.children) {
            if (child.classList.contains('group')) group = child.textContent
            else if (group === 'Approval area') rows.push([child.querySelector('.label')?.textContent, child.querySelector('kbd')?.textContent, child.dataset.fixed === 'true'])
          }
          return { groups, rows }
        })())`),
      )
      assert.deepEqual(seen.groups.slice(-2), ['Message input', 'Approval area'], `the group follows the input actions\nsaw: ${JSON.stringify(seen)}`)
      assert.deepEqual(seen.rows, [['Allow once', 'Enter', true], ['Reject', 'Esc', true]], 'with Allow once (Enter) and Reject (Esc), read-only as DSH\'s fixed keys are')
      await press(browser, 'Escape')
      assert.ok(await browser.waitFor('document.getElementById("shortcut-reference").open === false', 5000), 'Escape closes it')
    })
  } finally {
    browser.close()
    await server.close()
  }
})
