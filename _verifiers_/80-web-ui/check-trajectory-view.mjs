import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/check-helpers/browser.mjs'
import { fixtureDir, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/check-helpers/lib.mjs'

/**
 * The Trajectory area, judged where the owner will look at it: in a browser.
 *
 * The reference is DSH's own Trajectory tab, measured and written down in
 * `_context_/dsh-mechanisms/dsh-trajectory-ui.md`: one dense table row per event, a 122px event column
 * and 30px rows at a 12px font, kind tags in DSH's colours, a turn rail and turn labels in the gutter,
 * **one row per tool call carrying its arguments and its result**, a right details pane with tabs, a
 * toolbar with the duration mode / collapse switches / search, and a lane timeline with drag-to-focus.
 *
 * This is the part a unit test cannot judge: the projection can be right and the page can still draw two
 * rows for one call, no details pane, or a table that does not resize. So the check drives a real
 * tool-calling turn through the scripted endpoint and then inspects what the page actually drew.
 */

const CAPABILITY = 'the Web UI'

async function startServer(label) {
  const home = isolatedHome(`trajectory-${label}`)
  const work = fixtureDir(`trajectory-${label}-work`)
  const { config } = scriptedConfig({
    home,
    steps: [{ toolCall: { name: 'list_dir', arguments: { path: work } } }, { text: 'the folder holds two files' }, { text: 'second answer' }],
  })
  mkdirSync(work, { recursive: true })
  const child = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config }, cwd: work },
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

