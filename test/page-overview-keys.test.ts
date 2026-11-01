import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * S151 (R-developer-eleven-21), developer-ten's N4: the overview is one Tab stop, as DSH's is, and the arrows move among
 * its bars. The page's fenced key helper is sliced out and judged here.
 */
const page = readFileSync(new URL('../src/server/page.html', import.meta.url), 'utf8')
const begin = page.indexOf('/* overview-keys:begin */')
const end = page.indexOf('/* overview-keys:end */')
assert.ok(begin !== -1 && end > begin, 'page.html fences overview-keys')
type Bar = { x0: number; lane: string }
const { overviewKeyTarget } = new Function(`${page.slice(begin, end)}; return { overviewKeyTarget }`)() as {
  overviewKeyTarget: (bars: Bar[], at: number, key: string) => number | null
}

/** One turn in reading order: the prompt, a request, a tool call, the answer, then the next prompt. */
const bars: Bar[] = [
  { x0: 0, lane: 'input' },
  { x0: 0.1, lane: 'model' },
  { x0: 0.3, lane: 'tools' },
  { x0: 0.45, lane: 'model' },
  { x0: 0.8, lane: 'input' },
]

test('Left and Right step through the bars in reading order and stop at the ends', () => {
  assert.equal(overviewKeyTarget(bars, 1, 'ArrowRight'), 2)
  assert.equal(overviewKeyTarget(bars, 1, 'ArrowLeft'), 0)
  assert.equal(overviewKeyTarget(bars, 4, 'ArrowRight'), 4, 'the last bar stays')
  assert.equal(overviewKeyTarget(bars, 0, 'ArrowLeft'), 0, 'and so does the first')
})

test('Home and End go to the first and the last bar', () => {
  assert.equal(overviewKeyTarget(bars, 2, 'Home'), 0)
  assert.equal(overviewKeyTarget(bars, 2, 'End'), 4)
})

test('Up and Down change lane, to the bar nearest in time, past a lane with no bar', () => {
  assert.equal(overviewKeyTarget(bars, 2, 'ArrowUp'), 3, 'from the call at 0.3 to the answer at 0.45, nearer than the request at 0.1')
  assert.equal(overviewKeyTarget(bars, 3, 'ArrowUp'), 4, 'from the answer at 0.45 to the prompt at 0.8, nearer than the one at 0')
  assert.equal(overviewKeyTarget(bars, 1, 'ArrowDown'), 2)
  assert.equal(overviewKeyTarget(bars, 0, 'ArrowUp'), 0, 'no lane above the input lane: it stays')
  assert.equal(overviewKeyTarget(bars, 2, 'ArrowDown'), 2, 'no lane below the tools lane: it stays')
  const noModel: Bar[] = [{ x0: 0, lane: 'input' }, { x0: 0.4, lane: 'tools' }]
  assert.equal(overviewKeyTarget(noModel, 0, 'ArrowDown'), 1, 'an empty model lane is passed over')
})

test('any other key is left to the page, and an empty or unknown position moves nothing', () => {
  assert.equal(overviewKeyTarget(bars, 1, 'Enter'), null, 'Enter is the button\'s own: it picks the turn')
  assert.equal(overviewKeyTarget(bars, 1, 'Tab'), null)
  assert.equal(overviewKeyTarget([], 0, 'ArrowRight'), null)
  assert.equal(overviewKeyTarget(bars, -1, 'ArrowRight'), null)
})
