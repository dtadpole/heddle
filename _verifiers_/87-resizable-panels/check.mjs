import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, isolatedHome, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Verifier — the resizable panels.
 *
 * Judges one claim: a reader can decide how much room the sidebar gets, with a mouse **or** a keyboard, and
 * the choice is remembered.
 *
 * The failure modes being guarded are the ones a screenshot cannot show: a divider that looks draggable and
 * is not (an early version called `setPointerCapture` unguarded, and a pointer the browser is not tracking
 * threw before the listeners were bound, so the drag did nothing), a drag that stops working when the
 * pointer leaves the divider, a width that can be dragged past the point where the content vanishes, and a
 * choice forgotten on reload.
 */

const CAPABILITY = 'a resizable sidebar driven by pointer and keyboard, with the width remembered'

/** Start the Web UI and resolve once it prints its URL. */
function startCli(args, env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { repoRoot } = await import('../../_tools_/verify-runner/lib.mjs')
      const { join: joinPath } = await import('node:path')
      const child = spawn(process.execPath, [joinPath(repoRoot, 'dist', 'cli.js'), ...args], {
        cwd: repoRoot,
        env: { ...process.env, NO_COLOR: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ child, url: match[1], output: () => output, kill: () => child.kill('SIGKILL') })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => {
        if (!settled) reject(new Error(`the server exited ${code} before printing a URL\n${output}`))
      })
    })()
  })
}

/** Whether this build serves a Web UI at all. */
async function supportsWeb() {
  const help = await runCli(['--help'])
  return /web/.test(help.stdout)
}

