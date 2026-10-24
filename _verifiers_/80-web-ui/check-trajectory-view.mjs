import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { evidencePath, fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

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
      const child = spawn(...heddleCommand(args), {
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
      }, 15_000).unref()
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
    // The split bar, judged by the reference's feel and by actually resizing: a 6px band with a grip that
    // appears on drag, a real width change, a double-click reset and arrow keys.
    // The panes fill the window: no outer frame, no gap, and the divider overlays the boundary.
    const fill = JSON.parse(
      await browser.evaluate(`(() => {
        const aside = document.querySelector('aside').getBoundingClientRect()
        const main = document.querySelector('main').getBoundingClientRect()
        const gutter = document.getElementById('gutter-left').getBoundingClientRect()
        const body = getComputedStyle(document.body)
        return JSON.stringify({
          padding: body.padding,
          gap: body.gap,
          left: Math.round(aside.left),
          top: Math.round(aside.top),
          bottom: Math.round(aside.bottom),
          right: Math.round(aside.right),
          mainLeft: Math.round(main.left),
          mainBottom: Math.round(main.bottom),
          viewportHeight: innerHeight,
          gutterWidth: Math.round(gutter.width),
        })
      })()`),
    )
    assert.equal(fill.padding, '0px', 'the window has no outer frame')
    assert.equal(fill.gap, '0px', 'and no gap between the panes')
    assert.equal(fill.left, 0, 'the navigation pane starts at the window edge')
    assert.equal(fill.top, 0, 'at the top')
    assert.equal(fill.bottom, fill.viewportHeight, 'and fills to the bottom')
    assert.equal(fill.right, fill.mainLeft, "the panes meet, with the divider band over their boundary")
    assert.equal(fill.gutterWidth, 6, 'the band still has its 6px target')

    const idle = JSON.parse(
      await browser.evaluate(`(() => {
        const gutter = document.getElementById('gutter-left')
        const rect = gutter.getBoundingClientRect()
        return JSON.stringify({
          hitWidth: rect.width,
          cursor: getComputedStyle(gutter).cursor,
          band: getComputedStyle(gutter, '::before').opacity,
          grip: getComputedStyle(gutter, '::after').opacity,
        })
      })()`),
    )
    await browser.evaluate(`(() => {
      const gutter = document.getElementById('gutter-left')
      const rect = gutter.getBoundingClientRect()
      gutter.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: rect.left + 1, clientY: rect.top + 120, pointerId: 11 }))
    })()`)
    // The affordances fade in over 120ms; a computed style read mid-transition would see the old value. A fixed 250ms
    // wait read the band mid-fade under load (0.9836 and 0.9996 against the Rust binary, on main and on a candidate
    // alike), so the read waits, bounded, for both to settle. The assertions below still require exactly 1: a band
    // that never reaches it fails with the value it stopped at.
    await browser.waitFor(`(() => {
      const gutter = document.getElementById('gutter-left')
      return getComputedStyle(gutter, '::before').opacity === '1' && getComputedStyle(gutter, '::after').opacity === '1'
    })()`, 2_000)
    const draggingAffordance = JSON.parse(
      await browser.evaluate(`(() => {
        const gutter = document.getElementById('gutter-left')
        return JSON.stringify({
          band: getComputedStyle(gutter, '::before').opacity,
          grip: getComputedStyle(gutter, '::after').opacity,
          gripWidth: getComputedStyle(gutter, '::after').width,
          gripRadius: getComputedStyle(gutter, '::after').borderRadius,
        })
      })()`),
    )
    assert.equal(draggingAffordance.band, '1', 'dragging shows the band')
    assert.equal(draggingAffordance.grip, '1', 'and the grip')
    assert.equal(draggingAffordance.gripWidth, '2.5px', 'the grip is the reference’s 2.5px')
    assert.equal(draggingAffordance.gripRadius, '9999px', 'rounded, as the reference draws it')
    await browser.screenshot(evidencePath('heddle-split-bar.png'))
    const split = JSON.parse(
      await browser.evaluate(`(() => {
        const gutter = document.getElementById('gutter-left')
        const width = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'))
        const before = width()
        const rect = gutter.getBoundingClientRect()
        const idleBand = getComputedStyle(gutter, '::before').opacity
        gutter.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + 121, clientY: rect.top + 120, pointerId: 11 }))
        gutter.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: rect.left + 121, clientY: rect.top + 120, pointerId: 11 }))
        const afterDrag = width()
        gutter.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        const afterReset = width()
        gutter.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }))
        const afterKey = width()
        return JSON.stringify({ before, afterDrag, afterReset, afterKey, idleBand, hitWidth: rect.width, cursor: getComputedStyle(gutter).cursor })
      })()`),
    )
    assert.equal(idle.hitWidth, 6, 'the hit band is the reference’s 6px')
    assert.equal(idle.cursor, 'col-resize')
    assert.equal(idle.band, '0', 'the band is invisible until you are near it')
    assert.equal(idle.grip, '0', 'and so is the grip')
    assert.ok(split.afterDrag > split.before + 3, `dragging the bar resizes the sidebar (${split.before}rem to ${split.afterDrag}rem)`)
    assert.equal(split.afterReset, 22, 'a double-click restores the default width')
    assert.ok(split.afterKey < split.afterReset, 'and an arrow key nudges it from there')


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

    // Batch D: the toolbar, the search field and the lane strip, against DSH's measured numbers.
    const chrome = JSON.parse(
      await browser.evaluate(`(() => {
        const toolbar = document.getElementById('tr-toolbar')
        const button = toolbar.querySelector('button')
        const search = document.getElementById('tr-search')
        const input = document.getElementById('tr-search-input')
        const timeline = document.getElementById('timeline')
        const laneLabel = document.querySelector('.tr-lane-label')
        const style = (element) => getComputedStyle(element)
        return JSON.stringify({
          toolbarHeight: Math.round(toolbar.getBoundingClientRect().height),
          buttonRadius: style(button).borderRadius,
          buttonHeight: Math.round(button.getBoundingClientRect().height),
          buttonColor: style(button).color,
          searchHeight: Math.round(search.getBoundingClientRect().height),
          searchWidth: Math.round(input.getBoundingClientRect().width),
          timelineHeight: Math.round(timeline.getBoundingClientRect().height),
          laneLabel: { font: style(laneLabel).fontSize + '/' + style(laneLabel).fontWeight, color: style(laneLabel).color, transform: style(laneLabel).textTransform, spacing: style(laneLabel).letterSpacing },
        })
      })()`),
    )
    assert.equal(chrome.toolbarHeight, 28, 'the toolbar is DSH’s 28px tall')
    assert.equal(chrome.buttonRadius, '8px', 'its buttons are 8px rounded')
    assert.equal(chrome.buttonHeight, 20, 'at the 20px control height')
    assert.equal(chrome.buttonColor, 'rgb(173, 178, 184)', 'in DSH’s muted control colour')
    assert.equal(chrome.searchHeight, 18, 'the search field is DSH’s 18px tall')
    assert.equal(chrome.searchWidth, 149, 'and 149px wide')
    assert.ok(Math.abs(chrome.timelineHeight - 51) <= 5, `the lane strip is DSH’s 51px within the stated 5px tolerance (${chrome.timelineHeight}px)`)
    assert.equal(chrome.laneLabel.font, '10px/400', 'lane labels are DSH’s 10px/400')
    assert.equal(chrome.laneLabel.color, 'rgb(129, 133, 140)', 'in DSH’s muted label colour')
    assert.equal(chrome.laneLabel.transform, 'none', 'not uppercased')
    assert.equal(chrome.laneLabel.spacing, 'normal', 'and not letter-spaced')

    // Trusted hover, over CDP: DSH paints nothing on a trajectory row, and the check holds heddle to it.
    const rowPoint = JSON.parse(
      await browser.evaluate(`(() => {
        const rows = [...document.querySelectorAll('#tr-table tbody tr')]
        const row = rows.find((entry) => entry.querySelectorAll('td').length >= 2) ?? rows[0]
        const rect = row.querySelector('td').getBoundingClientRect()
        return JSON.stringify({ x: rect.left + 60, y: rect.top + rect.height / 2 })
      })()`),
    )
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(rowPoint.x), y: Math.round(rowPoint.y), button: 'none', buttons: 0, clickCount: 0 })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const hoverPaint = JSON.parse(
      await browser.evaluate(`(() => {
        const rows = [...document.querySelectorAll('#tr-table tbody tr')]
        const row = rows.find((entry) => entry.querySelectorAll('td').length >= 2) ?? rows[0]
        return JSON.stringify({ background: getComputedStyle(row).backgroundColor })
      })()`),
    )
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, button: 'none', buttons: 0, clickCount: 0 })
    assert.equal(hoverPaint.background, 'rgba(0, 0, 0, 0)', 'a hovered row paints nothing, as DSH does')

    // Kind tags, per element: DSH's measured 4px radius and palette, not an approximation.
    const tags = JSON.parse(
      await browser.evaluate(`(() => {
        const rows = [...document.querySelectorAll('#tr-table tbody tr')]
        const out = {}
        for (const row of rows) {
          const tag = row.querySelector('.tr-kind')
          if (tag === null || out[tag.dataset.kind] !== undefined) continue
          const style = getComputedStyle(tag)
          out[tag.dataset.kind] = {
            radius: style.borderRadius,
            color: style.color,
            background: style.backgroundColor,
            height: Math.round(tag.getBoundingClientRect().height),
            font: style.fontSize + '/' + style.fontWeight,
            spacing: style.letterSpacing,
            padding: style.padding,
          }
        }
        return JSON.stringify(out)
      })()`),
    )
    for (const [kind, expected] of Object.entries({
      user: { radius: '4px', color: 'rgb(122, 170, 255)', background: 'rgb(52, 65, 91)' },
      assistant: { radius: '4px', color: 'rgb(148, 116, 188)', background: 'rgb(53, 47, 58)' },
      tool: { radius: '4px', color: 'rgb(221, 134, 41)', background: 'rgb(39, 36, 31)' },
      context: { radius: '4px', color: 'rgb(89, 201, 132)', background: 'rgb(35, 60, 44)' },
    })) {
      const measured = tags[kind]
      assert.ok(measured !== undefined, `the ${kind} tag is drawn`)
      assert.equal(measured.radius, expected.radius, `the ${kind} tag radius is DSH’s 4px`)
      assert.equal(measured.color, expected.color, `the ${kind} tag colour is DSH’s measured value`)
      assert.equal(measured.background, expected.background, `the ${kind} tag background is DSH’s measured value`)
      assert.equal(measured.height, 19, `the ${kind} tag is 19px tall`)
      assert.equal(measured.font, '10px/650', `the ${kind} tag type is DSH’s 10px/650`)
      assert.equal(measured.spacing, '0.35px', `the ${kind} tag letter-spacing matches`)
      assert.equal(measured.padding, '0px 5px', `the ${kind} tag padding matches`)
    }

    // A small buffer separates the content from the input card, in every view (the composer is shared).
    const buffer = JSON.parse(
      await browser.evaluate(`(() => {
        const pane = document.querySelector('#tr-pane') ?? document.getElementById('ledger')
        const card = document.getElementById('composer-card')
        const composer = document.getElementById('composer')
        return JSON.stringify({
          gap: Math.round(card.getBoundingClientRect().top - pane.getBoundingClientRect().bottom),
          padding: getComputedStyle(composer).paddingTop,
        })
      })()`),
    )
    assert.ok(buffer.gap >= 6, `the content keeps a buffer above the input card (${buffer.gap}px)`)
    assert.equal(buffer.padding, '8px', 'and the buffer is the composer’s own padding, not a per-view offset')

    // Clicking the call examines it: the details pane with DSH's tabs, and the full result on Result.
    await browser.evaluate(`([...document.querySelectorAll('#tr-table tbody tr')].find((row) => row.dataset.kind === 'tool')).click()`)
    assert.ok(await browser.waitFor('document.getElementById("tr-details") !== null && !document.getElementById("tr-details").hidden', 10_000), 'the details pane opened')
    // DSH's Summary is a six-section accordion, open by default, and JSON is rendered as JSON.
    const accordion = JSON.parse(
      await browser.evaluate(`(() => {
        const sections = [...document.querySelectorAll('#tr-details .tr-d-acc')]
        return JSON.stringify({
          titles: sections.map((section) => section.querySelector('summary')?.textContent),
          allOpen: sections.every((section) => section.open === true),
          highlighted: document.querySelectorAll('#tr-details .tr-html span[class^="hljs-"]').length,
          summary: (() => {
            const summary = document.querySelector('#tr-details .tr-d-acc > summary')
            const style = getComputedStyle(summary)
            return { height: Math.round(summary.getBoundingClientRect().height), weight: style.fontWeight, lineHeight: style.lineHeight }
          })(),
          payloadFont: (() => {
            const block = document.querySelector('#tr-details .tr-html code, #tr-details .tr-html pre')
            return block === null ? null : getComputedStyle(block).fontFamily.split(',')[0].trim()
          })(),
        })
      })()`),
    )
    assert.deepEqual(accordion.titles, ['Hierarchy', 'Status', 'Payload', 'Result', 'Schema', 'Timing'], 'the Summary is DSH’s six-section accordion')
    assert.ok(accordion.allOpen, 'every section is open by default, as DSH shows it')
    assert.ok(accordion.highlighted > 0, 'and the payload is highlighted JSON, not a text dump')
    assert.equal(accordion.summary.height, 24, 'a Summary section heading is DSH’s 24px tall')
    assert.equal(accordion.summary.weight, '500', 'at DSH’s 500 weight')
    assert.equal(accordion.summary.lineHeight, '20px', 'on a 20px line')
    assert.match(accordion.payloadFont ?? '', /SF Mono/, 'and the payload block uses DSH’s SF Mono face')

    // DSH's details separator resizes by drag and resets on double-click; both are judged here.
    const paneResize = JSON.parse(
      await browser.evaluate(`(() => {
        const details = document.getElementById('tr-details')
        const handle = document.querySelector('.tr-d-resize')
        const before = Math.round(details.getBoundingClientRect().width)
        const start = handle.getBoundingClientRect()
        handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: start.left, clientY: start.top + 20, pointerId: 5 }))
        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: start.left - 100, clientY: start.top + 20, pointerId: 5 }))
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: start.left - 100, clientY: start.top + 20, pointerId: 5 }))
        const dragged = Math.round(details.getBoundingClientRect().width)
        handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        const reset = Math.round(details.getBoundingClientRect().width)
        return JSON.stringify({ before, dragged, reset, inline: details.style.width, title: handle.title })
      })()`),
    )
    assert.ok(paneResize.dragged > paneResize.before, 'dragging the details separator widens the pane')
    assert.equal(paneResize.title, 'Drag to resize. Double-click to reset.', 'the handle states its gestures, as DSH’s separator does')
    assert.equal(paneResize.inline, '', 'a double-click clears the dragged width')
    assert.equal(paneResize.reset, paneResize.before, 'returning the pane to its default width')

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
    assert.deepEqual(examined.tabs, ['Summary', 'Payload', 'Result', 'Schema', 'Timing'], 'the details pane has DSH’s five tabs')
    assert.match(examined.where, /Turn \d+/, 'and says which turn the row belongs to')
    assert.match(examined.result, /a\.txt/, 'the Result tab shows what the tool answered in full')
    const schema = JSON.parse(
      await browser.evaluate(`(() => {
        const tab = [...document.querySelectorAll('#tr-details .tr-d-tab')].find((entry) => entry.textContent === 'Schema')
        tab?.click()
        return JSON.stringify({ found: tab !== undefined, body: document.querySelector('#tr-details .tr-d-body')?.textContent ?? '' })
      })()`),
    )
    assert.ok(schema.found, 'the tool inspector has DSH’s Schema tab')
    assert.match(schema.body, /list_dir/, 'it names the tool')
    assert.match(schema.body, /Parameters/, 'and shows its parameter schema')
    assert.match(schema.body, /"type"/, 'with the schema itself as JSON')
    // A second screenshot, of the tool inspector itself, because the Schema tab is the feature this adds.
    await browser.screenshot(evidencePath('heddle-trajectory-schema.png'))



    // The toolbar's two collapse switches and the search box, as DSH's.
    /**
     * The panes are square; the rounded surface belongs to the composer card, which declares it itself.
     * This is the owner's rule of 2026-10-17: a default must not carry a shape that only one element wants.
     */
    const corners = JSON.parse(
      await browser.evaluate(`(() => {
        const radius = (selector) => {
          const element = document.querySelector(selector)
          return element === null ? null : getComputedStyle(element).borderRadius
        }
        return JSON.stringify({
          sidebar: radius('aside'),
          main: radius('main'),
          details: radius('#tr-details'),
          composer: radius('#composer-card'),
        })
      })()`),
    )
    assert.equal(corners.sidebar, '0px', 'the left navigation pane is square')
    assert.equal(corners.main, '0px', 'and so is the main pane')
    assert.equal(corners.details, '0px', 'and the trajectory details pane')
    assert.equal(corners.composer, '28px', 'while the composer card keeps its own rounded style')

    // DSH's details pane is resizable: drag its 8px handle and it keeps the width asked for.
    const resized = JSON.parse(
      await browser.evaluate(`(() => {
        const pane = document.getElementById('tr-details')
        const before = pane.getBoundingClientRect().width
        const handle = document.querySelector('.tr-d-resize')
        const rect = handle.getBoundingClientRect()
        handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.right, pointerId: 1 }))
        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.right - 120, pointerId: 1 }))
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: rect.right - 120, pointerId: 1 }))
        return JSON.stringify({ before, after: pane.getBoundingClientRect().width })
      })()`),
    )
    assert.ok(resized.after > resized.before + 60, `the details pane is resizable (${Math.round(resized.before)}px to ${Math.round(resized.after)}px)`)

    // Dragging across the lane strip focuses a window, and rows outside it dim — DSH's own interaction.
    const focused = JSON.parse(
      await browser.evaluate(`(() => {
        const strip = document.getElementById('timeline')
        const rect = strip.getBoundingClientRect()
        const at = (fraction) => rect.left + rect.width * fraction
        strip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: at(0.02), pointerId: 2 }))
        strip.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: at(0.35), pointerId: 2 }))
        strip.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: at(0.35), pointerId: 2 }))
        const outside = [...document.querySelectorAll('#tr-table tbody tr[data-focus="outside"]')]
        return JSON.stringify({ outside: outside.length, opacity: outside.length > 0 ? getComputedStyle(outside[0]).opacity : null })
      })()`),
    )
    assert.ok(focused.outside > 0, 'a dragged focus window dims the rows outside it')
    assert.equal(focused.opacity, '0.24', 'to DSH’s 0.24')

    // Collapse calls: one compact line per call, its arguments and result tucked away until examined.
    const calls = JSON.parse(
      await browser.evaluate(`(() => {
        document.getElementById('tr-calls').click()
        const tool = document.querySelector('#tr-table tbody tr[data-kind="tool"]')
        return JSON.stringify({
          pressed: document.getElementById('tr-calls').getAttribute('aria-pressed'),
          compact: tool?.classList.contains('tr-compact') ?? false,
          args: tool === null ? null : getComputedStyle(tool.querySelector('.tr-args')).display,
          result: tool === null ? null : getComputedStyle(tool.querySelector('.tr-result')).display,
        })
      })()`),
    )
    assert.equal(calls.pressed, 'true')
    assert.ok(calls.compact, 'collapsing calls compacts the tool rows')
    assert.equal(calls.args, 'none', 'hiding the arguments')
    assert.equal(calls.result, 'none', 'and the result preview, until a row is opened')

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

    // Leave the page in its default shape for the evidence screenshot: no compact calls, no focus window.
    await browser.evaluate(`(() => {
      const search = document.getElementById('tr-search-input')
      search.value = ''
      search.dispatchEvent(new Event('input', { bubbles: true }))
      const calls = document.getElementById('tr-calls')
      if (calls.getAttribute('aria-pressed') === 'true') calls.click()
      const strip = document.getElementById('timeline')
      const rect = strip.getBoundingClientRect()
      strip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left + 1, pointerId: 3 }))
      strip.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: rect.left + 1, pointerId: 3 }))
    })()`)
    assert.ok(await browser.waitFor("document.querySelector('#tr-table tbody tr[data-kind=tool] .tr-result') !== null", 10_000), 'the tool row shows its result again')
    const evidence = evidencePath('heddle-trajectory.png')
    await browser.screenshot(evidence)
    assert.ok(true, `a screenshot of the result is at ${evidence}`)
  } finally {
    browser.close()
    await server.close()
  }
})
