import assert from 'node:assert/strict'
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The left column's workspace controls — add, rename, delete — judged over HTTP and then in a browser.
 *
 * The claim is the one the owner asked for (11 Oct, and on 29 Oct "ensure add, remove, rename workspace all works …
 * function parity" with DSH): a person can register a folder as a workspace, rename it and delete it **from the
 * page**, and the tree separates the folders they chose from the folders that were adopted because a session
 * happened to run in them.
 *
 * Two layers are judged deliberately. The routes are judged over HTTP because that is where the rules live — a path
 * must be absolute and exist, a name must be a slug, a rename may not take another workspace's name (DSH's
 * `workspace/name-conflict`), and deleting a workspace removes the registration only, its sessions moving to the
 * root above or to Ungrouped (DSH's Delete workspace). The page is judged in a browser because the controls are the
 * request: a route that works while the button does not is the failure this check exists for — and on 29 Oct the
 * button did not, for any browser on another machine, because it asked the server for a dialog on its own screen.
 */

const CAPABILITY = 'the Web UI'

/** A run whose server prints its URL, and the home it is isolated in. */
async function startServer(label, options = {}) {
  const home = isolatedHome(`workspaces-${label}`)
  const work = fixtureDir(`workspaces-${label}-work`)
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  /**
   * `HOME` is the fixture's own when asked for: the folder chooser opens at the account's home, and a check has no
   * business listing the real one.
   */
  const child = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config, ...(options.home !== undefined ? { HOME: options.home } : {}) } },
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
      }, 15_000).unref()
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

test('a workspace is registered, renamed and deleted over the API the controls call', async (context) => {
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

    // Rename: DSH's rules — trimmed, never blank, never another workspace's name, the current name a no-op.
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: parent }) })
    const parentName = parent.split('/').filter(Boolean).pop()
    const renamed = await api(server.url, cookie, `/api/workspaces/${encodeURIComponent(loose)}`, { method: 'PATCH', body: JSON.stringify({ title: '  Loose Work  ' }) })
    assert.equal(renamed.status, 200, `a workspace is renamed (${JSON.stringify(renamed.body)})`)
    assert.equal(renamed.body.title, 'Loose Work', 'to the trimmed name')
    const clash = await api(server.url, cookie, `/api/workspaces/${encodeURIComponent(loose)}`, { method: 'PATCH', body: JSON.stringify({ title: parentName }) })
    assert.equal(clash.status, 409, `another workspace's name is refused (${JSON.stringify(clash.body)})`)
    assert.equal(clash.body.code, 'workspace/name-conflict', "with DSH's code")
    assert.equal(clash.body.error, `A workspace named “${parentName}” already exists.`, "and DSH's sentence")
    const unchanged = await api(server.url, cookie, `/api/workspaces/${encodeURIComponent(loose)}`, { method: 'PATCH', body: JSON.stringify({ title: 'Loose Work' }) })
    assert.equal(unchanged.status, 200, 'the current name is not a clash with itself')
    const blank = await api(server.url, cookie, `/api/workspaces/${encodeURIComponent(loose)}`, { method: 'PATCH', body: JSON.stringify({ title: ' ' }) })
    assert.equal(blank.status, 400, 'a blank name is refused')

    /**
     * Delete: the registration goes even while a session is under it — DSH's Delete workspace, which keeps the folder
     * and the session and shows the session under Ungrouped. It used to be refused (`409 … still holds 1 session`),
     * because the folder tree drew the root `bootstrap` adopts again; the workspace tree draws an adopted root as
     * Ungrouped, so the removal holds where a person looks.
     */
    const busy = await api(server.url, cookie, `/api/workspaces/${encodeURIComponent(loose)}`, { method: 'DELETE' })
    assert.equal(busy.status, 200, `a workspace that still holds a session is deleted (${JSON.stringify(busy.body)})`)
    assert.equal(busy.body.ownedSessions, 1, 'and it says how many sessions it held')
    assert.equal(busy.body.adoptedBy, undefined, 'with no root above to take them')
    const views = (await api(server.url, cookie, '/api/workspaces')).body.workspaces ?? []
    assert.ok(!views.some((view) => view.path === loose), 'it is gone from the workspace list')
    const sessions = (await api(server.url, cookie, '/api/sessions')).body
    assert.ok(Array.isArray(sessions) && sessions.length === 1, 'and its session still exists, under Ungrouped')

    // With a root above it, the sessions have somewhere to go, and the answer says where.
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: child, name: 'inner' }) })
    const inner = await api(server.url, cookie, '/api/sessions', { method: 'POST', body: JSON.stringify({ branch: child }) })
    assert.equal(inner.status, 200, `a session starts in the inner workspace (${JSON.stringify(inner.body)})`)
    const removed = await api(server.url, cookie, `/api/workspaces/${encodeURIComponent(child)}`, { method: 'DELETE' })
    assert.equal(removed.status, 200, `a root with a parent above it is removed (${JSON.stringify(removed.body)})`)
    assert.equal(removed.body.adoptedBy, parentName, 'and it says where its sessions went')

    const gone = await api(server.url, cookie, `/api/workspaces/${encodeURIComponent('session-not-a-workspace')}`, { method: 'DELETE' })
    assert.equal(gone.status, 404, 'and an unknown workspace is not found')
  } finally {
    await server.close()
    removeDir(loose)
    removeDir(parent)
  }
})

