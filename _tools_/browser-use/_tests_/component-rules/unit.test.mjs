import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decodeFrame, encodeFrame } from '../../cdp.mjs'
import { browserPath, stateDir } from '../../chrome.mjs'
import { keyDescription, parseKey } from '../../actions.mjs'
import { parseGeolocation, parseHeaders, parseViewport } from '../../emulate.mjs'
import {
  formatConsoleList,
  formatNetworkRequest,
  formatPages,
  groupConsoleMessages,
  paginate,
  paginationLines,
  responseBodyText,
  networkStatus,
} from '../../format.mjs'
import { attributesOf, formatSnapshot } from '../../snapshot.mjs'
import { TOOL_NAMES } from '../../tools.mjs'

/**
 * The browser tool's **unit** tests: the rules its helpers implement, judged without a browser.
 *
 * The end-to-end verifiers beside the tool judge pages. These judge the small functions those runs
 * stand on — frame codecs, key names, viewport syntax, the snapshot text form, pagination — because a
 * bug in one of them shows up as a mysterious failure much later, and because a rule written in a
 * helper deserves a claim that can fail.
 *
 *     node --test _tools_/browser-use/_tests_/<suite>/unit.test.mjs
 */

/** One masked text frame, decoded back to its payload and flags. */
test('a client frame round-trips through the codec, small and fragmented-size', () => {
  for (const payload of ['{"id":1}', 'x'.repeat(200), 'y'.repeat(70_000)]) {
    const frame = encodeFrame(0x1, payload)
    const decoded = decodeFrame(frame)
    assert.ok(decoded !== null, `a ${payload.length}-byte payload is one whole frame`)
    assert.equal(decoded.opcode, 0x1)
    assert.equal(decoded.fin, true)
    assert.equal(decoded.payload.toString('utf8'), payload)
    assert.equal(decoded.consumed, frame.length)
  }
})

/** A frame cut short is not mistakenly read as a message. */
test('an incomplete frame decodes to null rather than to half a message', () => {
  const frame = encodeFrame(0x1, 'x'.repeat(300))
  assert.equal(decodeFrame(frame.subarray(0, 2)), null, 'only the header is not enough')
  assert.equal(decodeFrame(frame.subarray(0, 40)), null, 'a partial payload is not enough')
  assert.notEqual(decodeFrame(frame), null, 'the whole frame is enough')
})

/** `1280x900x2,mobile,touch` is the viewport syntax, and a bad one is refused by name. */
test('the viewport syntax parses every tag and refuses a malformed value', () => {
  assert.deepEqual(parseViewport('800x600x2,mobile,touch,landscape'), {
    width: 800,
    height: 600,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    isLandscape: true,
  })
  assert.deepEqual(parseViewport('1024x768'), {
    width: 1024,
    height: 768,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    isLandscape: false,
  })
  assert.throws(() => parseViewport('800x0'), /invalid viewport height/)
  assert.throws(() => parseViewport('nonsense'), /invalid viewport width/)
  assert.throws(() => parseViewport(''), /viewport needs the form/)
})

/** A geolocation outside the globe is not a place. */
test('geolocation parses a pair and refuses a latitude off the globe', () => {
  assert.deepEqual(parseGeolocation('37.7749,-122.4194'), { latitude: 37.7749, longitude: -122.4194 })
  assert.throws(() => parseGeolocation('91,0'), /invalid latitude/)
  assert.throws(() => parseGeolocation('0,181'), /invalid longitude/)
})

/** Extra headers are a JSON object, and an empty string clears them. */
test('extra headers parse as a JSON object, and an empty string is an empty set', () => {
  assert.deepEqual(parseHeaders('{"X-One": "1"}'), { 'X-One': '1' })
  assert.deepEqual(parseHeaders(''), {})
  assert.throws(() => parseHeaders('[1]'), /must be a JSON object/)
  assert.throws(() => parseHeaders('nope'), /not JSON/)
})