function startCli(args, options) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(process.execPath, [join(repoRoot, 'dist', 'cli.js'), ...args], {
        cwd: options.cwd ?? repoRoot,
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

async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

async function api(url, cookie, path, init = {}) {
  const response = await fetch(new URL(path, url), {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

test('the Trajectory area reads like DSH: one row per event, one row per call, a details pane', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('table')
  const browser = await openBrowser({ width: 1440, height: 1000 })
  try {
    writeFileSync(join(server.work, 'a.txt'), 'one\n')
    writeFileSync(join(server.work, 'b.txt'), 'two\n')
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    const opened = await api(server.url, cookie, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work }) })
    const session = opened.body.session?.id ?? opened.body.id
    for (const prompt of ['what is in here', 'and again']) {
      const turn = await fetch(new URL('/api/turn', server.url), {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, folder: server.work, session }),
      })
      assert.equal(turn.status, 200, `the turn ran (${turn.status})`)
      await turn.text()
    }

    const view = await api(server.url, cookie, `/api/sessions/${encodeURIComponent(session)}?view=ledger`)
    assert.equal(view.status, 200, 'the ledger reads back')
    const rows = view.body.rows ?? []
    assert.ok(rows.length > 0, 'the projection travels with the ledger')
    const toolRows = rows.filter((row) => row.kind === 'tool')
    /**
     * The scripted endpoint replays its steps for each turn, so two prompts carry two tool calls. The claim
     * is that **each call is one row carrying its result** — four rows would be the unmerged shape — not
     * that the session has one call.
     */
    assert.equal(toolRows.length, 2, `two calls, two rows, not four\nsaw: ${rows.map((row) => [row.turn, row.step, row.kind, row.record.label].join('|')).join(' / ')}`)
    assert.ok(toolRows.every((row) => row.record.name === 'list_dir'), 'each row names its tool')
    assert.ok(toolRows.every((row) => String(row.record.result).includes('a.txt')), 'and each carries its result')
    assert.equal(rows.filter((row) => row.turnStart).length, 2, 'two prompts, two turn boundaries')

    await browser.goto(server.url)
    assert.ok(await browser.waitFor('document.querySelector(\'#views button[data-view="trajectory"]\') !== null', 20_000), 'the page loaded')
    const drawn = JSON.parse(
      await browser.evaluate(`(() => {
        document.querySelector('#views button[data-view="trajectory"]').click()
        return JSON.stringify({ clicked: true })
      })()`),
    )
    assert.ok(drawn.clicked)
    assert.ok(await browser.waitFor('document.querySelectorAll("#tr-table tbody tr").length > 0', 20_000), 'the table drew rows')

    const state = JSON.parse(
      await browser.evaluate(`(() => {
        const rows = [...document.querySelectorAll('#tr-table tbody tr')]
        const tool = rows.find((row) => row.dataset.kind === 'tool')
        return JSON.stringify({
          rows: rows.length,
          turnStarts: rows.filter((row) => row.dataset.turnStart === 'true').length,
          toolRows: rows.filter((row) => row.dataset.kind === 'tool').length,
          toolRowsWithResult: rows.filter((row) => row.dataset.kind === 'tool' && (row.querySelector('.tr-result')?.textContent ?? '') !== '').length,
          toolRowHeight: getComputedStyle(rows.find((row) => row.dataset.kind === 'tool')).height,
          toolName: tool?.querySelector('.tr-name')?.textContent ?? '',
          toolArgs: tool?.querySelector('.tr-args')?.textContent ?? '',
          toolResult: tool?.querySelector('.tr-result')?.textContent ?? '',
          lanes: document.querySelectorAll('#timeline .tr-lane').length,
          toolbarVisible: !document.getElementById('tr-toolbar').hidden,
          kinds: [...new Set(rows.map((row) => row.dataset.kind))],
          eventCol: getComputedStyle(document.querySelector('#tr-table th.tr-th-event')).width,
          rowHeight: getComputedStyle(document.querySelector('#tr-table tbody tr')).height,
          tableFont: getComputedStyle(document.querySelector('#tr-table')).fontSize,
        })
      })()`),
    )
    assert.equal(state.turnStarts, 2, 'a turn rail and label per prompt')
    assert.equal(state.toolRows, 2, 'the page draws one row per call, not one per half')
    assert.equal(state.toolRowsWithResult, 2, 'each of them carrying a result preview')
    assert.equal(state.toolName, 'list_dir', 'the row names the tool')
    assert.match(state.toolArgs, /path/, 'with its arguments in the request column')
    assert.match(state.toolResult, /a\.txt/, 'and its result in the result column')
    assert.equal(state.lanes, 3, 'the timeline has Input, Model and Tools lanes, as DSH does')
    assert.ok(state.toolbarVisible, 'and the toolbar is showing')
    assert.ok(state.kinds.includes('user') && state.kinds.includes('assistant'), `user and assistant rows are drawn\nsaw: ${state.kinds.join(', ')}`)
    assert.equal(state.eventCol, '122px', 'the event column is DSH’s 122px')
    assert.equal(state.rowHeight, '30px', 'the rows are DSH’s 30px')
    assert.equal(state.toolRowHeight, '30px', 'including the tool row — one line, as DSH draws it')
    assert.equal(state.tableFont, '12px', 'at DSH’s 12px table font')

    // Clicking the call examines it: the details pane with DSH's tabs, and the full result on Result.
    await browser.evaluate(`([...document.querySelectorAll('#tr-table tbody tr')].find((row) => row.dataset.kind === 'tool')).click()`)
    assert.ok(await browser.waitFor('document.getElementById("tr-details") !== null && !document.getElementById("tr-details").hidden', 10_000), 'the details pane opened')
    const examined = JSON.parse(
      await browser.evaluate(`(() => {
        const tabs = [...document.querySelectorAll('#tr-details .tr-d-tab')]
        const resultTab = tabs.find((tab) => tab.textContent === 'Result')
        resultTab?.click()
        return JSON.stringify({
          tabs: tabs.map((tab) => tab.textContent),
          where: document.querySelector('#tr-details .tr-d-where')?.textContent ?? '',
          result: document.querySelector('#tr-details .tr-d-body')?.textContent ?? '',
        })
      })()`),
    )
    assert.deepEqual(examined.tabs, ['Summary', 'Payload', 'Result', 'Timing'], 'the details pane has DSH’s four tabs')
    assert.match(examined.where, /Turn \d+/, 'and says which turn the row belongs to')
    assert.match(examined.result, /a\.txt/, 'the Result tab shows what the tool answered in full')

    // The toolbar's two collapse switches and the search box, as DSH's.
    const collapsed = JSON.parse(
      await browser.evaluate(`(() => {
        document.getElementById('tr-turns').click()
        const rows = document.querySelectorAll('#tr-table tbody tr').length
        return JSON.stringify({ rows, pressed: document.getElementById('tr-turns').getAttribute('aria-pressed') })
      })()`),
    )
    assert.equal(collapsed.pressed, 'true')
    assert.ok(collapsed.rows < state.rows, 'collapsing turns keeps one summary row per turn')

    const searched = JSON.parse(
      await browser.evaluate(`(() => {
        document.getElementById('tr-turns').click()
        const search = document.getElementById('tr-search-input')
        search.value = 'a.txt'
        search.dispatchEvent(new Event('input', { bubbles: true }))
        return JSON.stringify({
          rows: document.querySelectorAll('#tr-table tbody tr').length,
          kinds: [...document.querySelectorAll('#tr-table tbody tr')].map((row) => row.dataset.kind),
        })
      })()`),
    )
    assert.equal(searched.rows, 2, 'search narrows the table to the matching rows')
    assert.deepEqual(searched.kinds, ['tool', 'tool'])

    await browser.evaluate(`(() => { const s = document.getElementById('tr-search-input'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    const evidence = join(repoRoot, '_context_', 'dsh-mechanisms', 'heddle-trajectory.png')
    await browser.screenshot(evidence)
    assert.ok(true, `a screenshot of the result is at ${evidence}`)
  } finally {
    browser.close()
    await server.close()
  }
})