test('the folder chooser lists and creates folders over the API it calls', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  /**
   * DSH's browse backend, which the page's *Select Workspace Directory* dialog is drawn from: one level of folders —
   * directories only, name-sorted, links to folders followed, dot-names marked hidden, crumbs to the root — the home
   * folder when no path is named, and one new child folder at a time. Refusals carry DSH's codes.
   */
  const place = fixtureDir('workspaces-chooser')
  const server = await startServer('chooser', { home: place })
  try {
    for (const name of ['beta', 'Alpha', '.dot']) mkdirSync(join(place, name), { recursive: true })
    writeFileSync(join(place, 'a-file.txt'), 'not a folder\n')
    symlinkSync(join(place, 'beta'), join(place, 'link-to-beta'))
    symlinkSync(join(place, 'nowhere'), join(place, 'broken-link'))
    const cookie = await cookieFor(server.url)
    const real = realpathSync(place)

    const listed = await api(server.url, cookie, `/api/directories?path=${encodeURIComponent(place)}`)
    assert.equal(listed.status, 200, `a folder is listed (${JSON.stringify(listed.body)})`)
    assert.equal(listed.body.path, real, 'under its canonical path')
    assert.deepEqual(listed.body.entries.map((entry) => entry.name), ['.dot', 'Alpha', 'beta', 'link-to-beta'], 'folders only, sorted, links to folders followed')
    assert.deepEqual(listed.body.entries.map((entry) => entry.hidden), [true, false, false, false], 'a dot-name is marked hidden')
    assert.equal(listed.body.entries[1].path, join(real, 'Alpha'), 'each with its path')
    assert.equal(listed.body.parent, dirname(real), 'with the folder above')
    assert.equal(listed.body.crumbs[0].path, '/', 'and crumbs from the root')
    assert.equal(listed.body.crumbs.at(-1).path, real, 'to the folder itself')
    assert.equal(listed.body.truncated, false)
    const home = await api(server.url, cookie, '/api/directories')
    assert.equal(home.body.path, real, 'no path lists the home folder')
    assert.equal(home.body.home, real, 'and the answer names it')
    for (const [what, path] of [['a relative path', 'not/absolute'], ['a folder that does not exist', join(place, 'nope')], ['a file', join(place, 'a-file.txt')]]) {
      const refused = await api(server.url, cookie, `/api/directories?path=${encodeURIComponent(path)}`)
      assert.equal(refused.status, 400, `${what} is refused`)
      assert.equal(refused.body.code, 'directory-picker/unreadable', `with DSH's code for ${what}`)
    }

    const made = await api(server.url, cookie, '/api/directories', { method: 'POST', body: JSON.stringify({ parent: place, name: 'made-here' }) })
    assert.equal(made.status, 200, `a child folder is created (${JSON.stringify(made.body)})`)
    assert.equal(made.body.path, join(real, 'made-here'), 'and its path comes back')
    assert.ok(existsSync(join(place, 'made-here')), 'it is on disk')
    const twice = await api(server.url, cookie, '/api/directories', { method: 'POST', body: JSON.stringify({ parent: place, name: 'made-here' }) })
    assert.equal(twice.status, 409, 'creating it again is a conflict')
    assert.equal(twice.body.code, 'directory-picker/exists')
    for (const name of ['', '..', 'a/b']) {
      const refused = await api(server.url, cookie, '/api/directories', { method: 'POST', body: JSON.stringify({ parent: place, name }) })
      assert.equal(refused.status, 400, `the name ${JSON.stringify(name)} is refused: one segment only`)
      assert.equal(refused.body.code, 'directory-picker/create-failed')
    }
    const orphan = await api(server.url, cookie, '/api/directories', { method: 'POST', body: JSON.stringify({ parent: join(place, 'nope'), name: 'x' }) })
    assert.equal(orphan.status, 400, 'a missing parent is not invented')
  } finally {
    await server.close()
    removeDir(place)
  }
})