test('the sidebar is resizable by pointer and by keyboard, and the width is remembered', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return

  const home = isolatedHome('resize')
  const work = fixtureDir('resize')
  const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
    HEDDLE_HOME: home,
    HEDDLE_CONFIG: config,
  })
  const browser = await openBrowser({ width: 1400, height: 800 })
  try {
    await browser.goto(server.url)
    assert.ok(await browser.waitFor('document.getElementById("gutter-left") !== null', 20_000), 'the divider is there')

    /**
     * The divider is a control, not a styled border: `role="separator"` with a tabindex is what makes it
     * keyboard reachable, and the value attributes are what let assistive technology report the width.
     */
    const separator = JSON.parse(
      await browser.evaluate(`(() => {
        const gutter = document.getElementById('gutter-left')
        return JSON.stringify({
          role: gutter.getAttribute('role'),
          orientation: gutter.getAttribute('aria-orientation'),
          tabindex: gutter.tabIndex,
          hasValue: gutter.hasAttribute('aria-valuenow'),
          cursor: getComputedStyle(gutter).cursor
        })
      })()`),
    )
    assert.equal(separator.role, 'separator', 'it is a separator')
    assert.equal(separator.orientation, 'vertical', 'oriented with the edge it moves')
    assert.ok(separator.tabindex >= 0, 'and reachable by keyboard')
    assert.ok(separator.hasValue, 'with a value a screen reader can report')
    assert.equal(separator.cursor, 'col-resize', 'and a cursor that says it can be dragged')

    /** Drag it wider, the way a person does, with a pointer that has coordinates. */
    const dragged = JSON.parse(
      await browser.evaluate(`(() => {
        const gutter = document.getElementById('gutter-left')
        const sidebar = document.querySelector('aside')
        const before = Math.round(sidebar.getBoundingClientRect().width)
        const box = gutter.getBoundingClientRect()
        const fire = (type, clientX) => {
          const event = new Event(type, { bubbles: true })
          event.clientX = clientX
          event.clientY = box.top + box.height / 2
          event.pointerId = 1
          gutter.dispatchEvent(event)
        }
        fire('pointerdown', box.left + 1)
        fire('pointermove', box.left + 1 + 160)
        fire('pointerup', box.left + 1 + 160)
        return JSON.stringify({
          before,
          after: Math.round(sidebar.getBoundingClientRect().width),
          stored: Number(localStorage.getItem('heddle.layout.sidebar.v1'))
        })
      })()`),
    )
    assert.ok(dragged.after > dragged.before + 100, `dragging right widens the sidebar (${dragged.before} -> ${dragged.after})`)
    assert.ok(Math.abs(dragged.stored * 16 - dragged.after) <= 2, `and the stored width matches what is drawn (${dragged.stored}rem)`)

    /**
     * Dragging past the limits. A sidebar wider than the window's share leaves nothing to work in, and a
     * negative width is not a width — both read as the app being broken rather than as a choice.
     */
    const clamped = JSON.parse(
      await browser.evaluate(`(() => {
        const gutter = document.getElementById('gutter-left')
        const sidebar = document.querySelector('aside')
        const box = gutter.getBoundingClientRect()
        const fire = (type, clientX) => {
          const event = new Event(type, { bubbles: true })
          event.clientX = clientX
          event.clientY = box.top + box.height / 2
          event.pointerId = 1
          gutter.dispatchEvent(event)
        }
        fire('pointerdown', box.left + 1)
        fire('pointermove', window.innerWidth * 3)
        fire('pointerup', window.innerWidth * 3)
        const widest = Math.round(sidebar.getBoundingClientRect().width)
        fire('pointerdown', box.left + 1)
        fire('pointermove', -9999)
        fire('pointerup', -9999)
        return JSON.stringify({
          widest,
          narrowest: Math.round(sidebar.getBoundingClientRect().width),
          viewport: window.innerWidth,
          contentVisible: document.querySelector('main').getBoundingClientRect().width > 100
        })
      })()`),
    )
    assert.ok(clamped.widest < clamped.viewport * 0.9, `a drag past the limit leaves room to work (${clamped.widest}px of ${clamped.viewport}px)`)
    assert.ok(clamped.contentVisible, 'and the content is still there')
    assert.ok(clamped.narrowest >= 190, `and the sidebar cannot be dragged away entirely (${clamped.narrowest}px)`)

    /** The keyboard path, because a control that only works with a mouse is half a control. */
    const keyboard = JSON.parse(
      await browser.evaluate(`(() => {
        const gutter = document.getElementById('gutter-left')
        const sidebar = document.querySelector('aside')
        gutter.focus()
        const before = Math.round(sidebar.getBoundingClientRect().width)
        for (let index = 0; index < 3; index += 1) gutter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
        const afterRight = Math.round(sidebar.getBoundingClientRect().width)
        gutter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
        return JSON.stringify({ before, afterRight, afterLeft: Math.round(sidebar.getBoundingClientRect().width), focused: document.activeElement === gutter })
      })()`),
    )
    assert.ok(keyboard.focused, 'the divider takes focus')
    assert.ok(keyboard.afterRight > keyboard.before, `and the arrow keys move it (${keyboard.before} -> ${keyboard.afterRight})`)
    assert.ok(keyboard.afterLeft < keyboard.afterRight, 'in both directions')

    /** The choice survives a reload, or it was never a choice. */
    const remembered = Number(await browser.evaluate('localStorage.getItem("heddle.layout.sidebar.v1")'))
    await browser.goto(server.url)
    assert.ok(await browser.waitFor('document.getElementById("gutter-left") !== null', 20_000), 'the page came back')
    const restored = await browser.evaluate(`Math.round(document.querySelector('aside').getBoundingClientRect().width)`)
    assert.ok(
      Math.abs(restored - remembered * 16) <= 2,
      `the width is restored after a reload (${remembered}rem drawn as ${restored}px)`,
    )
    assert.equal(
      await browser.evaluate('document.getElementById("gutter-left").getAttribute("aria-valuenow")'),
      String(Math.round(remembered)),
      'and the control reports the width it is showing',
    )

    /**
     * The panel **collapses to a rail** — DSH's gesture, measured from it on 2026-10-17: 280 pixels expanded, 56
     * collapsed, the control at the top of the panel, the chord `Alt+Meta+B`, and the rail keeping its icon controls.
     *
     * The width is asserted rather than the class because the class is this project's name for it; 56 is the number a
     * reader sees, and a rail that drifted to 80 would still "collapse".
     */
    const expandedWidth = await browser.evaluate(`Math.round(document.querySelector('aside').getBoundingClientRect().width)`)
    const collapsed = JSON.parse(
      await browser.evaluate(`(() => {
        document.getElementById('sidebar-toggle').click()
        const aside = document.querySelector('aside')
        const main = document.querySelector('main')
        const toggle = document.getElementById('sidebar-toggle')
        return JSON.stringify({
          width: Math.round(aside.getBoundingClientRect().width),
          mainWidth: Math.round(main.getBoundingClientRect().width),
          label: toggle.getAttribute('aria-label'),
          expanded: toggle.getAttribute('aria-expanded'),
          treeVisible: getComputedStyle(document.getElementById('tree')).display !== 'none',
          gutterVisible: getComputedStyle(document.getElementById('gutter-left')).display !== 'none',
          searchVisible: getComputedStyle(document.getElementById('sidebar-search')).display !== 'none',
          stored: localStorage.getItem('heddle.layout.collapsed.v1')
        })
      })()`),
    )
    assert.equal(collapsed.width, 56, `the rail is 56 pixels wide (from ${expandedWidth})`)
    assert.ok(collapsed.mainWidth > expandedWidth, `and the column takes the space back (${collapsed.mainWidth})`)
    assert.equal(collapsed.label, 'Open sidebar', 'the control names the action, not the state')
    assert.equal(collapsed.expanded, 'false', 'and reports itself collapsed')
    assert.equal(collapsed.treeVisible, false, 'the tree is put away')
    assert.equal(collapsed.gutterVisible, false, 'and the divider with it, because a rail has no width to drag')
    assert.equal(collapsed.searchVisible, true, 'while the rail keeps a search control')
    assert.equal(collapsed.stored, 'true', 'and the choice is remembered')

    /**
     * The rail's top control is the **app's own icon**, which is what DSH's is: measured at 36×36, at (10, 18), named
     * `Open sidebar`, holding the brand mark rather than a generic panel glyph. The two are read per element — the icon
     * loaded and displayed, the panel glyph put away — because "the icon is there" is exactly the kind of claim that a
     * hidden element satisfies.
     */
    const icon = JSON.parse(
      await browser.evaluate(`(() => {
        const toggle = document.getElementById('sidebar-toggle')
        const mark = document.getElementById('sidebar-toggle-mark')
        const glyph = document.getElementById('sidebar-toggle-glyph')
        const box = mark.getBoundingClientRect()
        return JSON.stringify({
          label: toggle.getAttribute('aria-label'),
          markShown: getComputedStyle(mark).display !== 'none',
          markLoaded: mark.complete && mark.naturalWidth > 0,
          markBox: Math.round(box.width) + 'x' + Math.round(box.height),
          markSrc: mark.getAttribute('src'),
          glyphShown: getComputedStyle(glyph).display !== 'none',
          toggleBox: (() => { const r = toggle.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) })()
        })
      })()`),
    )
    assert.equal(icon.label, 'Open sidebar', 'the icon control is named for the action')
    assert.equal(icon.markShown, true, 'the app icon is displayed while the panel is a rail')
    assert.equal(icon.markLoaded, true, `and its picture loaded (${icon.markSrc})`)
    assert.equal(icon.markBox, '24x24', 'at 24 pixels, inside the 36-pixel control')
    assert.equal(icon.toggleBox, '36x36', 'which is the rail control DSH uses')
    assert.equal(icon.glyphShown, false, 'with the panel glyph put away')

    /** Remembered across a reload — better than DSH, which brings the wide panel back, and consistent with the width. */
    await browser.goto(server.url)
    assert.ok(await browser.waitFor('document.getElementById("sidebar-toggle") !== null', 20_000), 'the page came back')
    assert.equal(
      await browser.evaluate(`Math.round(document.querySelector('aside').getBoundingClientRect().width)`),
      56,
      'the rail is still collapsed after a reload',
    )

    /** The chord, which is DSH's own: `Alt+Meta+B`. */
    const chord = JSON.parse(
      await browser.evaluate(`(() => {
        document.getElementById('sidebar-toggle').focus()
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', altKey: true, metaKey: true, bubbles: true }))
        const aside = document.querySelector('aside')
        const toggle = document.getElementById('sidebar-toggle')
        return JSON.stringify({
          width: Math.round(aside.getBoundingClientRect().width),
          label: toggle.getAttribute('aria-label'),
          stored: localStorage.getItem('heddle.layout.collapsed.v1')
        })
      })()`),
    )
    assert.ok(chord.width > 100, `the chord opens the panel again (${chord.width})`)
    assert.equal(chord.label, 'Collapse sidebar', 'with the control naming the new action')
    assert.equal(chord.stored, 'false', 'and the state written back')
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
    removeDir(work)
  }
})
