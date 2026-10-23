import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The left column's two workspace controls, judged over HTTP and then in a browser.
 *
 * The claim is the one the owner asked for: a person can register a folder as a workspace root and
 * unregister one **from the page**, and the tree separates the folders they chose from the folders
 * that were adopted because a session happened to run in them.
 *
 * Two layers are judged deliberately. The routes are judged over HTTP because that is where the
 * rules live — a path must be absolute and exist, a name must be a slug, and unregistering a root
 * that still holds sessions is **refused** with a reason rather than being undone by the next
 * `bootstrap`. The page is judged in a browser because the controls are the request: a route that
 * works while the button does not is the failure this check exists for.
 */

const CAPABILITY = 'the Web UI'

/** A run whose server prints its URL, and the home it is isolated in. */
async function startServer(label, options = {}) {
  const home = isolatedHome(`workspaces-${label}`)
  const work = fixtureDir(`workspaces-${label}-work`)
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  const child = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config } },
  )
  return {
    home,
    work,
    url: child.url,
    close: async () => {
      child.kill()
      removeDir(home)
      removeDir(work)
    },
  }
}

/** Spawn the CLI and resolve once it prints its URL, or reject on exit. */
function startCli(args, options) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { repoRoot } = await import('../../_tools_/verify-runner/lib.mjs')
      const child = spawn(...heddleCommand(args), {
        cwd: repoRoot,
        env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ child, url: match[1], kill: () => child.kill('SIGKILL') })
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
      }, 15_000)
    })()
  })
}

/** The token in the printed URL, exchanged for the cookie everything else uses. */
async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

/** One API call, with the cookie, answering parsed JSON. */
async function api(url, cookie, path, init = {}) {
  const response = await fetch(new URL(path, url), {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

async function supportsWeb() {
  return /web/.test((await runCli(['--help'])).stdout)
}

test('a workspace is registered and unregistered over the API the controls call', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const server = await startServer('api')
  const loose = fixtureDir('workspaces-loose')
  const parent = fixtureDir('workspaces-parent')
  const child = join(parent, 'child')
  try {
    mkdirSync(loose, { recursive: true })
    mkdirSync(child, { recursive: true })
    const cookie = await cookieFor(server.url)

    // A session in a folder nobody registered: it is adopted, and reported apart from the tree.
    const turn = await api(server.url, cookie, '/api/turn', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'work in the loose folder', folder: loose }),
    })
    assert.equal(turn.status, 200, `the turn ran (${turn.status})`)

    const before = await api(server.url, cookie, '/api/tree')
    const adHoc = (before.body.adHoc ?? []).map((node) => node.path)
    assert.ok(adHoc.includes(loose), `the adopted folder is reported as ad hoc\nsaw: ${adHoc.join(', ')}`)
    assert.ok(!(before.body.children ?? []).some((node) => node.path === loose), 'and not as a chosen project')

    // Registering it is what the page's `+` posts.
    const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: loose }) })
    assert.equal(added.status, 200, `the folder registered (${JSON.stringify(added.body)})`)
    assert.equal(added.body.record?.path, loose)
    /**
     * `created` is false on purpose here: the folder was already known, because the session adopted it.
     * Registering it **promotes** the adopted record rather than writing a second one for the same path,
     * which is what makes the ad-hoc group a staging area instead of a duplicate.
     */
    assert.equal(added.body.record?.origin, 'added', 'registering an adopted folder promotes it')
    assert.equal(added.body.created, false, 'and reports that it was already known')

    const after = await api(server.url, cookie, '/api/tree')
    assert.ok((after.body.children ?? []).some((node) => node.path === loose), 'and it is in the tree now')
    assert.ok(!(after.body.adHoc ?? []).some((node) => node.path === loose), 'rather than beside it')

    // The refusals, which are what make the controls honest.
    const missing = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: '/no/such/folder/at/all' }) })
    assert.equal(missing.status, 400, 'a folder that does not exist is refused')
    const relative = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: 'not/absolute' }) })
    assert.equal(relative.status, 400, 'a relative path is refused')
    const badName = await api(server.url, cookie, '/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ path: loose, name: 'Not A Slug' }),
    })
    assert.equal(badName.status, 400, 'a name that is not a slug is refused')

    const busy = await api(server.url, cookie, `/api/workspaces/${encodeURIComponent(loose)}`, { method: 'DELETE' })
    assert.equal(busy.status, 409, 'a root that still holds sessions is refused')
    assert.match(String(busy.body.error), /still holds \d+ session/, 'and the refusal says why')

    // With a root above it, the sessions have somewhere to go, so the removal is durable.
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: parent }) })
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: child, name: 'inner' }) })
    const removed = await api(server.url, cookie, `/api/workspaces/${encodeURIComponent(child)}`, { method: 'DELETE' })
    assert.equal(removed.status, 200, `a root with a parent above it is removed (${JSON.stringify(removed.body)})`)
    assert.equal(removed.body.adoptedBy, parent.split('/').filter(Boolean).pop(), 'and it says where its sessions went')

    const gone = await api(server.url, cookie, `/api/workspaces/${encodeURIComponent('session-not-a-workspace')}`, { method: 'DELETE' })
    assert.equal(gone.status, 404, 'and an unknown workspace is not found')
  } finally {
    await server.close()
    removeDir(loose)
    removeDir(parent)
  }
})