test('the page adds, renames and deletes a workspace with its own dialogs', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * Every step goes through a control a person uses, and nothing is stubbed: *Add workspace* opens the page's own
   * folder chooser (the server's dialog is not asked for — that is what failed for a browser on another machine),
   * a typed path is opened, a crumb goes back, *New folder* makes one, a row enters a folder, and *Add workspace*
   * registers it; the row is there at once and after a reload; its `+` starts a session in it; *Rename* refuses
   * another workspace's name and saves a new one; *Delete workspace* says what is kept, and the session it held then
   * shows under Ungrouped.
   */
  const place = fixtureDir('workspaces-dialogs')
  const server = await startServer('dialogs', { home: place })
  const wanted = join(place, 'picked')
  const other = join(place, 'other')
  const browser = await openBrowser({ width: 1400, height: 900 })
  const row = (label) => `Array.from(document.querySelectorAll('#tree li[data-kind=workspace] > .row')).find((entry) => entry.querySelector('.label')?.textContent === ${JSON.stringify(label)})`
  const type = (id, value) => `(() => { const input = document.getElementById(${JSON.stringify(id)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })) })()`
  const listed = (path) => `Array.from(document.querySelectorAll('#workspace-picker-list button')).find((entry) => entry.dataset.path === ${JSON.stringify(path)})`
  const menu = (label, item) => [
    `${row(label)}.querySelector('[aria-haspopup]').click()`,
    `Array.from(document.querySelectorAll('#tree .menu:not([hidden]) [role=menuitem]')).find((entry) => entry.textContent.trim() === ${JSON.stringify(item)}).click()`,
  ]
  try {
    mkdirSync(wanted, { recursive: true })
    mkdirSync(other, { recursive: true })
    const real = realpathSync(place)
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: other }) })
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("tree") !== null', 10_000)
    await browser.waitFor(`${row('other')} !== undefined`, 10_000)

    await browser.evaluate('document.getElementById("add-workspace").click()')
    assert.ok(
      await browser.waitFor(`document.getElementById('workspace-picker').open && ${listed(join(real, 'picked'))} !== undefined`, 10_000),
      'Add workspace opens the folder chooser at the home folder',
    )
    await browser.evaluate('document.querySelector("#workspace-picker [data-ws-close]").click()')
    assert.equal(await browser.evaluate(`document.getElementById('workspace-picker').open`), false, 'closing it adds nothing')
    assert.equal(await browser.evaluate(`document.querySelectorAll('#tree li[data-kind=workspace]').length`), 1, 'the tree is as it was')

    await browser.evaluate('document.getElementById("add-workspace").click()')
    await browser.waitFor(`document.getElementById('workspace-picker').open && document.querySelectorAll('#workspace-picker-list button').length > 0`, 10_000)
    await browser.evaluate(type('workspace-picker-path', join(place, 'nope')))
    await browser.evaluate(`document.getElementById('workspace-picker-form').requestSubmit()`)
    assert.ok(await browser.waitFor(`!document.getElementById('workspace-picker-error').hidden`, 10_000), 'a typed folder that does not exist is refused in the dialog')
    await browser.evaluate(type('workspace-picker-path', wanted))
    await browser.evaluate(`document.getElementById('workspace-picker-form').requestSubmit()`)
    await browser.waitFor(`document.getElementById('workspace-picker-path').value === ${JSON.stringify(join(real, 'picked'))}`, 10_000)
    await browser.evaluate(`Array.from(document.querySelectorAll('#workspace-picker-crumbs button')).find((entry) => entry.title === ${JSON.stringify(real)}).click()`)
    assert.ok(await browser.waitFor(`${listed(join(real, 'picked'))} !== undefined`, 10_000), 'a crumb goes back up')
    await browser.evaluate(`document.getElementById('workspace-picker-new-folder').click()`)
    await browser.evaluate(type('workspace-picker-new-name', 'made-in-dialog'))
    await browser.evaluate(`document.getElementById('workspace-picker-new').requestSubmit()`)
    assert.ok(
      await browser.waitFor(`document.getElementById('workspace-picker-path').value === ${JSON.stringify(join(real, 'made-in-dialog'))}`, 10_000),
      'New folder makes a folder and opens it',
    )
    assert.ok(existsSync(join(place, 'made-in-dialog')), 'on disk')
    await browser.evaluate(`Array.from(document.querySelectorAll('#workspace-picker-list button')).find((entry) => entry.textContent === '..').click()`)
    await browser.waitFor(`${listed(join(real, 'picked'))} !== undefined`, 10_000)
    await browser.evaluate(`${listed(join(real, 'picked'))}.click()`)
    await browser.waitFor(`document.getElementById('workspace-picker-path').value === ${JSON.stringify(join(real, 'picked'))}`, 10_000)
    await browser.evaluate(`document.getElementById('workspace-picker-add').click()`)
    assert.ok(
      await browser.waitFor(`!document.getElementById('workspace-picker').open && ${row('picked')} !== undefined`, 10_000),
      'Add workspace registers the folder on screen and the tree shows it without a reload',
    )
    const views = (await api(server.url, cookie, '/api/workspaces')).body.workspaces ?? []
    assert.ok(views.some((view) => view.path === join(real, 'picked') && view.origin === 'added'), 'it is a registered workspace')

    await browser.goto(server.url.split('?')[0])
    await browser.waitFor('document.getElementById("tree") !== null', 10_000)
    assert.ok(await browser.waitFor(`${row('picked')} !== undefined`, 10_000), 'and it is still there after a reload')

    await browser.evaluate(`Array.from(${row('picked')}.querySelectorAll('button')).find((entry) => entry.getAttribute('aria-label') === 'New session in picked').click()`)
    assert.ok(
      await browser.waitFor(`${row('picked')}.closest('li').querySelectorAll('li[data-kind=session]').length === 1`, 10_000),
      'its + starts a session in it',
    )
    const sessionId = await browser.evaluate(`${row('picked')}.closest('li').querySelector('li[data-kind=session]').dataset.sessionId`)

    const [openMenu, pickRename] = menu('picked', 'Rename')
    await browser.evaluate(openMenu)
    const items = JSON.parse(await browser.evaluate(`JSON.stringify(Array.from(document.querySelectorAll('#tree .menu:not([hidden]) [role=menuitem]')).map((entry) => entry.textContent.trim()))`))
    assert.deepEqual(items, ['New session', 'Rename', 'Delete workspace'], `the workspace menu carries DSH's items\nsaw: ${items.join(', ')}`)
    await browser.evaluate(pickRename)
    await browser.waitFor(`document.getElementById('workspace-rename').open`, 10_000)
    assert.equal(await browser.evaluate(`document.getElementById('workspace-rename-input').value`), 'picked', 'Rename starts from the current name')
    assert.equal(await browser.evaluate(`document.getElementById('workspace-rename-confirm').disabled`), true, 'which cannot be confirmed unchanged')
    await browser.evaluate(type('workspace-rename-input', 'other'))
    assert.equal(await browser.evaluate(`document.getElementById('workspace-rename-confirm').disabled`), true, "another workspace's name cannot be confirmed")
    assert.equal(await browser.evaluate(`document.getElementById('workspace-rename-error').textContent`), 'A workspace named “other” already exists.', 'and the dialog says why')
    await browser.evaluate(type('workspace-rename-input', 'Picked Renamed'))
    await browser.evaluate(`document.getElementById('workspace-rename-confirm').click()`)
    assert.ok(
      await browser.waitFor(`!document.getElementById('workspace-rename').open && ${row('Picked Renamed')} !== undefined`, 10_000),
      'a new name is saved and drawn',
    )

    const [openAgain, pickDelete] = menu('Picked Renamed', 'Delete workspace')
    await browser.evaluate(openAgain)
    await browser.evaluate(pickDelete)
    await browser.waitFor(`document.getElementById('workspace-delete').open`, 10_000)
    assert.equal(
      await browser.evaluate(`document.getElementById('workspace-delete-desc').textContent`),
      'This removes “Picked Renamed” from the workspace list. The folder and session logs will be kept. Its sessions will appear under Ungrouped.',
      "Delete workspace asks first, in DSH's words",
    )
    await browser.evaluate(`document.querySelector('#workspace-delete [data-ws-close]').click()`)
    assert.ok(await browser.evaluate(`${row('Picked Renamed')} !== undefined`), 'cancelling keeps it')
    await browser.evaluate(openAgain)
    await browser.evaluate(pickDelete)
    await browser.waitFor(`document.getElementById('workspace-delete').open`, 10_000)
    await browser.evaluate(`document.getElementById('workspace-delete-confirm').click()`)
    assert.ok(
      await browser.waitFor(`!document.getElementById('workspace-delete').open && ${row('Picked Renamed')} === undefined`, 10_000),
      'confirming takes the row away',
    )
    assert.ok(
      await browser.waitFor(`document.querySelector('#tree li[data-kind=ungrouped]') !== null`, 10_000),
      'and its session shows under Ungrouped',
    )
    const after = (await api(server.url, cookie, '/api/sessions')).body
    assert.ok(Array.isArray(after) && after.some((meta) => meta.id === sessionId), 'the session itself is kept')
    assert.ok(existsSync(wanted), 'and so is the folder')
  } finally {
    browser.close()
    await server.close()
    removeDir(place)
  }
})

