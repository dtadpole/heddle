import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { boot, failedEntries, settle } from '../src/boot.ts'

/**
 * The shipped profile's allow list keeps every tool its rows register (R-developer-nine-11, measured on 2026-10-29).
 *
 * `heddle tools` and `heddle --turn` apply the tools row's allow list; `heddle web` applies none. The list omitted
 * `create_goal`, `get_goal`, `update_goal`, `todo_write` and `todo_read`, so the command line hid the goal and todo
 * verbs while a web turn offered them. The registry is asked both questions here — what it holds (a web turn's
 * offer) and what is left after the list (the command line's) — on the profile booted in process.
 *
 * Every store is a scratch directory, and the model row reads no endpoint file.
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'heddle-tool-allow-list-'))
process.env.HOME = scratch
process.env.HEDDLE_HOME = scratch

after(() => rmSync(scratch, { recursive: true, force: true }))

/** The shipped profile's tree, errors only so its boot lines stay out of the runner's own stdout. */
async function bootShippedProfile() {
  return boot({
    base: join(repoRoot, 'cordis.yml'),
    includeProjectPatch: true,
    configDir: repoRoot,
    logLevel: 0,
    overrides: [
      {
        patch: [
          { id: 'session', config: { root: join(scratch, 'sessions') } },
          { id: 'sandbox', config: { workspaceRoot: scratch } },
          { id: 'model', config: { readLocalConfig: false } },
        ],
      },
    ],
  })
}

test("the shipped profile's allow list keeps every tool its rows register, so the command line offers what a web turn does", async () => {
  const app = await bootShippedProfile()
  try {
    assert.deepEqual(await settle(app.ctx), [], 'every row settled')
    assert.deepEqual(failedEntries(app.ctx), [], 'no row failed')
    const tools = app.ctx.tools
    // What a web turn offers: `heddle web` applies no allow list.
    const offeredByWeb = [...tools.names()]
    // What `heddle tools` lists and `heddle --turn` offers: the same registry after the list is applied.
    tools.filterTo(tools.allowList())
    const offeredByCommandLine = [...tools.names()]

    for (const name of ['create_goal', 'get_goal', 'update_goal', 'todo_write']) {
      assert.ok(offeredByCommandLine.includes(name), `${name} is offered by the command line; it offered ${offeredByCommandLine.join(', ')}`)
    }
    /**
     * Nothing else is hidden either, so a row that later registers a tool without naming it fails here. `todo_read`
     * is the one name allowed to differ: the todo-parity change removes the tool, and listing it would fail every
     * `--turn` the moment it is gone.
     */
    const hidden = offeredByWeb.filter((name) => !offeredByCommandLine.includes(name) && name !== 'todo_read')
    assert.deepEqual(hidden, [], 'every tool a web turn offers is on the allow list; add a new row’s tools to it in heddle.patch.yml')
    assert.deepEqual(tools.missing(), [], 'and the list names nothing that no row registers, which would fail a --turn')
  } finally {
    await app.dispose()
  }
})
