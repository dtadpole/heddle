import { writeFileSync } from 'node:fs'

import { click, drag, evaluateScript, fill, fillForm, handleDialog, hover, pressKey, typeText } from './actions.mjs'
import { openBrowser } from './browser.mjs'
import { takeSnapshot } from './snapshot.mjs'

/**
 * The public library face of the browser tool.
 *
 * Two shapes, deliberately: `openBrowser` is the session-oriented API the CLI and the tools use, and
 * `openPage` is the one-browser-one-page shape the repository's checks were written against. They share
 * the same driver, so a check that passes through `openPage` has exercised the code the CLI runs.
 */

export { browserAvailable, browserPath, profileDir, stateDir } from './chrome.mjs'
export { Browser, CLOSE_PAGE_ERROR, openBrowser } from './browser.mjs'
export { takeSnapshot, formatSnapshot, snapshotToJson } from './snapshot.mjs'
export { click, drag, evaluateScript, fill, fillForm, handleDialog, hover, pressKey, typeText } from './actions.mjs'
export { emulate, parseGeolocation, parseHeaders, parseViewport, resizePage } from './emulate.mjs'
export { createTools, TOOL_HELP, TOOL_NAMES } from './tools.mjs'
export { paginate } from './format.mjs'

/**
 * Open one browser and one page, with the small API a check needs.
 *
 * `visible: true` opens a window a person can watch; the default is headless because a check that opens
 * a window steals focus on the machine it runs on. The returned object is deliberately plain: a check
 * that wants to click through the harness should use `openBrowser` and the tool functions instead.
 */
export async function openPage(options = {}) {
  const browser = await openBrowser({
    headless: options.visible !== true,
    width: options.width,
    height: options.height,
    colorScheme: options.colorScheme,
    binary: options.binary,
    profile: options.profile,
  })
  const page = browser.page()
  const handle = {
    browser,
    page,
    get pageId() {
      return page.pageId
    },
    /** A page-level protocol call, for what the wrapper does not cover. */
    send: (method, params) => page.send(method, params),
    /** Navigate and resolve once the new document can be read. */
    async goto(url, timeoutMs = 20_000) {
      await page.navigate({ url, timeoutMs })
      return handle
    },
    /** Evaluate an expression and return its value. */
    evaluate: (expression, timeoutMs = 10_000) => page.evaluate(expression, { timeoutMs }),
    /** Wait for an expression to become truthy; `true` when it did, `false` on timeout. */
    waitFor: (expression, timeoutMs = 15_000) => page.waitForExpression(expression, timeoutMs),
    /** Save a screenshot and return its path. */
    async screenshot(path) {
      const buffer = await page.screenshot({ format: 'png' })
      writeFileSync(path, buffer)
      return path
    },
    /** The whole surface, for a check that needs to act rather than to read. */
    tools: {
      click: (args) => click(page, args),
      fill: (args) => fill(page, args),
      fillForm: (args) => fillForm(page, args),
      hover: (args) => hover(page, args),
      drag: (args) => drag(page, args),
      pressKey: (args) => pressKey(page, args),
      typeText: (args) => typeText(page, args),
      evaluateScript: (args) => evaluateScript(page, { ...args, args: args?.args ?? [] }),
      handleDialog: (args) => handleDialog(page, args),
      takeSnapshot: (args) => takeSnapshot(page, args),
    },
    close: () => browser.close(),
  }
  return handle
}
