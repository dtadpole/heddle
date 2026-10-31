import { existsSync, writeFileSync } from 'node:fs'

/**
 * One page: the protocol calls that are about a single document, and the state that only makes sense
 * per document.
 *
 * Everything here was learned from a measurement rather than read off a specification, and the two
 * that matter are worth stating where they are implemented rather than in a design note:
 *
 * - **The execution context is replaced by every navigation**, and an evaluation sent between the old
 *   context dying and the new one existing is answered with an empty remote object rather than an
 *   error. A page with an `iframe` also creates a second default context; taking the newest one points
 *   every reading at the iframe. So contexts are kept *by frame* and the top frame's is chosen.
 * - **`Page.loadEventFired` never fires for a page that keeps loading**, and it fires before the new
 *   execution context exists. Waiting on the event therefore has to be followed by waiting on the
 *   context, or the first reading after a navigation is the old document's.
 */

/** How long a protocol call to the page may take before it is reported as unanswered. */
const CALL_TIMEOUT_MS = 30_000

/**
 * A page target, attached to the browser's connection.
 *
 * `send` names the session on every call: the browser socket carries several pages at once, and a call
 * without a session would be a browser-level call that silently ignores page methods.
 */
export class Page {
  constructor(browser, { targetId, sessionId, pageId, browserContextId }) {
    this.browser = browser
    this.connection = browser.connection
    this.targetId = targetId
    this.sessionId = sessionId
    this.pageId = pageId
    this.browserContextId = browserContextId
    /** The last URL the protocol reported, used when a caller lists pages. */
    this.url = 'about:blank'
    this.title = ''

    /** The top frame's id, and the live default context of each frame, by frame id. */
    this.mainFrameId = undefined
    this.contexts = new Map()
    this.fallbackContextId = undefined
    /** The still-open JavaScript dialog, if any. */
    this.dialog = undefined
    /** The `dialogAction` a navigation in flight asked for, so a `beforeunload` can be answered. */
    this.pendingDialogAction = undefined
    /** uids from the last snapshot, to the protocol node they name, and the key each uid was given for. */
    this.uidToNode = new Map()
    this.uidByKey = new Map()
    this.uidSnapshotId = 0
    /**
     * Bumped on every top-frame navigation of this page, so a collector can tell this page's live document
     * from its earlier ones. It is the page's own: with one counter for the browser, a navigation in another
     * tab made this page's live entries look old, and four of them hid even the preserved ones.
     */
    this.navigationEpoch = 0
    /** Console and network collectors, filled while the page lives and emptied only by a caller. */
    this.console = []
    this.network = []
    this.networkById = new Map()
    this.consoleCount = 0
    this.networkCount = 0
    /** Script identifiers added by `initScript`, removed when the page is closed. */
    this.initScripts = []

    this.#listen()
  }

