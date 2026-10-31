// The plugin inventory a signed-in page reads (GET /api/plugin-inventory) is DSH's read-only `pluginInventory/list`:
// every non-group row of the booted tree, in row order, with the module name the layer wrote, whether the row is
// enabled, and the phase its entry is in (`null` when it has none). A disabled row is listed disabled, a row whose
// start refused is listed failed, and nothing in the answer offers to manage plugins or names a path the
// configuration did not hold. Runs against whichever harness HEDDLE_BIN names, or the TypeScript build.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { heddleCommand, isolatedHome, removeDir, repoRoot } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A profile that is the shipped tree with its row names left relative (`./src/plugins/session.ts`), so the check can
 * see whether the answer reports the name as written or the path the loader resolved it to. The profile's own `src`
 * is a link to the checkout's, so the rows start as they do from the checkout. Its patch then disables `goal-tool`,
 * gives `todo-tool` a configuration its schema refuses, and moves the session store into the scratch home.
 */
function scratchProfile(home) {
  const profile = join(home, 'inventory-profile')
  mkdirSync(profile, { recursive: true })
  symlinkSync(join(repoRoot, 'src'), join(profile, 'src'))
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8')
  const ids = [...tree.matchAll(/^\s+- id: (\S+)$/gm)].map((match) => match[1])
  writeFileSync(
    join(profile, 'heddle.patch.yml'),
    `${tree}
- patch:
    - id: goal-tool
      disabled: true
    - id: todo-tool
      config:
        allowParallelInProgress: "yes"
    - id: session
      config:
        root: ${join(home, 'sessions')}
`,
  )
  return { profile, ids }
}

function startServer(args, env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(['web', '--port', '0', ...args]), {
        cwd: env.HOME,
        env: { ...process.env, NO_COLOR: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /(http:\/\/127\.0\.0\.1:\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ base: match[1], token: match[2], kill: () => child.kill('SIGKILL'), output: () => output })
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
          reject(new Error(`the server printed no URL within 20s\n${output}`))
        }
      }, 20_000).unref()
    })()
  })
}

async function call(server, method, path, options = {}) {
  const query = options.token === false ? '' : `?token=${server.token}`
  const response = await fetch(`${server.base}${path}${query}`, { method })
  const text = await response.text()
  let parsed = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: response.status, text, body: parsed }
}

test('the inventory lists every row as written, enabled or not, with the phase its entry is in', async () => {
  const home = isolatedHome('plugin-inventory')
  let server
  try {
    const { profile, ids } = scratchProfile(home)
    assert.ok(ids.includes('session') && ids.includes('goal-tool') && ids.includes('todo-tool'), `the shipped tree has the rows the check patches\n${ids.join(', ')}`)
    const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: join(home, 'heddle.json') }
    server = await startServer(['--profile', profile, '--sandbox-root', home], env)

    const listing = await call(server, 'GET', '/api/plugin-inventory')
    assert.equal(listing.status, 200, `the route answers\n${listing.text.slice(0, 300)}\n${server.output().slice(-600)}`)
    assert.deepEqual(Object.keys(listing.body), ['entries'], 'only the entries: no managementAvailable, because nothing here can change the profile')
    const entries = listing.body.entries
    assert.deepEqual(entries.map((entry) => entry.entryId), ids, 'one entry per row, in the order the tree declares them')
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry).sort(), ['enabled', 'entryId', 'fiberPhase', 'moduleName'], `the entry carries DSH's four fields\n${JSON.stringify(entry)}`)
      assert.match(entry.moduleName, /^\.\/src\/[a-z/-]+\.ts$/, `the module name is the one the layer wrote, not a resolved path\n${JSON.stringify(entry)}`)
    }
    const byId = Object.fromEntries(entries.map((entry) => [entry.entryId, entry]))
    assert.deepEqual(byId.session, { entryId: 'session', moduleName: './src/plugins/session.ts', enabled: true, fiberPhase: 'active' })
    assert.deepEqual(byId['goal-tool'], { entryId: 'goal-tool', moduleName: './src/plugins/goal-tool.ts', enabled: false, fiberPhase: null }, 'a disabled row is listed, disabled, with no phase')
    assert.deepEqual(byId['todo-tool'], { entryId: 'todo-tool', moduleName: './src/plugins/todo-tool.ts', enabled: true, fiberPhase: 'failed' }, 'a row whose start refused is listed failed')
    const others = entries.filter((entry) => entry.entryId !== 'goal-tool' && entry.entryId !== 'todo-tool')
    assert.deepEqual(others.filter((entry) => !entry.enabled || entry.fiberPhase !== 'active'), [], 'every other row is enabled and active')

    for (const [label, value] of [['the scratch home', home], ['the checkout', repoRoot], ['a file URL', 'file://']]) {
      assert.equal(listing.text.includes(value), false, `no ${label} reaches the page`)
    }

    const unsigned = await call(server, 'GET', '/api/plugin-inventory', { token: false })
    assert.equal(unsigned.status, 401, 'the inventory is behind the door like every other route')
    const posted = await call(server, 'POST', '/api/plugin-inventory')
    assert.equal(posted.status, 404, 'it is read-only: another method is the plain 404 every unknown route answers')
  } finally {
    server?.kill()
    removeDir(home)
  }
})
