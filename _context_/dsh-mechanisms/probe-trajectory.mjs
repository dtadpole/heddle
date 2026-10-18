/**
 * The trajectory comparison probe: the states computed styles alone cannot reach.
 *
 * It drives a real headless browser through `_tools_/browser-use`: `hover` moves the real pointer (CDP Input,
 * so CSS :hover applies), `resizePage` sets the viewport (Emulation), and a trusted mouse move away proves the
 * hover-left reset. Rows are scoped to the trajectory table (`#tr-table` on heddle, the first table with
 * `td`s on DSH) and "visible" means the row's own cells have a rect, not the `tr` box, which a table layout
 * may report as zero-width.
 */
import { openPage, hover, resizePage } from '../../_tools_/browser-use/lib.mjs'

const DSH = process.env.DSH_URL ?? 'http://127.0.0.1:8080/'
const HEDDLE = process.env.HEDDLE_URL ?? 'http://127.0.0.1:3082/'
const TOKEN = process.env.HEDDLE_TOKEN ?? ''
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const json = (value) => JSON.parse(value)

async function until(page, expression, timeout = 12_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try { if (await page.evaluate(expression)) return true } catch {}
    await sleep(250)
  }
  return false
}

async function moveTo(page, x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', buttons: 0, clickCount: 0 })
  await sleep(150)
}

const rowsExpression = `(() => {
  const table = document.querySelector('#tr-table') ?? [...document.querySelectorAll('table')].find((entry) => [...entry.querySelectorAll('tbody tr')].some((row) => row.querySelectorAll('td').length >= 2)) ?? null
  if (table === null) return '[]'
  const rows = [...table.querySelectorAll('tbody tr')].filter((row) => {
    const cell = row.querySelector('td')
    if (cell === null) return false
    const rect = cell.getBoundingClientRect()
    return rect.height > 0 && rect.width > 0
  })
  return JSON.stringify(rows.map((row) => {
    const cell = row.querySelector('td')
    const rect = cell.getBoundingClientRect()
    const style = getComputedStyle(row)
    return {
      kind: row.dataset.kind ?? null,
      background: style.backgroundColor,
      opacity: style.opacity,
      x: rect.left + Math.min(60, rect.width / 2),
      y: rect.top + rect.height / 2,
      height: Math.round(rect.height),
      tableWidth: Math.round(table.getBoundingClientRect().width),
      cells: [...row.querySelectorAll('td')].map((entry) => Math.round(entry.getBoundingClientRect().width)),
    }
  }))
})()`

const geometryExpression = `(() => {
  const table = document.querySelector('#tr-table') ?? [...document.querySelectorAll('table')].find((entry) => [...entry.querySelectorAll('tbody tr')].some((row) => row.querySelectorAll('td').length >= 2)) ?? null
  const rows = table === null ? [] : [...table.querySelectorAll('tbody tr')].filter((row) => row.querySelector('td') !== null)
  const first = rows.find((row) => row.querySelectorAll('td').length >= 2) ?? rows[0]
  const cells = first === undefined ? [] : [...first.querySelectorAll('td')].map((cell) => Math.round(cell.getBoundingClientRect().width))
  const panel = [...document.querySelectorAll('aside, [class*=details]')].find((element) => { const rect = element.getBoundingClientRect(); return rect.width > 250 && rect.width < 760 && rect.height > 200 })
  return JSON.stringify({
    table: table === null ? null : Math.round(table.getBoundingClientRect().width),
    cells,
    rowHeight: rows[0] === undefined ? null : Math.round(rows[0].querySelector('td').getBoundingClientRect().height),
    panel: panel === undefined ? null : Math.round(panel.getBoundingClientRect().width),
    sidebar: (() => { const aside = document.querySelector('aside, nav'); return aside === null ? null : Math.round(aside.getBoundingClientRect().width) })(),
  })
})()`