test('⌥⌘O opens Add workspace\'s folder chooser, as DSH\'s workspace.add shortcut does', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH binds `workspace.add` to `KeyO` with primary+alt on the Web (dsh-client-ui-workspace `client.js:133`) and labels
   * its control with `aria-keyshortcuts` (`client.js:3917`). A Mac sends ⌥⌘O as `key: 'ø'`, `code: 'KeyO'`, so the
   * press is the physical key, as DSH's registry matches it. Phase A pressed ⌥⌘O on this page and nothing happened.
   */
  const place = fixtureDir('workspaces-shortcut')
  const server = await startServer('shortcut', { home: place })
  const browser = await openBrowser({ width: 1400, height: 900 })
  const press = (init) => `document.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ bubbles: true, cancelable: true, ...init })}))`
  try {
    mkdirSync(join(place, 'picked'), { recursive: true })
    const real = realpathSync(place)
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    assert.equal(await browser.evaluate(`document.getElementById('add-workspace').getAttribute('aria-keyshortcuts')`), 'Alt+Meta+O', 'the + names its chord')

    await browser.evaluate(press({ key: 'o', code: 'KeyO', metaKey: true }))
    assert.equal(await browser.evaluate(`document.getElementById('workspace-picker').open`), false, '⌘O alone is not the chord')

    await browser.evaluate(press({ key: 'ø', code: 'KeyO', metaKey: true, altKey: true }))
    assert.ok(
      await browser.waitFor(`document.getElementById('workspace-picker').open && Array.from(document.querySelectorAll('#workspace-picker-list button')).some((entry) => entry.dataset.path === ${JSON.stringify(join(real, 'picked'))})`, 10_000),
      '⌥⌘O opens the folder chooser at the home folder',
    )
    await browser.evaluate(`document.querySelector('#workspace-picker [data-ws-close]').click()`)
    assert.equal(await browser.evaluate(`document.getElementById('workspace-picker').open`), false, 'and it closes as the + one does')
  } finally {
    browser.close()
    await server.close()
    removeDir(place)
  }
})
