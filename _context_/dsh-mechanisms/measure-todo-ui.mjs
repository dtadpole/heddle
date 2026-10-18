/**
 * The todo dock's measurement instrument — one committed probe, one fixed schema, both sides.
 *
 * DSH side: http://127.0.0.1:8080 with a session whose todo list is non-empty (the panel is mounted in
 * `conversation.input.dock` by `TodoPanel`). Heddle side: a fixture server whose session has a todo list.
 *
 * It fails loudly when the panel it looks for is absent: a probe that prints nulls and continues is how the
 * goal-dock rounds measured the wrong node. Provenance is part of the answer: the panel's own CSS-module prefix
 * is derived from its class name, and the rules carrying that prefix are returned with the numbers they produce.
 */
import { openBrowser } from '../../_tools_/verify-runner/browser.mjs'

export const PANEL_SELECTOR = '[data-testid="todo-panel"], #todo-panel'

export async function measureTodoUi({ url, sessionTitle, screenshot, expand = true }) {
  const browser = await openBrowser()
  try {
    await browser.goto(url)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    if (sessionTitle !== undefined) {
      const clicked = await browser.evaluate(
        "(() => { const all = Array.from(document.querySelectorAll('*')); const leaf = all.find((n) => n.children.length === 0 && n.textContent && n.textContent.includes(" +
          JSON.stringify(sessionTitle) +
          ")); const t = leaf ? (leaf.closest('button,[role=button],a') || leaf.parentElement) : null; if (!t) return false; t.click(); return true })()",
      )
      if (!clicked) throw new Error('session ' + JSON.stringify(sessionTitle) + ' not found at ' + url)
      await new Promise((resolve) => setTimeout(resolve, 4500))
    }
    const measure = `(() => {
      const pick = (el) => { if (el === null) return null; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bg: s.backgroundColor, radius: s.borderRadius, border: s.border, padding: s.padding, gap: s.gap, font: s.fontSize + '/' + s.lineHeight, weight: s.fontWeight, color: s.color, margin: s.margin } }
      const panel = document.querySelector(${JSON.stringify(PANEL_SELECTOR)})
      if (panel === null) return JSON.stringify({ present: false })
      const header = panel.querySelector('button, [data-todo-header]')
      const list = panel.querySelector('ul, [data-todo-list]')
      const items = list === null ? [] : Array.from(list.querySelectorAll('li')).map((li) => ({
        status: li.getAttribute('data-status'),
        text: (li.innerText || '').replace(/\\s+/g, ' ').trim(),
        glyphLabel: li.querySelector('[role=img], [aria-label]') ? li.querySelector('[role=img], [aria-label]').getAttribute('aria-label') : null,
      }))
      const spans = header === null ? [] : Array.from(header.querySelectorAll('span')).map((s) => ({ text: (s.innerText || '').trim(), ...pick(s) }))
      const prefix = (String(panel.className || '').split(' ')[0] || '').replace(/_(root|panel)$/, '')
      const rules = []
      if (prefix.length > 0) for (const sheet of Array.from(document.styleSheets)) for (const rule of Array.from(sheet.cssRules || [])) if ((rule.cssText || '').includes(prefix)) rules.push(rule.cssText)
      return JSON.stringify({ present: true, prefix, panel: pick(panel), ariaLabel: panel.getAttribute('aria-label'), header: header === null ? null : { ...pick(header), text: (header.innerText || '').replace(/\\s+/g, ' ').trim(), expanded: header.getAttribute('aria-expanded') }, headerSpans: spans, list: list === null ? null : pick(list), items, rules })
    })()`
    const { present, ...before } = JSON.parse(await browser.evaluate(measure))
    if (!present) throw new Error('todo panel not found at ' + url + ' (selector ' + PANEL_SELECTOR + ')')
    let expanded = null
    if (expand) {
      await browser.evaluate("(() => { const p = document.querySelector(" + JSON.stringify(PANEL_SELECTOR) + "); const h = p && p.querySelector('button, [data-todo-header]'); if (h) h.click() })()")
      await new Promise((resolve) => setTimeout(resolve, 350))
      const { present: stillPresent, ...after } = JSON.parse(await browser.evaluate(measure))
      if (!stillPresent) throw new Error('todo panel disappeared when expanded at ' + url)
      expanded = after
      if (screenshot !== undefined) await browser.screenshot(screenshot)
    } else if (screenshot !== undefined) {
      await browser.screenshot(screenshot)
    }
    return { collapsed: before, expanded }
  } finally {
    await browser.close()
  }
}