/** `Control+Shift+A` is a chord, and its parts are named rather than guessed. */
test('a key chord separates its modifiers from its key, and an unknown modifier is refused', () => {
  assert.deepEqual(parseKey('Control+Shift+A'), { key: 'A', modifiers: 2 | 8 })
  assert.deepEqual(parseKey('Enter'), { key: 'Enter', modifiers: 0 })
  assert.throws(() => parseKey('Hyper+A'), /unknown modifier/)
  assert.throws(() => parseKey(''), /press_key needs a key name/)
})

/** The protocol codes for the keys a page checks by `event.key` and `keyCode`. */
test('key descriptions carry the protocol codes for named, letter, digit and punctuation keys', () => {
  assert.deepEqual(keyDescription('Enter'), { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' })
  assert.deepEqual(keyDescription('a'), { key: 'a', code: 'KeyA', keyCode: 65, text: 'a' })
  assert.deepEqual(keyDescription('7'), { key: '7', code: 'Digit7', keyCode: 55, text: '7' })
  assert.deepEqual(keyDescription('/'), { key: '/', code: 'Slash', keyCode: 191, text: '/' })
  assert.deepEqual(keyDescription('F5'), { key: 'F5', code: 'F5', keyCode: 116 })
  assert.throws(() => keyDescription('NonsenseKey'), /does not know the key/)
})

/** The snapshot's text form: indentation, uid first, role rules, quoted values, collapsed text. */
test('a snapshot prints the DevTools text form and collapses redundant text children', () => {
  const tree = {
    uid: '1_0',
    role: 'RootWebArea',
    name: 'Page',
    props: { url: 'https://example.com/', focusable: true },
    children: [
      { uid: '1_1', role: 'heading', name: 'Title', props: { level: 1 }, children: [{ uid: '1_2', role: 'StaticText', name: 'Title', props: {}, children: [] }] },
      { uid: '1_3', role: 'button', name: 'Press', props: { focusable: true, focused: true }, children: [] },
      { uid: '1_4', role: 'option', name: 'Green', props: { selected: true, value: 'Green' }, children: [] },
      { uid: '1_5', role: 'none', name: 'ignored label', props: {}, children: [] },
      { uid: '1_6', role: 'StaticText', name: 'body text', props: {}, children: [] },
    ],
  }
  const text = formatSnapshot(tree)
  assert.equal(
    text,
    [
      'uid=1_0 RootWebArea "Page" focusable url="https://example.com/"',
      '  uid=1_1 heading "Title" level="1"',
      '  uid=1_3 button "Press" focusable focused',
      '  uid=1_4 option "Green" selected',
      '  uid=1_5 ignored "ignored label"',
      '  uid=1_6 "body text"',
    ].join('\n'),
  )
})

/** Boolean states print under the capability name and once each. */
test('a snapshot attribute is printed once, with the renamed boolean', () => {
  const attributes = attributesOf({ uid: '1_0', role: 'textbox', name: 'Name', props: { focusable: true, focused: true, editable: 'plaintext' } })
  assert.deepEqual(attributes, ['uid=1_0', 'textbox', '"Name"', 'editable="plaintext"', 'focusable', 'focused'])
})

/** A page list is numbered, titles first, with the selected one marked. */
test('the page listing numbers pages and marks the selected one', () => {
  const text = formatPages([
    { pageId: 1, url: 'about:blank', title: '', selected: false },
    { pageId: 2, url: 'https://example.com/', title: 'Example', selected: true },
  ])
  assert.equal(text, '## Pages\n1: about:blank\n2: Example (https://example.com/) [selected]')
})

/** Pagination pages a list, reports its window, and does not fail on a bad index. */
test('pagination windows a list and reports an out-of-range page as the first one', () => {
  const items = Array.from({ length: 45 }, (_value, index) => index)
  const first = paginate(items, { pageSize: 20 })
  assert.equal(first.items.length, 20)
  assert.equal(first.items[0], 0)
  assert.equal(first.pagination.totalPages, 3)
  assert.equal(first.pagination.hasNextPage, true)
  assert.deepEqual(paginationLines(first.pagination), ['Showing 1-20 of 45 (Page 1 of 3).'])
  const last = paginate(items, { pageSize: 20, pageIdx: 2 })
  assert.deepEqual(last.items, [40, 41, 42, 43, 44])
  assert.equal(last.pagination.hasPreviousPage, true)
  assert.equal(last.pagination.hasNextPage, false)
  const bad = paginate(items, { pageSize: 20, pageIdx: 9 })
  assert.equal(bad.pagination.invalidPage, true)
  assert.equal(bad.items[0], 0)
  assert.deepEqual(paginationLines(bad.pagination)[0], 'Invalid page number provided. Showing first page.')
  const all = paginate(items, {})
  assert.equal(all.items.length, 45)
  assert.deepEqual(paginationLines(all.pagination), [])
})

/** Identical consecutive console messages are one message with a count. */
test('console messages group only when they are consecutive and identical', () => {
  const grouped = groupConsoleMessages([
    { msgid: 1, type: 'log', text: 'same', argsCount: 0 },
    { msgid: 2, type: 'log', text: 'same', argsCount: 0 },
    { msgid: 3, type: 'warn', text: 'same', argsCount: 0 },
    { msgid: 4, type: 'log', text: 'same', argsCount: 1 },
    { msgid: 5, type: 'log', text: 'other', argsCount: 0 },
  ])
  assert.deepEqual(
    grouped.map((message) => [message.type, message.text, message.count]),
    [
      ['log', 'same', 2],
      ['warn', 'same', 1],
      ['log', 'same', 1],
      ['log', 'other', 1],
    ],
  )
})

/** A console list is a header, the message lines, and nothing parsed from the page's own text. */
test('the console listing formats a message and says when there are none', () => {
  const page = {
    browser: { navigationEpoch: 1 },
    console: [
      { msgid: 1, type: 'log', text: 'hello', args: ['hello'], navigation: 1 },
      { msgid: 2, type: 'error', text: 'broken', args: [], navigation: 1 },
      { msgid: 3, type: 'log', text: 'old page', args: [], navigation: 0 },
    ],
    network: [],
  }
  const listed = formatConsoleList(page)
  assert.match(listed.text, /^## Console messages/)
  assert.match(listed.text, /msgid=1 \[log\] hello \(1 args\)/)
  assert.match(listed.text, /msgid=2 \[error\] broken \(0 args\)/)
  assert.doesNotMatch(listed.text, /old page/, 'a previous document is not in the reading')
  const preserved = formatConsoleList(page, { includePreservedMessages: true })
  assert.match(preserved.text, /old page/, 'unless the caller asks for preserved messages')
  const empty = formatConsoleList({ browser: { navigationEpoch: 1 }, console: [], network: [] })
  assert.match(empty.text, /<no console messages found>/)
})

/** A request's status is its code, its failure, or honestly pending. */
test('a network status is the code, the failure, or pending', () => {
  assert.equal(networkStatus({ status: 200 }), '200')
  assert.equal(networkStatus({ failed: 'net::ERR_FAILED' }), 'net::ERR_FAILED')
  assert.equal(networkStatus({}), 'pending')
  assert.equal(formatNetworkRequest({ reqid: 3, method: 'GET', url: 'https://example.com/', status: 404 }), 'reqid=3 GET https://example.com/ [404]')
})

/** A response body is text when it is text, and says so when it is not. */
test('a response body is decoded, truncated, or described as binary', () => {
  assert.equal(responseBodyText('{"ok":true}', false), '{"ok":true}')
  assert.equal(responseBodyText(Buffer.from('{"ok":true}').toString('base64'), true), '{"ok":true}')
  assert.equal(responseBodyText(Buffer.from([0xff, 0xfe, 0x00]).toString('base64'), true), '<binary data>')
  assert.equal(responseBodyText('', false), '')
  assert.equal(responseBodyText('x'.repeat(20_000), false).length, 10_000 + '... <truncated>'.length)
})

/**
 * The DSH surface this tool is measured against: the 32 tools `chrome-devtools-mcp` advertises under the
 * harness profile's flags, as recorded in `_context_/dsh-browser-mcp/`.
 */
const DSH_ADVERTISED = [
  'click', 'close_page', 'drag', 'emulate', 'evaluate_script', 'fill', 'fill_form', 'get_console_message',
  'get_css_styles', 'get_network_request', 'handle_dialog', 'hover', 'lighthouse_audit',
  'list_console_messages', 'list_network_requests', 'list_pages', 'navigate_page', 'new_page',
  'performance_analyze_insight', 'performance_start_trace', 'performance_stop_trace', 'press_key',
  'resize_page', 'screencast_start', 'screencast_stop', 'select_page', 'take_heapsnapshot',
  'take_screenshot', 'take_snapshot', 'type_text', 'upload_file', 'wait_for',
]

/**
 * The advertised tools this driver deliberately does not implement, each for a stated reason.
 *
 * `lighthouse_audit` is the Lighthouse engine rather than a protocol call. `performance_analyze_insight`
 * interprets a trace with the DevTools frontend's insight model; the trace itself is captured by the
 * start/stop tools, but the analysis is not a protocol call either.
 */
const DSH_EXCLUDED = ['lighthouse_audit', 'performance_analyze_insight']

/** Tools this driver adds beyond the DSH surface, and why. */
const EXTRA = ['click_at']

/**
 * The coverage claim: every advertised DSH tool is either implemented or named as excluded, and nothing
 * is implemented that is not accounted for. This is the component rule behind "the tool covers the DSH
 * browser surface"; what each tool does is a delivery claim and is judged by the verifiers.
 */
test('every advertised DSH tool is implemented or named as excluded', () => {
  for (const name of DSH_ADVERTISED) {
    if (DSH_EXCLUDED.includes(name)) {
      assert.ok(!TOOL_NAMES.includes(name), `${name} is excluded and absent from the tool table`)
      continue
    }
    assert.ok(TOOL_NAMES.includes(name), `${name} is covered`)
  }
  const unexplained = TOOL_NAMES.filter((name) => !DSH_ADVERTISED.includes(name) && !EXTRA.includes(name))
  assert.deepEqual(unexplained, [], 'every tool beyond the DSH surface is documented as an addition')
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length, 'and the table names each tool once')
})

/**
 * A named session gets its own state directory, with a name safe to be a path.
 *
 * This is the rule that keeps two agents driving a browser at once apart: each session's socket,
 * profile and page ids live under its own directory, so no `list_pages` can name the other's page.
 */
test('a named session maps to a directory of its own, and an unnamed one to the shared directory', () => {
  const saved = { home: process.env.HEDDLE_BROWSER_HOME, session: process.env.HEDDLE_BROWSER_SESSION }
  try {
    process.env.HEDDLE_BROWSER_HOME = '/tmp/heddle-browser-test'
    delete process.env.HEDDLE_BROWSER_SESSION
    assert.equal(stateDir(), '/tmp/heddle-browser-test', 'without a session name, the shared directory is used')
    process.env.HEDDLE_BROWSER_SESSION = 'Agent Two/../work'
    assert.equal(stateDir(), '/tmp/heddle-browser-test/sessions/agent-two-work', 'a session name becomes one safe path segment')
  } finally {
    if (saved.home === undefined) delete process.env.HEDDLE_BROWSER_HOME
    else process.env.HEDDLE_BROWSER_HOME = saved.home
    if (saved.session === undefined) delete process.env.HEDDLE_BROWSER_SESSION
    else process.env.HEDDLE_BROWSER_SESSION = saved.session
  }
})

/** The browser binary can be named explicitly, which is what a machine without the default path needs. */
test('an explicit browser path wins over discovery', () => {
  assert.equal(browserPath('/definitely/not/a/browser'), '/definitely/not/a/browser')
})
