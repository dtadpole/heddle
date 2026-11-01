import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

// Run the same real page functions against an immutable baseline to prove the stale-pill failure.
const root = join(import.meta.dirname, '..')
function snapshotPage(file: string): string {
  const scratch = realpathSync(join(root, '.heddle-tmp/context-harness-Q'))
  const path = realpathSync(resolve(root, file))
  const within = relative(scratch, path)
  assert.ok(within && within !== '..' && !within.startsWith('../') && !isAbsolute(within),
    'explicit page snapshots must belong to this worktree context harness scratch')
  return readFileSync(path, 'utf8')
}
assert.ok(!(process.env.HEDDLE_TEST_PAGE_FILE && process.env.HEDDLE_TEST_PAGE_REV),
  'select either an explicit snapshot or the original revision guard')
const page = process.env.HEDDLE_TEST_PAGE_FILE
  ? snapshotPage(process.env.HEDDLE_TEST_PAGE_FILE)
  : process.env.HEDDLE_TEST_PAGE_REV
    ? execFileSync('git', ['show', `${process.env.HEDDLE_TEST_PAGE_REV}:src/server/page.html`], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    : readFileSync(join(root, 'src/server/page.html'), 'utf8')
function source(name: string): string {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  const end = page.indexOf('\n}', start)
  assert.ok(end > start, `the complete ${name} is present`)
  return page.slice(start, end + 2)
}

class Element {
  textContent = ''
  hidden = false
  disabled = false
  title = ''
  className = ''
  style: Record<string, string> = {}
  attributes: Record<string, string> = {}
  children: Element[] = []
  setAttribute(name: string, value: string) { this.attributes[name] = value }
  append(...children: Element[]) { this.children.push(...children) }
  replaceChildren(...children: Element[]) { this.children = children }
}
interface Snapshot {
  pill: string
  hidden: boolean
  ring: string | undefined
  headline: string | undefined
  figure: string | undefined
  label: string
}
interface Harness {
  snapshot(): Snapshot
  choose(endpoint: string, model: string): Promise<void>
  apply(endpoint: string, model: string): void
  reload(window?: number): Promise<void>
  open(): void
  reads: { url: string; resolve(value: unknown): void }[]
  ready(): Promise<void>
}
function harness(open = true): Harness {
  const cells = new Map<string, Element>()
  const statusBar = Object.assign(new Element(), { querySelector(selector: string) {
    if (!cells.has(selector)) cells.set(selector, new Element())
    return cells.get(selector)
  } })
  const popover = new Element()
  const reads: Harness['reads'] = []
  const waiters: (() => void)[] = []
  const ready = () => reads.length > 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve))
  // Bind the representation consumed by the selected real renderer, not a replacement renderer.
  const liveTurnMap = /\bliveTurns\s*\.\s*get\s*\(/.test(source('updateStatusBar'))
  const selectionBindings: Record<string, string> = {
    selectionSeq: 'let selectionSeq = 0;',
    latestSelection: 'const latestSelection = new Map();',
    serverSeats: 'const serverSeats = new Map();',
    heldSeats: 'const heldSeats = new Map();',
    recordedSelections: 'const recordedSelections = new Set();',
    pendingSaves: 'const pendingSaves = new Set();',
    saveChain: 'let saveChain = Promise.resolve();',
  }
  const recordSource = source('recordSelection')
  const recordBindings = Object.entries(selectionBindings)
    .filter(([name]) => new RegExp(`\\b${name}\\b`).test(recordSource))
    .map(([, binding]) => binding).join('\n')
  const names = ['configuredEndpoint', 'modelsOf', 'modelEntryOf', 'levelsOf', 'selectedModelId',
    'windowFor', 'modelTitle', 'effectiveEffort', 'modelMissingFrom', 'currentEndpointName',
    'renderModelSeat', 'recordSelection', 'chooseModel', 'applySessionModel', 'loadEndpoints',
    'updateStatusBar', 'paintDock', 'addUsage', 'formatTokenCount', 'formatRate', 'formatCacheHit',
    'formatDurationMs', 'formatExactCount', 'formatWindow', 'statPanelRows', 'renderStatPopover']
  const h = runInNewContext(`
    let current = 'session';
    let chosenEndpoint = 'fixture', chosenModel = 'small', chosenEffort = null;
    let endpointDefault = 'fixture';
    let endpointOptions = [
      { name: 'fixture', models: [{ id: 'small', contextWindow: 100000 }, { id: 'large', contextWindow: 200000 }, { id: 'unknown' }] },
      { name: 'other', models: [{ id: 'other-model', contextWindow: 400000 }] }
    ];
    const sessionStats = { turns: 1, steps: 1, lastPromptTokens: 50000 };
    const liveTurns = ${liveTurnMap ? 'new Map()' : '0'};
    const liveRounds = 0, liveGenerationMs = 0, liveDecodeTokens = 0;
    const liveUsage = undefined;
    let defaultSelection = { model: null, effort: null };
    ${recordBindings}
    let modelPending = false, statPopoverKind = initiallyOpen ? 'context' : null;
    const modelLabel = new Element(), modelEffort = new Element(), modelTrigger = new Element(),
      modelSpinner = new Element(), modelMenu = new Element();
    modelMenu.hidden = true;
    const setNote = () => {}, closeAfterSelection = () => {}, renderModelPane = () => {},
      placeModelMenu = () => {}, positionStatPopover = () => {};
    const document = { getElementById: () => popover, createElement: () => new Element(),
      createTextNode: (text) => Object.assign(new Element(), { textContent: text }) };
    const fetch = (url) => new Promise((resolve) => queueRead({ url, resolve }));
    ${names.map(source).join('\n')}
    renderModelSeat();
    updateStatusBar();
    function snapshot() {
      const header = popover.children.find((child) => child.className === 'stat-panel-head-inline');
      return { pill: statusBar.querySelector('[data-stat="context"]').textContent,
        hidden: statusBar.querySelector('[data-stat-pill="context"]').hidden,
        ring: statusBar.querySelector('[data-stat="context-ring"]').attributes['stroke-dasharray'],
        headline: header?.children.find((child) => child.className === 'stat-panel-headline')?.textContent,
        figure: header?.children.find((child) => child.className === 'stat-panel-figure')?.textContent,
        label: modelLabel.textContent };
    }
    ({ snapshot, choose: chooseModel, apply: applySessionModel,
      reload: async (window) => {
        const task = loadEndpoints();
        await ready();
        const read = takeRead();
        read.resolve({ ok: true, json: async () => ({ default: 'fixture', endpoints: [
          { name: 'fixture', models: [{ id: chosenModel, ...(window === undefined ? {} : { contextWindow: window }) }] }
        ] }) });
        await task;
      }, open: () => { statPopoverKind = 'context'; renderStatPopover(); } })
  `, { Element, statusBar, popover, initiallyOpen: open,
    queueRead: (read: Harness['reads'][number]) => {
      reads.push(read)
      for (const notify of waiters.splice(0)) notify()
    }, takeRead: () => reads.shift(), ready,
  }, { timeout: 1000 }) as Omit<Harness, 'reads' | 'ready'>
  return { ...h, reads, ready }
}
function assertReading(h: Harness, percent: string, figure: string) {
  const at = h.snapshot()
  assert.equal(at.pill, percent, 'dock percentage follows the effective model without another turn')
  assert.equal(at.headline, percent, 'actual open popover and dock agree')
  assert.equal(at.figure, figure)
  assert.equal(at.hidden, false)
  const fraction = Number.parseFloat(percent) / 100
  const circumference = 2 * Math.PI * 5.5
  assert.equal(at.ring, `${(fraction * circumference).toFixed(2)} ${circumference.toFixed(2)}`, 'the ring follows the same percentage')
}
async function acceptSelection(h: Harness) {
  await h.ready()
  const read = h.reads.shift()
  assert.ok(read)
  assert.equal(read.url, '/api/sessions/session/model', 'selection POST is the only request; no turn or stats GET')
  read.resolve({ ok: true, json: async () => ({}) })
}