  #on(method, handler) {
    return this.connection.on(method, (params, message) => {
      if (message.sessionId !== this.sessionId) return
      handler(params ?? {})
    })
  }

  #listen() {
    this.#on('Page.frameNavigated', ({ frame }) => {
      if (frame !== undefined && frame.parentId === undefined) {
        this.mainFrameId = frame.id
        this.url = frame.url
        /**
         * A new document means every uid taken from the old one names an element that is gone. Keeping
         * them would let a stale snapshot click a lookalike on the new page, which is worse than
         * refusing a uid the caller should have re-read.
         */
        this.uidToNode.clear()
        this.uidByKey.clear()
        this.navigationEpoch += 1
      }
    })
    this.#on('Runtime.executionContextCreated', ({ context }) => {
      if (context === undefined || context.auxData?.isDefault !== true) return
      const frameId = context.auxData?.frameId
      if (typeof frameId === 'string') this.contexts.set(frameId, context.id)
      else if (this.fallbackContextId === undefined) this.fallbackContextId = context.id
    })
    this.#on('Runtime.executionContextsCleared', () => {
      this.contexts.clear()
      this.fallbackContextId = undefined
    })
    this.#on('Page.javascriptDialogOpening', (dialog) => {
      this.dialog = dialog
      /**
       * A `beforeunload` dialog is answered on behalf of a navigation that asked for one, because a
       * navigation that hangs on a question nobody can see looks exactly like a page that is slow.
       */
      const action = this.pendingDialogAction ?? 'accept'
      if (dialog.type === 'beforeunload' && this.pendingDialogAction !== undefined) {
        void this.send('Page.handleJavaScriptDialog', { accept: action === 'accept' }).catch(() => {})
        this.dialog = undefined
      }
    })
    this.#on('Page.javascriptDialogClosed', () => {
      this.dialog = undefined
    })
    this.#on('Runtime.consoleAPICalled', (event) => this.#recordConsole(event))
    this.#on('Runtime.exceptionThrown', (event) => this.#recordException(event))
    this.#on('Log.entryAdded', (event) => this.#recordLog(event))
    this.#on('Network.requestWillBeSent', (event) => this.#recordRequest(event))
    this.#on('Network.responseReceived', (event) => this.#recordResponse(event))
    this.#on('Network.loadingFinished', (event) => this.#recordFinished(event))
    this.#on('Network.loadingFailed', (event) => this.#recordFailed(event))
  }

  #recordConsole(event) {
    const type = event.type === 'warning' ? 'warn' : event.type
    const args = Array.isArray(event.args) ? event.args.map(describeRemoteObject) : []
    const text = args.length > 0 ? args.map((arg) => arg.text).join(' ') : ''
    this.console.push({
      msgid: ++this.consoleCount,
      type,
      text,
      args: args.map((arg) => arg.json ?? arg.text),
      url: event.stackTrace?.callFrames?.[0]?.url,
      line: event.stackTrace?.callFrames?.[0]?.lineNumber,
      stack: stackLines(event.stackTrace),
      timestamp: event.timestamp,
      navigation: this.navigationEpoch,
    })
  }

  #recordException(event) {
    const details = event.exceptionDetails ?? {}
    const exception = details.exception
    const text =
      exception?.description ?? details.text ?? 'an exception was thrown in the page'
    this.console.push({
      msgid: ++this.consoleCount,
      type: 'error',
      text,
      url: details.url,
      line: details.lineNumber,
      stack: stackLines(details.stackTrace),
      timestamp: event.timestamp,
      navigation: this.navigationEpoch,
    })
  }

  #recordLog(event) {
    const entry = event.entry ?? {}
    const type = entry.level === 'warning' ? 'warn' : entry.level
    this.console.push({
      msgid: ++this.consoleCount,
      type,
      text: entry.text ?? '',
      url: entry.url,
      line: entry.lineNumber,
      timestamp: entry.timestamp,
      navigation: this.navigationEpoch,
    })
  }

  #recordRequest(event) {
    const request = event.request ?? {}
    const entry = {
      reqid: ++this.networkCount,
      requestId: event.requestId,
      url: request.url,
      method: request.method,
      type: event.type,
      postData: request.postData,
      requestHeaders: { ...(request.headers ?? {}) },
      startedAt: event.timestamp,
      status: undefined,
      statusText: undefined,
      responseHeaders: undefined,
      mimeType: undefined,
      size: undefined,
      duration: undefined,
      failed: undefined,
      navigation: this.navigationEpoch,
    }
    this.network.push(entry)
    this.networkById.set(event.requestId, entry)
    if (this.network.length > 2_000) {
      const dropped = this.network.shift()
      if (dropped !== undefined) this.networkById.delete(dropped.requestId)
    }
  }

  #recordResponse(event) {
    const entry = this.networkById.get(event.requestId)
    if (entry === undefined) return
    const response = event.response ?? {}
    entry.status = response.status
    entry.statusText = response.statusText
    entry.mimeType = response.mimeType
    entry.responseHeaders = { ...(response.headers ?? {}) }
  }

  #recordFinished(event) {
    const entry = this.networkById.get(event.requestId)
    if (entry === undefined) return
    entry.size = event.encodedDataLength
    if (entry.startedAt !== undefined && event.timestamp !== undefined) entry.duration = event.timestamp - entry.startedAt
    entry.finished = true
  }

  #recordFailed(event) {
    const entry = this.networkById.get(event.requestId)
    if (entry === undefined) return
    entry.failed = event.errorText ?? 'the request failed'
    entry.finished = true
    if (entry.startedAt !== undefined && event.timestamp !== undefined) entry.duration = event.timestamp - entry.startedAt
  }

  /** Send one protocol call to this page's session. */
  send(method, params = {}, options = {}) {
    return this.connection.send(method, params, { sessionId: this.sessionId, timeoutMs: options.timeoutMs ?? CALL_TIMEOUT_MS })
  }

  /** Resolve with the next event of one method on this page, or `null` when it does not arrive. */
  once(method, timeoutMs) {
    return new Promise((resolvePromise) => {
      const remove = this.connection.on(method, (params, message) => {
        if (message.sessionId !== this.sessionId) return
        clearTimeout(timer)
        remove()
        resolvePromise(params)
      })
      const timer = setTimeout(() => {
        remove()
        resolvePromise(null)
      }, timeoutMs)
    })
  }

  /** The live top-frame execution context, once one exists. */
  liveContextId() {
    return (this.mainFrameId !== undefined ? this.contexts.get(this.mainFrameId) : undefined) ?? this.fallbackContextId
  }

  /** Wait until the page has a top-frame execution context, up to a deadline. */
  async waitForContext(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs
    while (this.liveContextId() === undefined && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
    }
    return this.liveContextId()
  }

  /**
   * Evaluate one expression in the page and return its value.
   *
   * The retry is not for the page being busy: a navigation destroys the context, and an evaluation
   * issued into the gap the protocol answers with an empty result. Waiting for the context and trying
   * again turns that into a value.
   */
  async evaluate(expression, { timeoutMs = 15_000, byValue = true } = {}) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const contextId = this.liveContextId()
      let reply
      try {
        reply = await this.send(
          'Runtime.evaluate',
          {
            expression,
            returnByValue: byValue,
            awaitPromise: true,
            ...(contextId !== undefined ? { contextId } : {}),
          },
          { timeoutMs },
        )
      } catch (error) {
        if (Date.now() > deadline) throw error
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
        continue
      }
      const details = reply.result?.exceptionDetails
      if (details !== undefined) {
        if (Date.now() > deadline) {
          const description = details.exception?.description ?? details.text ?? 'the expression threw'
          throw new Error(description)
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
        continue
      }
      const remote = reply.result?.result
      if (remote !== undefined) return remote.value
      if (Date.now() > deadline) return undefined
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }
  }

  /** Enable the domains this tool uses, once, when the page is attached. */
  async enable() {
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Network.enable')
    await this.send('Log.enable')
    await this.send('DOM.enable')
  }

  /** The current document's title and URL, read from the page rather than remembered. */
  async describe() {
    try {
      const value = await this.evaluate('({ title: document.title, url: location.href })', { timeoutMs: 5_000 })
      if (value !== undefined && value !== null) {
        this.title = String(value.title ?? '')
        this.url = String(value.url ?? this.url)
      }
    } catch {
      // A page mid-navigation has no context to read; the remembered values are the honest answer.
    }
    return { url: this.url, title: this.title }
  }

  /**
   * Navigate, and wait for the new document.
   *
   * `type` is `url`, `back`, `forward` or `reload`. `handleBeforeUnload` decides what a `beforeunload`
   * dialog is answered while this navigation is in flight; the default is the browser's own, which
   * accepts, because a navigation the caller asked for should not need a second command to finish.
   */
  async navigate({ url, type = 'url', ignoreCache = false, handleBeforeUnload = 'accept', initScript, timeoutMs = 30_000 }) {
    if (initScript !== undefined && initScript.length > 0) {
      const reply = await this.send('Page.addScriptToEvaluateOnNewDocument', { source: initScript })
      this.initScripts.push(reply.result.identifier)
    }
    this.pendingDialogAction = handleBeforeUnload
    const loaded = this.once('Page.loadEventFired', timeoutMs)
    try {
      if (type === 'url') {
        if (url === undefined) throw new Error('navigate_page with type=url needs a url')
        const reply = await this.send('Page.navigate', { url }, { timeoutMs })
        if (reply.result?.errorText !== undefined) {
          throw new Error(`the browser could not navigate to ${url}: ${reply.result.errorText}`)
        }
      } else if (type === 'reload') {
        await this.send('Page.reload', { ignoreCache }, { timeoutMs })
      } else if (type === 'back' || type === 'forward') {
        const history = await this.send('Page.getNavigationHistory', {}, { timeoutMs })
        const { currentIndex, entries } = history.result
        const index = type === 'back' ? currentIndex - 1 : currentIndex + 1
        if (index < 0 || index >= entries.length) throw new Error(`there is no ${type} entry in this page's history`)
        await this.send('Page.navigateToHistoryEntry', { entryId: entries[index].id }, { timeoutMs })
      } else {
        throw new Error(`unknown navigation type '${type}'`)
      }
      const fired = await loaded
      await this.waitForContext(timeoutMs)
      if (type === 'url') this.url = url
      return { loaded: fired !== null }
    } finally {
      this.pendingDialogAction = undefined
    }
  }

  /** Wait for one of several strings to appear anywhere in the page's text. */
  async waitForText(texts, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs
    const needles = JSON.stringify(texts)
    while (Date.now() < deadline) {
      try {
        const found = await this.evaluate(`(() => {
          const needles = ${needles}
          const haystack = document.body ? document.body.innerText : ''
          return needles.find((needle) => haystack.includes(needle)) ?? null
        })()`, { timeoutMs: 3_000 })
        if (found !== null && found !== undefined) return found
      } catch {
        // Mid-navigation there is no document to read yet; the deadline decides when to stop.
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }
    throw new Error(`none of ${JSON.stringify(texts)} appeared on the page within ${timeoutMs}ms`)
  }

  /** Wait until the document reports `complete`, or the deadline passes. */
  async waitForReadyState(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate('document.readyState', { timeoutMs: 2_000 }) === 'complete') return true
      } catch {
        // The document being replaced has no context to answer from.
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    }
    return false
  }

  /** Wait until an expression is truthy, or report that it never was. */
  async waitForExpression(expression, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression, { timeoutMs: 3_000 })) return true
      } catch {
        // The page may be mid-navigation.
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }
    /**
     * A timeout is a **failure**, not a `false` a check can ignore: returning false let a check proceed to a
     * later assertion with stale state and report the wrong cause (the todo check did exactly that). The
     * expression is named so the failure says what never became true.
     */
    throw new Error(`timed out after ${timeoutMs}ms waiting for: ${expression}`)
  }

  /** Capture the page, or one element of it, as an image. */
  async screenshot({ format = 'png', quality, fullPage = false, uid } = {}) {
    let clip
    if (uid !== undefined) {
      const box = await this.elementBox(uid)
      clip = { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.width, height: box.height, scale: 1 }
    } else if (fullPage) {
      const metrics = await this.send('Page.getLayoutMetrics')
      const size = metrics.result.cssContentSize ?? metrics.result.contentSize
      clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }
    }
    const reply = await this.send(
      'Page.captureScreenshot',
      {
        format,
        ...(quality !== undefined && format !== 'png' ? { quality } : {}),
        ...(clip !== undefined ? { clip, captureBeyondViewport: true } : {}),
      },
      { timeoutMs: 60_000 },
    )
    return Buffer.from(reply.result.data, 'base64')
  }

  /** The content box of one element, in page coordinates, after scrolling it into view. */
  async elementBox(uid) {
    const node = this.uidToNode.get(uid)
    if (node === undefined) throw new Error(`the snapshot has no element with uid ${uid}; take a new snapshot`)
    if (node.backendNodeId === undefined) throw new Error(`the element with uid ${uid} has no node on this page; take a new snapshot`)
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId }).catch(() => {})
    const box = await this.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId })
    if (box.result?.model === undefined) throw new Error(`the element with uid ${uid} has no visible box (it may be hidden)`)
    const quad = box.result.model.border
    const xs = [quad[0], quad[2], quad[4], quad[6]]
    const ys = [quad[1], quad[3], quad[5], quad[7]]
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    const width = Math.max(...xs) - x
    const height = Math.max(...ys) - y
    if (!(width > 0 && height > 0)) throw new Error(`the element with uid ${uid} has an empty box`)
    return { x, y, width, height, centerX: x + width / 2, centerY: y + height / 2 }
  }

  /**
   * The CSS domain's own node id for a backend node.
   *
   * The accessibility tree and `DOM.getBoxModel` speak `backendNodeId`; `CSS.getMatchedStylesForNode`
   * speaks the frontend `nodeId`. `DOM.pushNodesByBackendIdsToFrontend` is the translation, and it can
   * answer `null` for a node that has gone away — which is a stale uid, reported as such by the caller.
   */
  async frontendNodeId(backendNodeId) {
    const reply = await this.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [backendNodeId] })
    const nodeId = reply.result?.nodeIds?.[0]
    if (nodeId === undefined || nodeId === null) throw new Error('the element is no longer on the page; take a new snapshot')
    return nodeId
  }

  /** Save an image, naming the path when the caller gave one. */
  static write(path, buffer) {
    writeFileSync(path, buffer)
    return path
  }

  /** Whether a path exists, for a screenshot destination that must not silently overwrite. */
  static exists(path) {
    return existsSync(path)
  }
}

/** Turn one `Runtime.RemoteObject` into text and a JSON value for a console message. */
function describeRemoteObject(object) {
  if (object === undefined || object === null) return { text: 'undefined' }
  if (object.type === 'string') return { text: String(object.value), json: object.value }
  if (object.type === 'undefined') return { text: 'undefined' }
  if (object.unserializableValue !== undefined) return { text: String(object.unserializableValue) }
  if (object.value !== undefined) {
    return { text: typeof object.value === 'string' ? object.value : JSON.stringify(object.value), json: object.value }
  }
  if (object.preview?.properties !== undefined) {
    const body = object.preview.properties.map((property) => `${property.name}: ${String(property.value)}`).join(', ')
    return { text: `${object.description ?? object.type} {${body}}`, json: undefined }
  }
  if (object.description !== undefined) return { text: String(object.description) }
  return { text: object.type ?? 'unknown' }
}

/** The call frames of a stack trace, as `url:line:column` strings. */
function stackLines(stackTrace) {
  if (stackTrace?.callFrames === undefined) return []
  return stackTrace.callFrames.map((frame) => `${frame.url || '<anonymous>'}:${frame.lineNumber}:${frame.columnNumber}`)
}
