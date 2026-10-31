import { launchChrome, removeProfile, stopChrome } from './chrome.mjs'
import { connect } from './cdp.mjs'
import { Page } from './page.mjs'

/**
 * The browser and the pages open in it.
 *
 * This is the in-process half of the tool: a caller that imports it owns a browser for the length of
 * one job. The session host (`host.mjs`) puts the same object behind a socket so separate command
 * lines share it, which is the shape the harness's own browser tools have. Keeping one implementation
 * for both is deliberate — a check's browser and an operator's browser must be the same browser.
 */

/** The message the harness gives when its last page is asked to close. */
export const CLOSE_PAGE_ERROR = 'The last open page cannot be closed. It is fine to keep it open.'

/**
 * Open a browser and attach to its pages.
 *
 * The attach is **flattened**: pages are sessions on the one browser socket rather than sockets of
 * their own. That is what makes `Target.createTarget` plus a page command two calls on one connection,
 * and it is how the browser's own clients work.
 */
export async function openBrowser(options = {}) {
  const running = await launchChrome(options)
  const browser = new Browser(running, options)
  await browser.attach()
  return browser
}

export class Browser {
  constructor(running, options = {}) {
    this.running = running
    this.options = options
    this.connection = undefined
    this.pages = new Map()
    this.byTarget = new Map()
    this.contexts = new Map()
    this.selectedPageId = undefined
    this.nextPageId = 1
    this.dead = undefined
    this.pending = new Set()
  }