test('the page can register a workspace with its own control', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('page')
  const wanted = fixtureDir('workspaces-clicked')
  const browser = await openBrowser()
  try {
    mkdirSync(wanted, { recursive: true })
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("tree") !== null', 10_000)

    /**
     * The `+` asks the **server** for the platform's folder dialog, and this check answers that request
     * rather than a person: a real dialog cannot be driven from a check, but the decision the page makes
     * about the answer can be. Two answers are judged, because they are the two a person produces —
     * a cancel mounts nothing, and a path mounts that path.
     */
    await browser.evaluate(`(() => {
      window.__picked = { kind: 'cancelled' }
      const real = window.fetch
      window.fetch = async (input, init) => {
        if (String(input).includes('/api/workspaces/pick')) {
          return new Response(JSON.stringify(window.__picked), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return real(input, init)
      }
    })()`)
    await browser.evaluate('document.getElementById("add-workspace").click()')
    await new Promise((resolve) => setTimeout(resolve, 600))
    const afterCancel = await browser.evaluate('document.querySelectorAll("#tree .row").length')
    assert.equal(afterCancel, 0, 'a cancelled dialog mounts nothing')

    await browser.evaluate(`window.__picked = { kind: 'picked', path: ${JSON.stringify(wanted)} }`)
    await browser.evaluate('document.getElementById("add-workspace").click()')
    const appeared = await browser.waitFor(`document.getElementById("tree").innerText.includes(${JSON.stringify(wanted.split('/').filter(Boolean).pop())})`, 10_000)
    assert.ok(appeared, 'the folder the person named appears in the tree')

    const label = wanted.split('/').filter(Boolean).pop()
    const rows = await browser.evaluate('document.querySelectorAll("#tree .row").length')
    assert.ok(rows > 0, `the tree drew rows (${rows})`)
    assert.ok(
      await browser.evaluate(`Array.from(document.querySelectorAll("#tree .row")).some((row) => row.innerText.includes(${JSON.stringify(label)}))`),
      'including the one just registered',
    )

    /**
     * And unregistering it from that row's actions takes the row away.
     *
     * The control is a menu rather than a button of its own, so the check opens the menu and picks the
     * item by its **label**: which control a person uses is a design decision that has already changed
     * once, and an assertion on a class name would fail on the next change without anything being
     * wrong. What is being judged is the capability.
     */
    await browser.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('#tree .row')).find((entry) => entry.innerText.includes(${JSON.stringify(label)}))
      row.querySelector('[aria-haspopup]')?.click()
    })()`)
    await browser.waitFor(
      `Array.from(document.querySelectorAll('#tree [role=menuitem]')).some((item) => item.textContent.trim() === 'Unregister')`,
      10_000,
    )
    await browser.evaluate(
      `Array.from(document.querySelectorAll('#tree [role=menuitem]')).find((item) => item.textContent.trim() === 'Unregister').click()`,
    )
    const vanished = await browser.waitFor(
      `!Array.from(document.querySelectorAll('#tree .row')).some((row) => row.innerText.includes(${JSON.stringify(label)}))`,
      10_000,
    )
    assert.ok(vanished, 'and unregistering it takes the row away')
  } finally {
    browser.close()
    await server.close()
    removeDir(wanted)
  }
})
