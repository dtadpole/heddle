import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * S151 (R-developer-eleven-21): DSH's overview zooms its time domain with the wheel, about the pointer, and a right-button
 * drag pans a zoomed viewport. The page's fenced viewport helpers are sliced out and judged here.
 */
const page = readFileSync(new URL('../src/server/page.html', import.meta.url), 'utf8')
const begin = page.indexOf('/* overview-viewport:begin */')
const end = page.indexOf('/* overview-viewport:end */')
assert.ok(begin !== -1 && end > begin, 'page.html fences overview-viewport')
type Viewport = { from: number; to: number } | null
const helpers = new Function(`${page.slice(begin, end)}; return { zoomViewport, panViewport, viewportDomain, viewportMinSpan, viewportShowing }`)() as {
  zoomViewport: (viewport: Viewport, anchor: number, deltaY: number, minSpan: number) => Viewport
  panViewport: (viewport: Viewport, anchorFrom: number, deltaFraction: number) => Viewport
  viewportDomain: (viewport: Viewport, screenFraction: number) => number
  viewportMinSpan: (durationActual: boolean, totalMs: number, records: number) => number
  viewportShowing: (viewport: Viewport, x0: number, x1: number) => Viewport
}
const close = (actual: number | undefined, expected: number, message?: string) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${message ?? ''} (${actual} vs ${expected})`)

test('a wheel up zooms in about the pointer: the domain point under it stays under it', () => {
  const zoomed = helpers.zoomViewport(null, 0.25, -500, 0.001)
  assert.ok(zoomed !== null)
  close(zoomed.to - zoomed.from, Math.exp(-0.75), 'the span scales by e^(deltaY * 0.0015)')
  close(helpers.viewportDomain(zoomed, 0.25), 0.25, 'the point under the pointer is where it was')
  const again = helpers.zoomViewport(zoomed, 0.5, -500, 0.001)
  close(helpers.viewportDomain(again, 0.5), helpers.viewportDomain(zoomed, 0.5), 'and so on a second zoom')
})

test('a zoom stops at its narrowest span, stays inside the domain, and zooming back out to the whole is null', () => {
  const narrow = helpers.zoomViewport(null, 1, -100_000, 0.05)
  assert.ok(narrow !== null)
  close(narrow.to - narrow.from, 0.05, 'no narrower than the floor')
  close(narrow.to, 1, 'anchored at the right edge, it ends at the domain end')
  assert.equal(helpers.zoomViewport(narrow, 0.5, 100_000, 0.05), null, 'a wheel down past the whole domain shows the whole again')
  assert.equal(helpers.zoomViewport(null, 0.5, 200, 0.05), null, 'and an unzoomed strip cannot zoom out')
})

test('a right-button drag pans a zoomed viewport within the domain, and an unzoomed strip does not pan', () => {
  const viewport = { from: 0.4, to: 0.6 }
  const right = helpers.panViewport(viewport, 0.4, 0.5)
  close(right?.from, 0.3, 'dragging right by half the strip shows half a viewport earlier')
  close((right?.to ?? 0) - (right?.from ?? 0), 0.2, 'the span is kept')
  close(helpers.panViewport(viewport, 0.4, 10)?.from, 0, 'it stops at the domain start')
  close(helpers.panViewport(viewport, 0.4, -10)?.to, 1, 'and at the domain end')
  assert.equal(helpers.panViewport(null, 0, 0.5), null)
})

test('a point on the strip maps to the domain through the viewport', () => {
  assert.equal(helpers.viewportDomain(null, 0.3), 0.3)
  close(helpers.viewportDomain({ from: 0.5, to: 0.75 }, 0.5), 0.625)
})

test("the narrowest zoom is DSH's: 20 ms of recorded time, or four records in the equal mode; a short domain cannot zoom", () => {
  assert.equal(helpers.viewportMinSpan(true, 2000, 50), 0.01, '20 ms of a 2 s domain')
  assert.equal(helpers.viewportMinSpan(false, 2000, 50), 0.08, 'four of 50 records')
  assert.equal(helpers.viewportMinSpan(true, 15, 50), 1, 'a domain under 20 ms cannot zoom')
  assert.equal(helpers.viewportMinSpan(false, 2000, 3), 1, 'nor can three records')
  assert.equal(helpers.zoomViewport(null, 0.5, 0, 0.01), null, 'and a wheel with no vertical delta changes nothing')
})

test("a bar the keyboard moves to is brought into view by DSH's rule: the least pan, at the same zoom", () => {
  const viewport = { from: 0.4, to: 0.6 }
  assert.equal(helpers.viewportShowing(viewport, 0.5, 0.52), viewport, 'a bar in view leaves the viewport as it is')
  assert.equal(helpers.viewportShowing(viewport, 0.6, 0.65), viewport, 'and so does one touching its edge')
  const later = helpers.viewportShowing(viewport, 0.7, 0.75)
  close(later?.to, 0.75, 'a later bar ends the viewport')
  close((later?.to ?? 0) - (later?.from ?? 0), 0.2, 'at the same span')
  close(helpers.viewportShowing(viewport, 0.1, 0.12)?.from, 0.1, 'an earlier bar starts it')
  close(helpers.viewportShowing(viewport, 0.95, 1.2)?.to, 1, 'and it stays inside the domain')
  assert.equal(helpers.viewportShowing(null, 0.9, 0.95), null, 'the whole domain shows every bar')
})