  /** Connect to the browser's endpoint and start listening for pages. */
  async attach() {
    this.connection = await connect(this.running.wsUrl)
    void this.connection.whenClosed().then((reason) => {
      this.dead = reason
    })
    this.connection.on('Target.attachedToTarget', (params) => {
      void this.#attached(params)
    })
    this.connection.on('Target.detachedFromTarget', ({ sessionId }) => {
      const page = [...this.pages.values()].find((candidate) => candidate.sessionId === sessionId)
      if (page === undefined) return
      this.pages.delete(page.pageId)
      this.byTarget.delete(page.targetId)
      if (this.selectedPageId === page.pageId) {
        const remaining = [...this.pages.keys()]
        this.selectedPageId = remaining.length > 0 ? remaining[0] : undefined
      }
    })
    this.connection.on('Target.targetInfoChanged', ({ targetInfo }) => {
      const page = this.byTarget.get(targetInfo?.targetId)
      if (page === undefined || targetInfo === undefined) return
      if (typeof targetInfo.url === 'string' && targetInfo.url.length > 0) page.url = targetInfo.url
      if (typeof targetInfo.title === 'string' && targetInfo.title.length > 0) page.title = targetInfo.title
    })
    await this.connection.send('Target.setDiscoverTargets', { discover: true })
    await this.connection.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'page' }],
    })
    /**
     * `setAutoAttach` attaches the targets that already exist; the browser starts with one
     * `about:blank` page, so waiting for an attachment rather than for a timeout is the difference
     * between a tool that starts in a second and one that starts after a fixed pause.
     */
    const deadline = Date.now() + 10_000
    while (this.pages.size === 0 && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
    if (this.pages.size === 0) {
      await this.connection.send('Target.createTarget', { url: 'about:blank' })
      const created = Date.now() + 10_000
      while (this.pages.size === 0 && Date.now() < created) await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
    }
    if (this.selectedPageId === undefined) this.selectedPageId = [...this.pages.keys()][0]
    return this
  }

  async #attached({ sessionId, targetInfo, waitingForDebugger }) {
    if (targetInfo?.type !== 'page') return
    if (waitingForDebugger === true) {
      void this.connection.send('Runtime.runIfWaitingForDebugger', {}, { sessionId }).catch(() => {})
    }
    // A target may be attached twice by a repeated discovery; one page per target is the contract.
    if (this.byTarget.has(targetInfo.targetId)) return
    const page = new Page(this, {
      targetId: targetInfo.targetId,
      sessionId,
      pageId: this.nextPageId++,
      browserContextId: targetInfo.browserContextId,
    })
    page.url = targetInfo.url ?? 'about:blank'
    page.title = targetInfo.title ?? ''
    this.pages.set(page.pageId, page)
    this.byTarget.set(page.targetId, page)
    if (this.selectedPageId === undefined) this.selectedPageId = page.pageId
    const enabling = page.enable().catch((error) => {
      // The page may have been closed while the domains were being enabled; that is not an error the
      // caller can act on, and the detach handler removes it.
      void error
    })
    this.pending.add(enabling)
    void enabling.finally(() => this.pending.delete(enabling))
  }

  /** The page a tool means: the one named, or the selected one. */
  page(pageId) {
    if (this.dead !== undefined) throw new Error(`the browser is no longer running: ${this.dead.message}`)
    const id = pageId ?? this.selectedPageId
    if (id === undefined) throw new Error('no page is open; call new_page first')
    const page = this.pages.get(id)
    if (page === undefined) {
      const known = [...this.pages.keys()].join(', ')
      throw new Error(`there is no page with id ${id}; open pages are ${known.length > 0 ? known : 'none'}`)
    }
    return page
  }

  /** Give every open page a number, a URL and a title. */
  async listPages() {
    const pages = [...this.pages.values()].sort((left, right) => left.pageId - right.pageId)
    const described = await Promise.all(
      pages.map(async (page) => {
        const state = await page.describe()
        return { pageId: page.pageId, url: state.url, title: state.title, selected: page.pageId === this.selectedPageId }
      }),
    )
    return described
  }

  /** Make one page the target of the tools that do not name one. */
  selectPage(pageId, bringToFront = false) {
    const page = this.page(pageId)
    this.selectedPageId = pageId
    if (bringToFront) void this.connection.send('Target.activateTarget', { targetId: page.targetId }).catch(() => {})
    return page
  }

  /** Open a page, optionally in a named, isolated browser context. */
  async newPage({ url = 'about:blank', background = false, isolatedContext } = {}) {
    let browserContextId
    if (isolatedContext !== undefined) {
      let context = this.contexts.get(isolatedContext)
      if (context === undefined) {
        const created = await this.connection.send('Target.createBrowserContext', { disposeOnDetach: false })
        context = created.result.browserContextId
        this.contexts.set(isolatedContext, context)
      }
      browserContextId = context
    }
    const before = new Set(this.pages.keys())
    const created = await this.connection.send('Target.createTarget', {
      url: 'about:blank',
      background,
      ...(browserContextId !== undefined ? { browserContextId } : {}),
    })
    const targetId = created.result.targetId
    const deadline = Date.now() + 15_000
    while (!this.byTarget.has(targetId) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
    }
    const page = this.byTarget.get(targetId)
    if (page === undefined) throw new Error('the browser opened a page but never exposed it; try again')
    await page.waitForContext(15_000)
    if (url !== 'about:blank') await page.navigate({ url, timeoutMs: this.options.navigationTimeoutMs ?? 30_000 })
    if (!background) this.selectedPageId = page.pageId
    void before
    return page
  }

  /** Close one page, refusing to close the last one. */
  async closePage(pageId) {
    const page = this.page(pageId)
    if (this.pages.size <= 1) throw new Error(CLOSE_PAGE_ERROR)
    await this.connection.send('Target.closeTarget', { targetId: page.targetId })
    const deadline = Date.now() + 10_000
    while (this.pages.has(pageId) && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
    return page
  }

  /** Shut the browser down and remove a profile that was only for this run. */
  async close() {
    await Promise.allSettled([...this.pending])
    try {
      if (this.connection !== undefined && this.dead === undefined) {
        await this.connection.send('Browser.close', {}, { timeoutMs: 2_000 })
      }
    } catch {
      // The browser may already be gone; the signals below are the fallback.
    }
    this.connection?.close()
    const running = this.running
    await stopChrome(running)
    if (running.temporaryProfile === true) await removeProfile(running.profile)
  }
}
