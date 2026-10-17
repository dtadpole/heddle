import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  click,
  drag,
  evaluateScript,
  fill,
  fillForm,
  handleDialog,
  hover,
  pressKey,
  typeText,
  uploadFile,
  waitFor,
} from './actions.mjs'
import { emulate, resizePage } from './emulate.mjs'
import {
  formatConsoleList,
  formatConsoleMessageDetailed,
  formatNetworkList,
  formatNetworkRequestDetailed,
  formatPages,
  networkToJson,
  paginate,
  paginationLines,
  responseBodyText,
} from './format.mjs'
import { snapshotToJson, takeSnapshot } from './snapshot.mjs'

/**
 * The tool surface: the same names and arguments as the harness browser's tools, implemented on the
 * page objects in this directory.
 *
 * A table rather than a class per tool, because the shape of every call is the same — resolve the
 * page, check that a dialog is not in the way, run one action, format one answer — and the interesting
 * part of each is the action itself, which lives in `actions.mjs` or `emulate.mjs`.
 */

/** Tools that cannot run while a JavaScript dialog has the page's main thread. */
const BLOCKED_BY_DIALOG = new Set([
  'click',
  'click_at',
  'hover',
  'fill',
  'fill_form',
  'drag',
  'press_key',
  'type_text',
  'upload_file',
  'navigate_page',
  'take_snapshot',
  'evaluate_script',
  'wait_for',
  'take_screenshot',
  'resize_page',
  'get_css_styles',
  'take_heapsnapshot',
  'screencast_start',
  'screencast_stop',
  'performance_start_trace',
  'performance_stop_trace',
])

/** Every tool this implementation offers, in the order the help lists them. */
export const TOOL_NAMES = [
  'list_pages',
  'new_page',
  'select_page',
  'close_page',
  'navigate_page',
  'take_snapshot',
  'click',
  'click_at',
  'hover',
  'fill',
  'fill_form',
  'drag',
  'press_key',
  'type_text',
  'upload_file',
  'handle_dialog',
  'take_screenshot',
  'evaluate_script',
  'wait_for',
  'list_console_messages',
  'get_console_message',
  'list_network_requests',
  'get_network_request',
  'emulate',
  'resize_page',
  'get_css_styles',
  'take_heapsnapshot',
  'screencast_start',
  'screencast_stop',
  'performance_start_trace',
  'performance_stop_trace',
]

/** One line about each tool, for `browser help`. */
export const TOOL_HELP = {
  list_pages: 'list the open pages, numbered',
  new_page: '{"url": "https://…"} open a tab and load a URL',
  select_page: '{"pageId": 1} make a page the target of later calls',
  close_page: '{"pageId": 1} close a page (not the last one)',
  navigate_page: '{"url": "https://…"} or {"type": "back"|"forward"|"reload"}',
  take_snapshot: 'take the accessibility snapshot; its uids drive the next call',
  click: '{"uid": "1_3"} click an element from the snapshot',
  click_at: '{"x": 100, "y": 200} click a point',
  hover: '{"uid": "1_3"} move the mouse over an element',
  fill: '{"uid": "1_4", "value": "text"} fill a field',
  fill_form: '{"elements": [{"uid": "1_4", "value": "text"}]} fill several fields',
  drag: '{"from_uid": "1_3", "to_uid": "1_5"} drag one element onto another',
  press_key: '{"key": "Control+A"} press a key or a chord',
  type_text: '{"text": "hello"} type into the focused element',
  upload_file: '{"uid": "1_3", "filePaths": ["/path/to/file"]} give a file input files',
  handle_dialog: '{"action": "accept"|"dismiss"} answer the page dialog',
  take_screenshot: '{"format": "png"|"jpeg"|"webp", "uid": "1_3", "fullPage": true} capture the page',
  evaluate_script: '{"function": "() => document.title"} run a function in the page',
  wait_for: '{"text": ["Done"]} wait for text to appear',
  list_console_messages: 'list the console messages since the last navigation',
  get_console_message: '{"msgid": 3} one console message with its arguments and stack',
  list_network_requests: 'list the network requests since the last navigation',
  get_network_request: '{"reqid": 2} one request with headers and bodies',
  emulate: '{"viewport": "1280x900x2,mobile", "colorScheme": "dark"} emulate the device',
  resize_page: '{"width": 1280, "height": 900} resize the emulated viewport',
  get_css_styles: '{"uid": "1_3"} the matched CSS rules for an element, paginated',
  take_heapsnapshot: '{"filePath": "/path/heap.heapsnapshot"} write a V8 heap snapshot',
  screencast_start: '{"filePath": "/path/frames"} start recording frames of the page',
  screencast_stop: 'stop the recording and name where its frames were saved',
  performance_start_trace: '{"reload": true, "autoStop": true} record a Chrome trace',
  performance_stop_trace: 'stop the trace and summarise it',
}