test('actual chooseModel refreshes dock and already-open context popover before selection POST settles, without a turn', { timeout: 10000 }, async () => {
  const h = harness()
  assertReading(h, '50%', '~50K / 100K')
  const pending = h.choose('fixture', 'large')
  assert.equal(h.snapshot().label, 'large')
  assertReading(h, '25%', '~50K / 200K')
  await acceptSelection(h)
  await pending
  assertReading(h, '25%', '~50K / 200K')
})

test('opening actual context popover after switching cannot show new percent beside old dock percent', { timeout: 10000 }, async () => {
  const h = harness(false)
  const pending = h.choose('fixture', 'large')
  await acceptSelection(h)
  await pending
  h.open()
  assert.equal(h.snapshot().headline, '25%', 'newly opened actual popover already reads the new model on the old page')
  assertReading(h, '25%', '~50K / 200K')
})

test('recorded endpoint/model changes and catalogue window refreshes repaint the same dock', { timeout: 10000 }, async () => {
  const h = harness()
  h.apply('other', 'other-model')
  assertReading(h, '13%', '~50K / 400K')
  h.apply('fixture', 'large')
  assertReading(h, '25%', '~50K / 200K')
  await h.reload(500000)
  assertReading(h, '10%', '~50K / 500K')
  assert.equal(h.reads.length, 0)
})

test('switching to an unreported window blanks the percentage rather than keeping an old reading', { timeout: 10000 }, async () => {
  const h = harness()
  const pending = h.choose('fixture', 'unknown')
  await acceptSelection(h)
  await pending
  assert.equal(h.snapshot().pill, '')
  assert.equal(h.snapshot().hidden, true)
  assert.equal(h.snapshot().headline, undefined)
  assert.equal(h.snapshot().figure, undefined)
  await h.reload(200000)
  assertReading(h, '25%', '~50K / 200K')
  await h.reload()
  assert.equal(h.snapshot().pill, '')
  assert.equal(h.snapshot().hidden, true)
})

// A model render refreshes stats, never the opposite direction (including popover rendering).
test('status and popover functions do not recurse into model rendering', () => {
  for (const name of ['updateStatusBar', 'paintDock', 'renderStatPopover', 'statPanelRows']) {
    assert.doesNotMatch(source(name), /\brenderModelSeat\s*\(/)
  }
})
