/**
 * The todo dock's measurement instrument, one fixed schema for both sides.
 *
 * DSH side: http://127.0.0.1:8080 with a session whose todo list is non-empty (the panel is mounted in
 * `conversation.input.dock`). Heddle side: a fixture server whose session has a todo list.
 *
 * It fails loudly when the panel it looks for is absent: a probe that prints nulls and continues is how the
 * goal-dock rounds measured the wrong node.
 */
import { openBrowser } from '../../_tools_/verify-runner/browser.mjs'

export const SELECTOR = '[data-testid="todo-panel"], #todo-panel'

export async function measureTodoUi({ url, sessionTitle, screenshots }) {
  const browser = await openBrowser()
  try {
    await browser.goto(url)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    if (sessionTitle !== undefined) {
      await browser.evaluate(
        "(() => { const all = Array.from(document.querySelectorAll('*')); const leaf = all.find((n) => n.children.length === 0 && n.textContent && n.textContent.includes(" +
          JSON.stringify(sessionTitle) +
          ')); const t = leaf ? (leaf.closest(\'button,[role=button],a\') || leaf.parentElement) : null; if (!t) return false; t.click(); return true })()',
      )
      await new Promise((resolve) => setTimeout(resolve, 4500))
    }
    const result = await browser.evaluate(`(() => {
      const pick = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bg: s.backgroundColor, radius: s.borderRadius, border: s.border, padding: s.padding, gap: s.gap, font: s.fontSize + '/' + s.lineHeight, weight: s.fontWeight, color: s.color } }
      const panel = document.querySelector('[data-testid="todo-panel"], #todo-panel')
      if (panel === null) return JSON.stringify({ present: false })
      const header = panel.querySelector('button, [data-todo-header]')
      const list = panel.querySelector('ul, [data-todo-list]')
      const items = list ? Array.from(list.querySelectorAll('li')).map((li) => ({ status: li.getAttribute('data-status'), text: (li.innerText || '').replace(/\\s+/g, ' ').trim(), glyphLabel: (li.querySelector('[role=img],[aria-label]') || {}).getAttribute ? (li.querySelector('[role=img],[aria-label]').getAttribute('aria-label')) : null })) : []
      return JSON.stringify({
        present: true,
        panel: pick(panel),
        ariaLabel: panel.getAttribute('aria-label'),
        header: header ? { ...pick(header), text: (header.innerText || '').replace(/\\s+/g, ' ').trim(), expanded: header.getAttribute('aria-expanded') } : null,
        list: list ? pick(list) : null,
        items,
        styles: ['.root', '.body', '.header', '.title', '.progress', '.lead', '.chevron', '.list', '.item', '.glyph', '.content'].reduce((acc, part) => { const rules = []; for (const sheet of Array.from(document.styleSheets)) { for (const rule of Array.from(sheet.cssRules || [])) { const t = rule.cssText || ''; if (t.includes('TodoPanel') && t.includes(part.replace('.', ''))) rules.push(t) } } return acc }, {}),
      })
    })()`)
    const parsed = JSON.parse(result)
    if (parsed.present === false) throw new Error('todo panel not found at ' + url + ' (selector ' + SELECTOR + ')')
    if (screenshots !== undefined) await browser.screenshot(screenshots)
    return parsed
  } finally {
    await browser.close()
  }
}
