import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { trackScratch, untrackScratch } from './scratch.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { releaseChromeOutput } from '../browser-use/chrome.mjs'
import { browserAvailable as toolBrowserAvailable, browserPath, openBrowser as openToolBrowser } from '../browser-use/lib.mjs'

/**
 * A browser, driven over the browser tool, for the checks that need a page.
 *
 * This is the **one-page wrapper** over [`_tools_/browser-use/`](../browser-use/INDEX.md): the tool
 * owns the protocol, the snapshot and the session, and this file keeps the small API the checks were
 * written against — `goto`, `evaluate`, `waitFor`, `screenshot`, `close` — so that a check exercises
 * the same driver the command line runs rather than a second implementation of it.
 *
 * A unit test cannot see the class of bug this exists for. The Web UI's own history view was **blank**
 * while every endpoint it needed answered `200`: the page's log region was written only by the live
 * `EventSource`, so selecting a session set the id it filtered on and then had nothing to show. Nothing
 * but a browser could tell that apart from a working page, which is why this lives here — and why the
 * check that uses it is the one that would have caught it.
 *
 * Each call gets a **browser and profile of its own**, removed at `close()`: a check that shares the
 * operator's browser could inherit a login, a stored state or a lock, and two checks running at once
 * would fight over it.
 */

/**
 * Whether a check may use a browser here.
 *
 * Two conditions: this machine has a browser, **and** the run asks for the UI target. `HEDDLE_VERIFY_UI=0` is the standard
 * deployment's run — it skips every browser check with a labelled reason, so a server or CI host without a browser can still
 * judge everything that does not need a page. The browser checks are the slow half of the suite, and they are their own target.
 *
 * @returns true when the UI target is enabled and a browser binary exists.
 */
export function browserAvailable(override) {
  if (process.env.HEDDLE_VERIFY_UI === '0') return false
  return toolBrowserAvailable(override)
}

export { browserPath }

/**
 * Open a browser and return a page you can look at more than once.
 *
 * `visible: true` opens a real window, for a check a person needs to watch; the default is headless
 * because a check that opens a window steals focus on the machine it runs on. The caller must `close()`.
 */
export async function openBrowser(options = {}) {
  const profile = trackScratch(mkdtempSync(join(tmpdir(), 'heddle-check-browser-')))
  let browser
  try {
    browser = await openToolBrowser({
      headless: options.visible !== true,
      width: options.width,
      height: options.height,
      colorScheme: options.colorScheme,
      binary: options.binary,
      profile,
    })
  } catch (error) {
    rmSync(profile, { recursive: true, force: true })
    throw error
  }
  trackScratch(profile, browser.running?.child) // a check that never calls close() still leaves no profile
  const page = browser.page()
  return {
    /** The page-level protocol call, for the one thing the wrapper does not cover. */
    send: (method, params) => page.send(method, params),
    /** Navigate and resolve once the new document can be read. */
    async goto(url, timeoutMs = 20_000) {
      await page.navigate({ url, timeoutMs })
      return this
    },
    /** Evaluate an expression and return its value. */
    evaluate: (expression, timeoutMs = 10_000) => page.evaluate(expression, { timeoutMs }),
    /** Wait for an expression to become truthy; resolve true or throw on timeout. */
    waitFor: (expression, timeoutMs = 15_000) => page.waitForExpression(expression, timeoutMs),
    /** Save a screenshot and return its path. */
    async screenshot(path) {
      writeFileSync(path, await page.screenshot({ format: 'png' }))
      return path
    },
    /**
     * Shut the browser down and remove the profile that was only for this call.
     *
     * The kill is **synchronous**, before the first `await`, and that is deliberate: checks were
     * written against a helper whose `close()` was a few synchronous calls, and a close that only
     * starts asynchronously leaves a browser holding an `EventSource` open while the check's own
     * server shuts down — measured as a test whose promise never settled once the event loop drained.
     */
    async close() {
      try {
        browser.running?.child?.kill('SIGKILL')
      } catch {
        // A browser that is already gone is the state this wants.
      }
      // Helpers may retain inherited pipe descriptors after the main browser is killed.
      releaseChromeOutput(browser.running?.child)
      browser.connection?.close()
      await browser.close()
      // Chrome keeps writing its profile while it exits, so a single rm loses the race (ENOTEMPTY).
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          rmSync(profile, { recursive: true, force: true })
          untrackScratch(profile)
          return
        } catch {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
        }
      }
    },
  }
}