async function measure(label, page, prepare) {
  await prepare()
  const ready = await until(page, `document.querySelectorAll('#tr-table tbody tr, table tbody tr').length > 0`)
  const rows = json(await page.evaluate(rowsExpression))
  const visible = rows.filter((row) => row.height > 0)
  const twoCell = visible.filter((row) => row.cells.length >= 2)
  const geometry = { base: json(await page.evaluate(geometryExpression)) }
  let hoverState = null
  if (twoCell.length > 0) {
    const target = twoCell[Math.min(2, twoCell.length - 1)]
    await moveTo(page, target.x, target.y)
    const hovered = json(await page.evaluate(rowsExpression)).find((row) => Math.abs(row.y - target.y) < 1)
    await moveTo(page, 10, 10)
    const afterLeave = json(await page.evaluate(rowsExpression)).find((row) => Math.abs(row.y - target.y) < 1)
    hoverState = { background: hovered?.background ?? null, afterLeave: afterLeave?.background ?? null }
  }
  for (const width of [1000, 1600]) {
    await resizePage(page, { width, height: 900 })
    await sleep(500)
    geometry[String(width)] = json(await page.evaluate(geometryExpression))
  }
  await resizePage(page, { width: 1440, height: 900 })
  await sleep(400)
  // Scroll: how many rows live in the DOM at five positions (a virtualised table varies; a full render does not).
  const scroll = json(await page.evaluate(`(() => {
    const table = document.querySelector('#tr-table') ?? document.querySelector('table')
    if (table === null) return JSON.stringify({ positions: [] })
    let node = table.parentElement
    while (node !== null && node.scrollHeight <= node.clientHeight + 4) node = node.parentElement
    const rows = () => [...document.querySelectorAll('#tr-table tbody tr, table tbody tr')].filter((row) => row.querySelector('td') !== null)
    if (node === null) return JSON.stringify({ positions: [], scroller: null })
    const positions = []
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      node.scrollTop = Math.round((node.scrollHeight - node.clientHeight) * fraction)
      positions.push({ fraction, domRows: rows().length })
    }
    node.scrollTop = 0
    return JSON.stringify({ scroller: node.id || String(node.className).slice(0, 16), scrollHeight: node.scrollHeight, positions })
  })()`))
  // Collapse turns / collapse calls and search: staged, because both UIs render asynchronously and a
  // same-task read would report "unchanged" for a state that simply had not painted yet.
  const countRows = `(() => [...document.querySelectorAll('#tr-table tbody tr, table tbody tr')].filter((row) => row.querySelector('td') !== null).length)()`
  const clickControl = (pattern) => `(() => {
    const buttons = [...document.querySelectorAll('button')]
    const button = buttons.find((entry) => ${pattern}.test((entry.textContent ?? '') + ' ' + (entry.getAttribute('aria-label') ?? '') + ' ' + (entry.getAttribute('title') ?? '')))
    button?.click()
    return button === undefined ? 'no control' : 'clicked'
  })()`
  const collapse = { base: await page.evaluate(countRows) }
  for (const [name, pattern] of [['turns', '/collapse turns/i'], ['calls', '/collapse calls/i']]) {
    const clicked = await page.evaluate(clickControl(pattern))
    await sleep(600)
    collapse[name] = { clicked, after: await page.evaluate(countRows) }
    await page.evaluate(clickControl(pattern))
    await sleep(600)
    collapse[name].restored = await page.evaluate(countRows)
  }
  // Search with real key events: a controlled input ignores a native setter, so the text goes in over CDP.
  const search = { base: await page.evaluate(countRows) }
  const focused = await page.evaluate(`(() => {
    const input = document.querySelector('#tr-search-input') ?? document.querySelector('input[aria-label*=Search], input[placeholder*=Search]')
    if (input === null) return 'no input'
    input.focus()
    input.select()
    return document.activeElement === input ? 'focused' : 'not focused'
  })()`)
  search.focused = focused
  await page.send('Input.insertText', { text: 'not-a-real-term-xyz' })
  await sleep(800)
  search.filtered = await page.evaluate(countRows)
  search.typedValue = await page.evaluate(`(() => { const input = document.querySelector('#tr-search-input') ?? document.querySelector('input[aria-label*=Search], input[placeholder*=Search]'); return input === null ? null : input.value })()`)
  await page.evaluate(`(() => {
    const input = document.querySelector('#tr-search-input') ?? document.querySelector('input[aria-label*=Search], input[placeholder*=Search]')
    if (input === null) return
    input.select()
  })()`)
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
  await sleep(800)
  search.cleared = await page.evaluate(countRows)
  // Sidebar width, at the same two viewports, because the content column depends on it.
  const sidebar = (await page.evaluate(`(() => { const aside = document.querySelector('aside, nav'); return aside === null ? null : Math.round(aside.getBoundingClientRect().width) })()`))
  return { label, ready, rows: visible.length, heights: [...new Set(visible.map((row) => row.height))].slice(0, 3), hoverState, geometry, scroll, collapse, search, sidebar }
}

const session = await openPage({ width: 1440, height: 900 })
try {
  const dsh = await measure('dsh', session.page, async () => {
    await session.goto(DSH)
    await sleep(2000)
    const picked = await session.page.evaluate(`(() => {
      const item = [...document.querySelectorAll('[role=treeitem]')].find((element) => (element.textContent ?? '').includes('context-mgmt'))
      item?.click()
      return item !== undefined
    })()`)
    await sleep(2000)
    await session.page.evaluate(`(() => { [...document.querySelectorAll('[role=tab], button')].find((element) => (element.textContent ?? '').trim() === 'Trajectory')?.click() })()`)
    await sleep(1500)
    return picked
  })
  const heddle = await measure('heddle', session.page, async () => {
    await session.goto(HEDDLE + (TOKEN === '' ? '' : '?token=' + TOKEN))
    await sleep(1800)
    await session.page.evaluate(`(() => { const rows = [...document.querySelectorAll('#tree .row')]; rows.find((row) => (row.textContent ?? '').trim() !== '')?.click() })()`)
    await sleep(1200)
    await session.page.evaluate(`(() => { document.querySelector('#views button[data-view="trajectory"]')?.click() })()`)
    await sleep(1500)
  })
  console.log(JSON.stringify({ dsh, heddle }, null, 2))
} finally {
  await session.close()
}
