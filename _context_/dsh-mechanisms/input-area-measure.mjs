import { openPage } from '../_tools_/browser-use/lib.mjs'

const measure = `() => {
  const cs = (n) => (n === null ? null : getComputedStyle(n))
  const box = (n) => {
    if (n === null) return null
    const r = n.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) }
  }
  const card = document.getElementById('composer-card') ?? document.querySelector('[class*="card"]')
  const editor = document.querySelector('#prompt textarea') ?? document.querySelector('[role="textbox"][contenteditable="true"], textarea, [contenteditable="true"]')
  const tools = document.getElementById('prompt-tools') ?? (card === null ? null : card.querySelector('[class*="bar"], [class*="Bar"]'))
  const access = document.getElementById('access') ?? (card === null ? null : [...card.querySelectorAll('button')].find((b) => /access/i.test((b.getAttribute('aria-label') || '') + ' ' + b.innerText)))
  const status = document.getElementById('composer-status') ?? null
  const send = document.getElementById('send') ?? (card === null ? null : [...card.querySelectorAll('button')].find((b) => /send/i.test(b.getAttribute('aria-label') || '')))
  return JSON.stringify({
    viewport: innerHeight,
    card: { box: box(card), padding: cs(card)?.padding, radius: cs(card)?.borderRadius },
    editor: { box: box(editor), padding: cs(editor)?.padding, font: cs(editor)?.fontSize + '/' + cs(editor)?.lineHeight },
    toolRow: { box: box(tools), padding: cs(tools)?.padding },
    access: box(access),
    send: box(send),
    status: status === null ? null : { box: box(status), text: status.innerText },
    gaps: {
      cardTopToEditor: card && editor ? Math.round(editor.getBoundingClientRect().top - card.getBoundingClientRect().top) : null,
      editorToControls: editor && tools ? Math.round(tools.getBoundingClientRect().top - editor.getBoundingClientRect().bottom) : null,
      controlsToCardBottom: tools && card ? Math.round(card.getBoundingClientRect().bottom - tools.getBoundingClientRect().bottom) : null,
      cardToStatus: status && card ? Math.round(status.getBoundingClientRect().top - card.getBoundingClientRect().bottom) : null,
      statusToViewport: status ? Math.round(innerHeight - status.getBoundingClientRect().bottom) : null,
    },
  })
}`

const browser = await openPage({ width: 1400, height: 900 })
try {
  for (const [label, url] of [
    ['dsh', 'http://127.0.0.1:8080/'],
    ['heddle', 'http://127.0.0.1:3082/?token=Upm_-OZVXts0bBYaJC51pap391_fy1vMupEmA9Y_HYo'],
  ]) {
    await browser.goto(url)
    await browser.waitFor('document.querySelector("textarea, [contenteditable=true], [role=textbox]") !== null', 20_000)
    await new Promise((resolve) => setTimeout(resolve, 600))
    console.log(label, await browser.evaluate(`(${measure})()`))
  }
} finally {
  browser.close()
}
