import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, isolatedHome, removeDir, runCli, scriptedConfig, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

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
  /**
   * A workspace with one folder in it, seeded before the server starts: the panel's primary action has to have
   * somewhere to start, and the tree's first-visit default only has a branch to open when one exists. Written in the
   * store's own shape rather than through the API, because registering a folder needs an authenticated request and this
   * part is about the panel, not about the registration route.
   */
  mkdirSync(join(work, 'notes'), { recursive: true })
  /**
   * Enough rows that the workspaces region overflows a short window. A scroll claim on a list that fits is a claim that
   * cannot fail, so the fixture has to be long: the tree draws one row per file, and the region is the thing under test.
   */
  for (let index = 0; index < 40; index += 1) {
    writeFileSync(join(work, `file-${String(index).padStart(2, '0')}.md`), `# ${index}\n`)
  }
  const seededAt = new Date().toISOString()
  writeJson(join(home, 'workspaces.json'), {
    version: 3,
    workspaceIds: ['w1'],
    workspaces: {
      w1: { id: 'w1', path: work, title: 'resize', origin: 'added', createdAt: seededAt, updatedAt: seededAt },
    },
  })
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

    /**
     * The panel's **primary action** — DSH's `New session`, measured on its sidebar on 2026-10-17: a full-width control
     * between the brand row and the workspace list, 14-pixel medium text, a 12-pixel radius, a 1-pixel 16%-white border,
     * and the chord `Alt+Meta+N`. Judged here because it is the sidebar's; the click is real, and what it must do is
     * start a conversation in the workspace the reader is looking at.
     */
    /**
     * The **empty state** — DSH's home, which this panel did not have: its centre carries the mark, a heading and the
     * chord rather than a column headed "No session". With no conversation open (this fixture has a workspace and no
     * sessions), the invitation is shown and the conversation's own column is put away under it.
     */
    const empty = JSON.parse(
      await browser.evaluate(`(() => {
        const section = document.getElementById('empty-state')
        const heading = section.querySelector('h3')
        return JSON.stringify({
          shown: !section.hidden && getComputedStyle(section).display !== 'none',
          heading: heading === null ? null : heading.textContent.trim(),
          hint: section.querySelector('p')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
          logHidden: document.getElementById('log').hidden,
          title: document.getElementById('session-title').textContent.trim()
        })
      })()`),
    )
    assert.equal(empty.shown, true, 'a panel with no conversation shows the invitation')
    assert.equal(empty.heading, 'Start a conversation', 'with a heading that says what to do')
    assert.match(empty.hint, /⌥⌘N/, 'and the chord that does it')
    assert.equal(empty.title, 'No session', 'the header still says there is no session')
    assert.equal(empty.logHidden, true, 'while the conversation\'s own column is put away')

    /** The seeded workspace has to be drawn before the action has a target; the tree is a fetch of its own. */
    assert.ok(
      await browser.waitFor('document.querySelector("#tree li[data-kind=\\"workspace\\"]") !== null', 20_000),
      'the seeded workspace is in the tree',
    )
    const primary = JSON.parse(
      await browser.evaluate(`(() => {
        const button = document.getElementById('new-session')
        const style = getComputedStyle(button)
        const box = button.getBoundingClientRect()
        return JSON.stringify({
          label: button.innerText.trim(),
          box: Math.round(box.width) + 'x' + Math.round(box.height),
          radius: style.borderRadius,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          borderWidth: style.borderWidth,
          padding: style.padding,
          widthOfPanel: Math.round(button.parentElement.getBoundingClientRect().width),
          borders: style.borderTopWidth !== '0px' && style.borderTopColor.includes('/ 0.16')
        })
      })()`),
    )
    assert.equal(primary.label, 'New session', 'the panel has DSH\'s primary action')
    assert.equal(primary.radius, '12px', 'rounded by the panel\'s own rule')
    assert.equal(primary.fontSize, '14px', 'at DSH\'s 14-pixel label')
    assert.equal(primary.fontWeight, '500', 'and its medium weight')
    assert.equal(primary.borders, true, 'with DSH\'s 16%-white border')
    assert.equal(primary.padding, '8px 12px', 'and its padding')

    /** The act: a conversation starts in the selected workspace and the tree shows its row. */
    await browser.evaluate(`document.getElementById('new-session').click()`)
    assert.ok(
      await browser.waitFor('document.querySelectorAll("#tree li[data-kind=\\"session\\"]").length > 0', 20_000),
      'clicking the primary action starts a session, visible in the tree',
    )
    assert.notEqual(
      await browser.evaluate(`document.getElementById('session-title').textContent`),
      'No session',
      'and the panel opens it',
    )
    /** And the invitation gives way: it is for the panel with nothing in it. */
    assert.equal(
      await browser.evaluate(`!document.getElementById('empty-state').hidden`),
      false,
      'the empty state is put away once there is a conversation',
    )
    assert.equal(
      await browser.evaluate(`document.getElementById('log').hidden`),
      false,
      'and the conversation\'s column is back',
    )

    /** DSH\'s chord, `Alt+Meta+N`, does the same thing from the keyboard. */
    const sessionsBefore = await browser.evaluate(`document.querySelectorAll('#tree li[data-kind="session"]').length`)
    await browser.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', altKey: true, metaKey: true, bubbles: true }))`)
    assert.ok(
      await browser.waitFor(`document.querySelectorAll('#tree li[data-kind="session"]').length > ${sessionsBefore}`, 20_000),
      'the chord starts another one',
    )

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
    /**
     * The state is **not** remembered, and that is copied from DSH rather than improved: its rail comes back wide on a
     * reload. The owner's report is why — the remembered version left a reader with a rail and no tree, unable to tell
     * that the tree had been put away rather than lost. The tree is the thing being protected here, so the assertion
     * is that a reload brings it back, not that a key was written.
     */
    assert.equal(await browser.evaluate('localStorage.getItem("heddle.layout.collapsed.v1")'), null, 'nothing is written about the collapse')

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

    /**
     * And the primary action becomes the rail's **second icon**: DSH's collapsed sidebar measures `Open sidebar` at
     * y=18 and `New session` at y=66 — a 48-pixel pitch — both 36x36 at x=10. The label is put away with the words.
     */
    const railAction = JSON.parse(
      await browser.evaluate(`(() => {
        const button = document.getElementById('new-session')
        const box = button.getBoundingClientRect()
        return JSON.stringify({
          box: Math.round(box.width) + 'x' + Math.round(box.height),
          x: Math.round(box.x),
          y: Math.round(box.y),
          labelShown: getComputedStyle(document.getElementById('new-session-label')).display !== 'none',
          background: getComputedStyle(button).backgroundColor
        })
      })()`),
    )
    assert.equal(railAction.box, '36x36', 'the action is a 36-pixel icon in the rail')
    assert.equal(railAction.x, 10, 'at the rail\'s own inset')
    assert.equal(railAction.y, 66, 'on DSH\'s 48-pixel pitch below the control that opens the panel')
    assert.equal(railAction.labelShown, false, 'with its label put away')
    assert.equal(railAction.background, 'rgba(0, 0, 0, 0)', 'and no fill, which would be the loudest thing left')

    /** A reload puts the panel back — DSH's behaviour, and the fix for the owner's report of a missing tree. */
    await browser.goto(server.url)
    assert.ok(await browser.waitFor('document.getElementById("sidebar-toggle") !== null', 20_000), 'the page came back')
    assert.ok(
      (await browser.evaluate(`Math.round(document.querySelector('aside').getBoundingClientRect().width)`)) > 100,
      'the panel is wide again after a reload',
    )
    assert.ok(
      await browser.evaluate(`getComputedStyle(document.getElementById('tree')).display !== 'none'`),
      'and the tree is on screen, which is what a remembered rail had taken away',
    )
    /**
     * The tree **arrives with a branch open** in a workspace, which is DSH's default and the other half of the owner's
     * report; the claim lives in `test/page-contract.test.ts`, which reads the wiring, because this check's isolated
     * HOME registers no workspace and a browser assertion here would only be able to pass vacuously. The live
     * measurement is in `SESSION_UI.md`: a fresh profile draws 8 rows with the first root `aria-expanded="true"`.
     */

    /**
     * The panel **does not scroll as a whole**; its workspaces region does. Measured from DSH on 2026-10-17: its
     * sidebar column is `overflow: hidden` (813/813) with exactly one inner scroller — the workspace list — and the
     * brand, the primary action and the search above it never move. The owner's report was the opposite here, and this
     * is the assertion that keeps the fix: the aside cannot scroll, the region can, and scrolling it leaves the chrome
     * exactly where it was.
     */
    /**
     * The panel is wide here: the reload above restored it, and the chord has not been pressed yet. The tree is a fetch
     * of its own, so the region has nothing to measure until it has drawn — and the branch has to be **open** for the
     * 40 seeded files to be rows, which the remembered expansion from the primary action guarantees.
     */
    assert.ok(
      await browser.waitFor('document.querySelectorAll("#tree .row").length > 40', 20_000),
      'the seeded workspace is drawn open, so the region has more rows than fit',
    )
    const panel = JSON.parse(
      await browser.evaluate(`(() => {
        const aside = document.querySelector('aside')
        const region = document.getElementById('workspace-scroll')
        const read = (el) => {
          const s = getComputedStyle(el)
          const r = el.getBoundingClientRect()
          return { y: Math.round(r.y), overflowY: s.overflowY, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
        }
        const scrollers = [...aside.querySelectorAll('*')].filter((el) => {
          const s = getComputedStyle(el)
          return /auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1
        })
        return JSON.stringify({
          aside: read(aside),
          asideScrolls: aside.scrollHeight > aside.clientHeight + 1,
          region: read(region),
          regionScrolls: region.scrollHeight > region.clientHeight + 1,
          scrollers: scrollers.map((el) => el.id || el.tagName.toLowerCase()),
          chrome: {
            brand: read(document.getElementById('brand')).y,
            newSession: read(document.getElementById('new-session')).y,
            search: read(document.getElementById('session-search')).y
          }
        })
      })()`),
    )
    assert.equal(panel.aside.overflowY, 'hidden', 'the panel is a fixed column')
    assert.equal(panel.asideScrolls, false, `and does not scroll as a whole (${panel.aside.scrollHeight}/${panel.aside.clientHeight})`)
    assert.deepEqual(panel.scrollers, ['workspace-scroll'], 'the workspaces region is the only thing that scrolls')
    assert.equal(panel.regionScrolls, true, `and it does scroll, because the fixture overflows (${panel.region.scrollHeight}/${panel.region.clientHeight})`)

    const scrolled = JSON.parse(
      await browser.evaluate(`(() => {
        const region = document.getElementById('workspace-scroll')
        region.scrollTop = region.scrollHeight
        region.dispatchEvent(new Event('scroll'))
        const read = (el) => Math.round(el.getBoundingClientRect().y)
        return JSON.stringify({
          scrollTop: Math.round(region.scrollTop),
          brand: read(document.getElementById('brand')),
          newSession: read(document.getElementById('new-session')),
          search: read(document.getElementById('session-search')),
          asideScrollTop: Math.round(document.querySelector('aside').scrollTop)
        })
      })()`),
    )
    assert.ok(scrolled.scrollTop > 0, 'the region scrolled to its end')
    assert.equal(scrolled.brand, panel.chrome.brand, 'and the brand row did not move')
    assert.equal(scrolled.newSession, panel.chrome.newSession, 'nor the primary action')
    assert.equal(scrolled.search, panel.chrome.search, 'nor the search field')
    assert.equal(scrolled.asideScrollTop, 0, 'while the panel itself stayed at zero')

    /**
     * The chord, which is DSH's own: `Alt+Meta+B`. It **toggles** — pressed while wide it collapses, pressed again it
     * opens — so both directions are read, because a chord bound to only one of them is a control that can put the
     * panel away and not bring it back.
     */
    const chordOnce = JSON.parse(
      await browser.evaluate(`(() => {
        document.getElementById('sidebar-toggle').focus()
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', altKey: true, metaKey: true, bubbles: true }))
        return JSON.stringify({ width: Math.round(document.querySelector('aside').getBoundingClientRect().width), label: document.getElementById('sidebar-toggle').getAttribute('aria-label') })
      })()`),
    )
    assert.equal(chordOnce.width, 56, 'the chord collapses the panel from the keyboard')
    assert.equal(chordOnce.label, 'Open sidebar', 'with the control naming the new action')
    const chordTwice = JSON.parse(
      await browser.evaluate(`(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', altKey: true, metaKey: true, bubbles: true }))
        return JSON.stringify({ width: Math.round(document.querySelector('aside').getBoundingClientRect().width), label: document.getElementById('sidebar-toggle').getAttribute('aria-label') })
      })()`),
    )
    assert.ok(chordTwice.width > 100, `and opens it again (${chordTwice.width})`)
    assert.equal(chordTwice.label, 'Collapse sidebar', 'naming the action back')
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
    removeDir(work)
  }
})
