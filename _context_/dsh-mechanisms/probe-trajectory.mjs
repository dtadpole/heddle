/**
 * The trajectory comparison probe: measures the state matrix that computed styles alone cannot reach —
 * a **trusted** pointer hover (CDP Input events, so CSS :hover actually applies), the hover-left reset, the
 * narrow/wide viewport geometry (Emulation.setDeviceMetricsOverride), and the scroll positions' row counts.
 *
 * It is a reading instrument, not a check: it prints numbers for the comparison document. A claim that
 * survives becomes a part 9 assertion elsewhere.
 */
import { openPage, hover, resizePage } from '../../_tools_/browser-use/lib.mjs'

const DSH = 'http://127.0.0.1:8080/'
const HEDDLE = process.env.HEDDLE_URL ?? 'http://127.0.0.1:3082/'

const json = (value) => JSON.parse(value)

async function moveTo(page, x, y) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', buttons: 0, clickCount: 0 })
  await new Promise((done) => setTimeout(done, 120))
}

const rowProbe = `(() => {
  const rows = [...document.querySelectorAll('tr')].filter((row) => { const rect = row.getBoundingClientRect(); return row.querySelectorAll('td').length > 0 && rect.height > 0 && rect.width > 0 })
  const painted = rows.filter((row) => getComputedStyle(row).backgroundColor !== 'rgba(0, 0, 0, 0)')
  const box = (row) => { const rect = row.getBoundingClientRect(); return { x: rect.left + Math.min(120, rect.width / 2), y: rect.top + rect.height / 2, height: Math.round(rect.height) } }
  return JSON.stringify({
    rows: rows.length,
    painted: painted.length,
    heights: [...new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height)))].slice(0, 3),
    hoverCandidates: rows.slice(0, 40).map(box),
  })
})()`

const geometryProbe = `(() => {
  const rowsAll = [...document.querySelectorAll('tr')].filter((row) => { const rect = row.getBoundingClientRect(); return row.querySelectorAll('td').length > 0 && rect.height > 0 && rect.width > 0 })
  const table = rowsAll[0]?.closest('table') ?? document.querySelector('table')
  const rows = [...document.querySelectorAll('tr')].filter((row) => row.querySelectorAll('td').length > 0)
  const first = rows[0]
  const cells = first === undefined ? [] : [...first.querySelectorAll('td')].map((cell) => Math.round(cell.getBoundingClientRect().width))
  const panel = [...document.querySelectorAll('aside, [class*=details]')].find((element) => { const rect = element.getBoundingClientRect(); return rect.width > 250 && rect.width < 700 && rect.height > 200 })
  return JSON.stringify({
    table: table === null ? null : Math.round(table.getBoundingClientRect().width),
    cells,
    rowHeight: first === undefined ? null : Math.round(first.getBoundingClientRect().height),
    panel: panel === undefined ? null : Math.round(panel.getBoundingClientRect().width),
    scroller: (() => {
      let node = rows[0]?.parentElement
      while (node !== null && node !== undefined && node.scrollHeight <= node.clientHeight + 4) node = node.parentElement
      return node === null || node === undefined ? null : { id: node.id || String(node.className).slice(0, 20), scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }
    })(),
  })
})()`

async function measure(label, page, pickTrajectory) {
  await pickTrajectory()
  await new Promise((done) => setTimeout(done, 1500))
  const idle = json(await page.evaluate(rowProbe))
  const geometry = { base: json(await page.evaluate(geometryProbe)) }
  // trusted hover: move the real pointer onto a row, then read that row
  const candidate = idle.hoverCandidates[2] ?? idle.hoverCandidates[0]
  let hoverState = null
  if (candidate !== undefined) {
    await moveTo(page, candidate.x, candidate.y)
    hoverState = json(await page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('tr')].filter((row) => row.querySelectorAll('td').length > 0)
      const hovered = rows.find((row) => { const rect = row.getBoundingClientRect(); return rect.top <= ${Math.round(candidate.y)} && rect.bottom >= ${Math.round(candidate.y)} })
      return JSON.stringify({ background: hovered === undefined ? null : getComputedStyle(hovered).backgroundColor })
    })()`))
    // hover-left: move the pointer into the toolbar, then re-read the same row
    await moveTo(page, 20, 20)
    hoverState.afterLeave = json(await page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('tr')].filter((row) => row.querySelectorAll('td').length > 0)
      const row = rows.find((entry) => { const rect = entry.getBoundingClientRect(); return rect.top <= ${Math.round(candidate.y)} && rect.bottom >= ${Math.round(candidate.y)} })
      return JSON.stringify({ background: row === undefined ? null : getComputedStyle(row).backgroundColor })
    })()`)).background
  }
  // narrow and wide viewports
  for (const width of [1000, 1600]) {
    await resizePage(page, { width, height: 900 })
    await new Promise((done) => setTimeout(done, 400))
    geometry[String(width)] = json(await page.evaluate(geometryProbe))
  }
  await resizePage(page, { width: 1440, height: 900 })
  // scroll positions: how many rows exist in the DOM at each position
  const scroll = json(await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('tr')].filter((row) => row.querySelectorAll('td').length > 0)
    let node = rows[0]?.parentElement
    while (node !== null && node !== undefined && node.scrollHeight <= node.clientHeight + 4) node = node.parentElement
    if (node === null || node === undefined) return JSON.stringify({ counts: [] })
    const scroller = node
    const counts = []
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) * fraction)
      const visible = [...document.querySelectorAll('tr')].filter((row) => row.querySelectorAll('td').length > 0 && row.getBoundingClientRect().bottom > 0 && row.getBoundingClientRect().top < innerHeight).length
      counts.push({ fraction, domRows: [...document.querySelectorAll('tr')].filter((row) => row.querySelectorAll('td').length > 0).length, visible })
    }
    scroller.scrollTop = 0
    return JSON.stringify({ counts })
  })()`))
  return { label, idle, hoverState, geometry, scroll }
}

const heddleToken = process.env.HEDDLE_TOKEN ?? ''
const session = await openPage({ width: 1440, height: 900 })
try {
  const dsh = await measure('dsh', session.page, async () => {
    await session.goto(DSH)
    await new Promise((done) => setTimeout(done, 2000))
    const picked = await session.page.evaluate(`(() => {
      const row = [...document.querySelectorAll('[role=treeitem]')].find((element) => (element.textContent ?? '').includes('context-mgmt'))
      row?.click()
      return row !== undefined
    })()`)
    await new Promise((done) => setTimeout(done, 2000))
    await session.page.evaluate(`(() => {
      const tab = [...document.querySelectorAll('[role=tab], button')].find((element) => (element.textContent ?? '').trim() === 'Trajectory')
      tab?.click()
    })()`)
    await new Promise((done) => setTimeout(done, 1800))
    return picked
  })
  const heddle = await measure('heddle', session.page, async () => {
    await session.goto(HEDDLE + (heddleToken === '' ? '' : '?token=' + heddleToken))
    await new Promise((done) => setTimeout(done, 1600))
    await session.page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('#tree .row')]
      rows.find((row) => (row.textContent ?? '').length > 0)?.click()
    })()`)
    await new Promise((done) => setTimeout(done, 1200))
    await session.page.evaluate(`(() => {
      document.querySelector('#views button[data-view="trajectory"]')?.click()
    })()`)
  })
  console.log(JSON.stringify({ dsh, heddle }, null, 2))
} finally {
  await session.close()
}