/** The error a blocked call reports, naming the dialog so the caller knows what to do. */
function dialogBlocked(page) {
  return new Error(
    `Blocked by a ${page.dialog.type} dialog: ${JSON.stringify(page.dialog.message)}. Call handle_dialog to answer it.`,
  )
}

/** Make the screenshot directory inside the tool's state directory. */
function screenshotDir(stateDir) {
  const dir = join(stateDir, 'screenshots')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Build the handlers.
 *
 * `stateDir` is where screenshots and saved snapshots default to; the session host passes its own, so
 * a CLI call and an in-process call put their evidence in the same place.
 */
export function createTools(browser, { stateDir }) {
  /** The page a call means, refusing politely when a dialog owns the page. */
  const pageFor = (tool, args = {}) => {
    const page = browser.page(args.pageId)
    if (page.dialog !== undefined && BLOCKED_BY_DIALOG.has(tool)) throw dialogBlocked(page)
    return page
  }

  /**
   * Stop the trace on a page, write the file and summarise it.
   *
   * A named function rather than `this.performance_stop_trace`: a handler is invoked detached from the
   * table (`handler(args)`), so `this` is not the object and a self-call would throw.
   */
  const stopTrace = async (page, args = {}) => {
    if (page.trace === undefined) throw new Error('no performance trace is recording on this page')
    const trace = page.trace
    page.trace = undefined
    try {
      await page.send('Tracing.end')
      await trace.completed
    } finally {
      trace.remove()
    }
    const filePath = typeof args.filePath === 'string' && args.filePath.length > 0 ? args.filePath : trace.filePath
    writeFileSync(filePath, JSON.stringify({ traceEvents: trace.events }))
    const byName = new Map()
    let startedAt
    let endedAt
    for (const event of trace.events) {
      byName.set(event.name, (byName.get(event.name) ?? 0) + 1)
      if (typeof event.ts === 'number') {
        startedAt = startedAt === undefined ? event.ts : Math.min(startedAt, event.ts)
        endedAt = endedAt === undefined ? event.ts : Math.max(endedAt, event.ts)
      }
    }
    const top = [...byName.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5)
    const durationMs = startedAt !== undefined && endedAt !== undefined ? Math.round((endedAt - startedAt) / 1000) : undefined
    const lines = ['## Performance trace', `events: ${trace.events.length}`, ...(durationMs !== undefined ? [`duration: ${durationMs}ms`] : []), `saved: ${filePath}`]
    for (const [name, count] of top) lines.push(`${count}× ${name}`)
    return { path: filePath, events: trace.events.length, durationMs, top: Object.fromEntries(top), text: lines.join('\n') }
  }

  /** A fresh snapshot, attached to a response that asked for one. */
  const withSnapshot = async (page, result, include) => {
    if (include !== true) return result
    const snapshot = await takeSnapshot(page)
    return { ...result, snapshot: snapshot.text }
  }

  return {
    async list_pages() {
      const pages = await browser.listPages()
      return { pages, text: formatPages(pages) }
    },

    async new_page(args = {}) {
      if (typeof args.url !== 'string' || !/^[a-z][a-z0-9+.-]*:/i.test(args.url)) {
        throw new Error(`new_page needs a full URL with a scheme; got '${String(args.url)}'`)
      }
      const page = await browser.newPage({
        url: args.url,
        background: args.background === true,
        isolatedContext: typeof args.isolatedContext === 'string' && args.isolatedContext.length > 0 ? args.isolatedContext : undefined,
      })
      const state = await page.describe()
      const pages = await browser.listPages()
      return { pageId: page.pageId, url: state.url, title: state.title, pages, text: formatPages(pages) }
    },

    async select_page(args = {}) {
      if (args.pageId === undefined) throw new Error('select_page needs a pageId')
      const page = browser.selectPage(Number(args.pageId), args.bringToFront === true)
      const pages = await browser.listPages()
      return { pageId: page.pageId, pages, text: formatPages(pages) }
    },

    async close_page(args = {}) {
      if (args.pageId === undefined) throw new Error('close_page needs a pageId')
      try {
        const page = await browser.closePage(Number(args.pageId))
        const pages = await browser.listPages()
        return { closed: page.pageId, pages, text: formatPages(pages) }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message !== 'The last open page cannot be closed. It is fine to keep it open.') throw error
        const pages = await browser.listPages()
        return { closed: undefined, note: message, pages, text: `${message}\n${formatPages(pages)}` }
      }
    },

    async navigate_page(args = {}) {
      const page = pageFor('navigate_page', args)
      const type = args.type ?? (args.url !== undefined ? 'url' : undefined)
      if (type === undefined) throw new Error('navigate_page needs a url or a type')
      if (type === 'url' && typeof args.url !== 'string') throw new Error('navigate_page with type=url needs a url')
      let loaded = true
      try {
        const result = await page.navigate({
          url: args.url,
          type,
          ignoreCache: args.ignoreCache === true,
          handleBeforeUnload: args.handleBeforeUnload,
          initScript: args.initScript,
          timeoutMs: Number.isFinite(args.timeout) && args.timeout > 0 ? args.timeout : undefined,
        })
        loaded = result.loaded
      } catch (error) {
        // A navigation that timed out is still worth reporting with the page's actual state.
        const state = await page.describe()
        return {
          url: state.url,
          title: state.title,
          loaded: false,
          note: `unable to confirm the navigation: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      const state = await page.describe()
      return { url: state.url, title: state.title, loaded }
    },

    async take_snapshot(args = {}) {
      const page = pageFor('take_snapshot', args)
      const snapshot = await takeSnapshot(page, { verbose: args.verbose === true })
      const state = await page.describe()
      if (typeof args.filePath === 'string' && args.filePath.length > 0) {
        writeFileSync(args.filePath, snapshot.text)
        return { filePath: args.filePath, page: state, snapshotId: snapshot.snapshotId }
      }
      return { page: state, snapshotId: snapshot.snapshotId, snapshot: snapshot.text, tree: snapshotToJson(snapshot.root) }
    },

    async click(args = {}) {
      const page = pageFor('click', args)
      if (typeof args.uid !== 'string' || args.uid.length === 0) throw new Error('click needs an element uid from a snapshot')
      const result = await click(page, { uid: args.uid, dblClick: args.dblClick === true })
      return withSnapshot(page, result, args.includeSnapshot)
    },

    async click_at(args = {}) {
      const page = pageFor('click_at', args)
      const result = await click(page, { x: Number(args.x), y: Number(args.y), dblClick: args.dblClick === true })
      return withSnapshot(page, result, args.includeSnapshot)
    },

    async hover(args = {}) {
      const page = pageFor('hover', args)
      if (typeof args.uid !== 'string') throw new Error('hover needs an element uid from a snapshot')
      const result = await hover(page, { uid: args.uid })
      return withSnapshot(page, result, args.includeSnapshot)
    },

    async fill(args = {}) {
      const page = pageFor('fill', args)
      if (typeof args.uid !== 'string') throw new Error('fill needs an element uid from a snapshot')
      const result = await fill(page, { uid: args.uid, value: args.value })
      return withSnapshot(page, result, args.includeSnapshot)
    },

    async fill_form(args = {}) {
      const page = pageFor('fill_form', args)
      const result = await fillForm(page, { elements: args.elements })
      return withSnapshot(page, result, args.includeSnapshot)
    },

    async drag(args = {}) {
      const page = pageFor('drag', args)
      if (typeof args.from_uid !== 'string' || typeof args.to_uid !== 'string') throw new Error('drag needs from_uid and to_uid')
      const result = await drag(page, { fromUid: args.from_uid, toUid: args.to_uid })
      return withSnapshot(page, result, args.includeSnapshot)
    },

    async press_key(args = {}) {
      const page = pageFor('press_key', args)
      const result = await pressKey(page, { key: args.key })
      return withSnapshot(page, result, args.includeSnapshot)
    },

    async type_text(args = {}) {
      const page = pageFor('type_text', args)
      const result = await typeText(page, { text: args.text, submitKey: args.submitKey })
      return withSnapshot(page, result, args.includeSnapshot)
    },

    async upload_file(args = {}) {
      const page = pageFor('upload_file', args)
      if (typeof args.uid !== 'string') throw new Error('upload_file needs the uid of a file input')
      const result = await uploadFile(page, { uid: args.uid, filePaths: args.filePaths })
      return withSnapshot(page, result, args.includeSnapshot)
    },

    async handle_dialog(args = {}) {
      const page = pageFor('handle_dialog', args)
      return handleDialog(page, { action: args.action, promptText: args.promptText })
    },

    async take_screenshot(args = {}) {
      const page = pageFor('take_screenshot', args)
      const format = ['png', 'jpeg', 'webp'].includes(args.format) ? args.format : 'png'
      const buffer = await page.screenshot({
        format,
        quality: Number.isFinite(args.quality) ? args.quality : undefined,
        fullPage: args.fullPage === true,
        uid: typeof args.uid === 'string' ? args.uid : undefined,
      })
      const extension = format === 'jpeg' ? 'jpg' : format
      const path =
        typeof args.filePath === 'string' && args.filePath.length > 0
          ? args.filePath
          : join(screenshotDir(stateDir), `screenshot-${Date.now()}.${extension}`)
      writeFileSync(path, buffer)
      const state = await page.describe()
      return { path, bytes: buffer.length, format, page: state }
    },

    async evaluate_script(args = {}) {
      const page = pageFor('evaluate_script', args)
      const result = await evaluateScript(page, {
        function: args.function,
        script: args.script,
        args: Array.isArray(args.args) ? args.args.map(String) : [],
        filePath: typeof args.filePath === 'string' && args.filePath.length > 0 ? args.filePath : undefined,
        dialogAction: args.dialogAction,
      })
      return result
    },

    async wait_for(args = {}) {
      const page = pageFor('wait_for', args)
      const result = await waitFor(page, { text: args.text, timeoutMs: Number.isFinite(args.timeout) && args.timeout > 0 ? args.timeout : undefined })
      const snapshot = await takeSnapshot(page)
      return { ...result, snapshot: snapshot.text }
    },

    async list_console_messages(args = {}) {
      const page = pageFor('list_console_messages', args)
      return formatConsoleList(page, {
        pageSize: Number.isFinite(args.pageSize) ? args.pageSize : undefined,
        pageIdx: Number.isFinite(args.pageIdx) ? args.pageIdx : undefined,
        types: Array.isArray(args.types) ? args.types : undefined,
        includePreservedMessages: args.includePreservedMessages === true,
        includeStackTraces: args.includeStackTraces === true,
      })
    },

    async get_console_message(args = {}) {
      const page = pageFor('get_console_message', args)
      const msgid = Number(args.msgid)
      if (!Number.isFinite(msgid)) throw new Error('get_console_message needs a msgid')
      const message = page.console.find((candidate) => candidate.msgid === msgid)
      if (message === undefined) throw new Error(`there is no console message with msgid ${msgid}`)
      return { message, text: formatConsoleMessageDetailed({ ...message, argsCount: message.args?.length ?? 0 }) }
    },

    async list_network_requests(args = {}) {
      const page = pageFor('list_network_requests', args)
      return formatNetworkList(page, {
        pageSize: Number.isFinite(args.pageSize) ? args.pageSize : undefined,
        pageIdx: Number.isFinite(args.pageIdx) ? args.pageIdx : undefined,
        includePreservedRequests: args.includePreservedRequests === true,
      })
    },

    async get_network_request(args = {}) {
      const page = pageFor('get_network_request', args)
      const reqid = Number(args.reqid)
      if (!Number.isFinite(reqid)) throw new Error('get_network_request needs a reqid')
      const entry = page.network.find((candidate) => candidate.reqid === reqid)
      if (entry === undefined) throw new Error(`there is no network request with reqid ${reqid}`)
      const bodies = {}
      try {
        const reply = await page.send('Network.getResponseBody', { requestId: entry.requestId })
        bodies.response = responseBodyText(reply.result.body, reply.result.base64Encoded)
        if (typeof args.responseFilePath === 'string' && args.responseFilePath.length > 0) {
          writeFileSync(args.responseFilePath, reply.result.base64Encoded === true ? Buffer.from(reply.result.body, 'base64') : reply.result.body)
          bodies.savedResponsePath = args.responseFilePath
        }
      } catch {
        bodies.response = '<not available anymore>'
      }
      if (typeof args.requestFilePath === 'string' && args.requestFilePath.length > 0 && entry.postData !== undefined) {
        writeFileSync(args.requestFilePath, entry.postData)
        bodies.savedRequestPath = args.requestFilePath
      }
      return {
        request: networkToJson(entry),
        text: await formatNetworkRequestDetailed(page, entry, bodies),
        ...(bodies.savedResponsePath !== undefined ? { responseFilePath: bodies.savedResponsePath } : {}),
        ...(bodies.savedRequestPath !== undefined ? { requestFilePath: bodies.savedRequestPath } : {}),
      }
    },

    async emulate(args = {}) {
      const page = pageFor('emulate', args)
      page.emulationSettings ??= {}
      const result = await emulate(page, args, page.emulationSettings)
      return { ...result, page: await page.describe() }
    },

    async resize_page(args = {}) {
      const page = pageFor('resize_page', args)
      return resizePage(page, { width: args.width, height: args.height })
    },

    /**
     * The CSS rules that apply to one element.
     *
     * Read from the protocol's own CSS domain rather than by walking `document.styleSheets`, because the
     * protocol answers with what the browser **applied** — the cascade, the inherited declarations, the
     * user-agent rules and the inline style — which a page-side walk cannot reconstruct.
     */
    async get_css_styles(args = {}) {
      const page = pageFor('get_css_styles', args)
      if (typeof args.uid !== 'string' || args.uid.length === 0) throw new Error('get_css_styles needs an element uid from a snapshot')
      const node = page.uidToNode.get(args.uid)
      if (node?.backendNodeId === undefined) throw new Error(`the snapshot has no DOM element with uid ${args.uid}; take a new snapshot`)
      await page.send('CSS.enable')
      // The CSS agent answers node queries only once a document has been requested for the session.
      await page.send('DOM.getDocument', { depth: 0 })
      const nodeId = await page.frontendNodeId(node.backendNodeId)
      const matched = await page.send('CSS.getMatchedStylesForNode', { nodeId })
      const rules = []
      const describe = (rule, origin) => {
        if (rule?.selectorList?.text === undefined) return
        const declarations = (rule.style?.cssProperties ?? [])
          .filter((property) => property.name !== undefined && property.value !== undefined)
          .map((property) => `${property.name}: ${property.value}${property.important === true ? ' !important' : ''}`)
        rules.push({ origin, selector: rule.selectorList.text, declarations })
      }
      for (const entry of matched.result?.matchedCSSRules ?? []) describe(entry.rule, entry.rule?.origin)
      describe(matched.result?.inlineStyle, 'inline')
      describe(matched.result?.attributesStyle, 'attribute')
      const { items, pagination } = paginate(rules, {
        pageSize: Number.isFinite(args.pageSize) && args.pageSize > 0 ? args.pageSize : 10,
        pageIdx: Number.isFinite(args.pageIdx) ? args.pageIdx : 0,
      })
      const lines = ['## CSS styles', ...paginationLines(pagination)]
      if (items.length === 0) lines.push('<no matched rules found>')
      for (const item of items) {
        lines.push(`${item.selector}  (${item.origin ?? 'author'})`)
        for (const declaration of item.declarations) lines.push(`  ${declaration}`)
      }
      return { uid: args.uid, rules: items, pagination, text: lines.join('\n') }
    },

    /**
     * Start capturing a Chrome trace.
     *
     * DSH's tool records with the DevTools frontend's categories and answers with an insight set; this
     * one records the protocol's own `Tracing` events, which is what a dependency-free driver can do.
     * The trace is real — it is the file the DevTools Performance panel opens — and `performance_stop_trace`
     * summarises it. The insight analysis is a frontend model and is named as excluded in the index.
     */
    async performance_start_trace(args = {}) {
      const page = pageFor('performance_start_trace', args)
      if (page.trace !== undefined) throw new Error('a performance trace is already recording on this page')
      const filePath = typeof args.filePath === 'string' && args.filePath.length > 0 ? args.filePath : join(stateDir, 'traces', `trace-${Date.now()}.json`)
      mkdirSync(join(stateDir, 'traces'), { recursive: true })
      const events = []
      const remove = page.connection.on('Tracing.dataCollected', (params, message) => {
        if (message.sessionId !== page.sessionId) return
        if (Array.isArray(params.value)) events.push(...params.value)
      })
      const completed = page.connection.once('Tracing.tracingComplete', 60_000)
      await page.send('Tracing.start', {
        categories: 'devtools.timeline,blink.user_timing,loading,v8.execute',
        options: 'sampling-frequency=10000',
        transferMode: 'ReportEvents',
      })
      page.trace = { filePath, events, remove, completed }
      if (args.reload === true) {
        await page.navigate({ url: page.url, type: 'reload' }).catch(() => {})
      }
      if (args.autoStop === true) return stopTrace(page, args)
      return { path: filePath, text: `The performance trace is being recorded; stop it to save ${filePath}` }
    },

    /** Stop the trace, write the file the Performance panel opens, and summarise it. */
    async performance_stop_trace(args = {}) {
      return stopTrace(pageFor('performance_stop_trace', args), args)
    },

    /**
     * Record frames of the page.
     *
     * DSH's screencast encodes a video in the DevTools frontend; the protocol itself hands over JPEG
     * frames, which is what this tool writes — one file per frame in the directory the caller names.
     * The claim is that the page's frames were captured, not that a container was muxed.
     */
    async screencast_start(args = {}) {
      const page = pageFor('screencast_start', args)
      if (page.screencast !== undefined) throw new Error('a screencast is already recording on this page')
      const dir = typeof args.filePath === 'string' && args.filePath.length > 0 ? args.filePath : join(stateDir, 'screencast', `cast-${Date.now()}`)
      mkdirSync(dir, { recursive: true })
      const frames = []
      const remove = page.connection.on('Page.screencastFrame', (params, message) => {
        if (message.sessionId !== page.sessionId) return
        const file = join(dir, `frame-${String(frames.length).padStart(5, '0')}.jpeg`)
        writeFileSync(file, Buffer.from(params.data, 'base64'))
        frames.push(file)
        void page.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
      })
      await page.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1280, maxHeight: 900, everyNthFrame: 1 })
      page.screencast = { dir, frames, remove }
      return { path: dir, text: `Screencast recording started, saving frames to ${dir}` }
    },

    /** Stop the recording and report where its frames were saved. */
    async screencast_stop(args = {}) {
      const page = pageFor('screencast_stop', args)
      if (page.screencast === undefined) throw new Error('no screencast is recording on this page')
      const cast = page.screencast
      page.screencast = undefined
      cast.remove()
      await page.send('Page.stopScreencast').catch(() => {})
      return { path: cast.dir, frames: cast.frames.length, text: `The screencast recording has been stopped and saved to ${cast.dir} (${cast.frames.length} frames)` }
    },

    /**
     * A V8 heap snapshot of the page.
     *
     * The snapshot arrives as a stream of text chunks rather than as one reply, so the listener is
     * attached before the call is made and the call's answer only says the profile is complete. The
     * file is the DevTools `.heapsnapshot` format; the analysis tools are not implemented (they parse it
     * with the DevTools heap worker), so the claim here is only that the capture is written.
     */
    async take_heapsnapshot(args = {}) {
      const page = pageFor('take_heapsnapshot', args)
      const filePath =
        typeof args.filePath === 'string' && args.filePath.length > 0
          ? args.filePath
          : join(stateDir, 'heap', `heap-${Date.now()}.heapsnapshot`)
      mkdirSync(join(stateDir, 'heap'), { recursive: true })
      await page.send('HeapProfiler.enable')
      const chunks = []
      const remove = page.connection.on('HeapProfiler.addHeapSnapshotChunk', (params, message) => {
        if (message.sessionId !== page.sessionId) return
        if (typeof params.chunk === 'string') chunks.push(params.chunk)
      })
      try {
        await page.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false }, { timeoutMs: 120_000 })
      } finally {
        remove()
      }
      const body = chunks.join('')
      if (body.length === 0) throw new Error('the browser sent no heap snapshot chunks')
      writeFileSync(filePath, body)
      return { path: filePath, bytes: body.length, text: `Heap snapshot saved to ${filePath}` }
    },
  }
}
