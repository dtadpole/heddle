/**
 * The deployed address, measured as a person uses it.
 *
 * Attaches a PNG through (+) File at http://127.0.0.1:8082/, sends a short turn, and reads the session the
 * deployment recorded: the card, the clean draft, the typed image block with its stored reference and digest,
 * and the session's own account of the completed turn.
 */
import { readFileSync, statSync } from 'node:fs'
import { openPage } from '/Users/zhenc/heddle/_tools_/browser-use/lib.mjs'

const page = await openPage({ width: 1400, height: 900 })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fixture = '/Users/zhenc/heddle/.heddle-tmp/attachments/landed-image.png'
const shot = '/Users/zhenc/heddle-deploy/_context_/add-file/cycle-1-landed-8082.png'
try {
  await page.goto('http://127.0.0.1:8082/', 30_000)
  await page.waitFor('document.getElementById("attach") !== null', 25_000)
  const endpoints = JSON.parse(await page.evaluate(`(async () => (await (await fetch('/api/endpoints')).json()) && JSON.stringify(await (await fetch('/api/endpoints')).json()))()`))
  await page.evaluate('document.getElementById("attach").click()')
  await page.waitFor('document.getElementById("attach-menu").hidden === false', 10_000)
  const findFile = `Array.from(document.querySelectorAll('#attach-menu button')).find((item) => item.textContent === 'File')`
  await page.waitFor(`${findFile} !== undefined`, 10_000)
  await page.evaluate(`${findFile}.click()`)
  const doc = await page.send('DOM.getDocument', { depth: 2, pierce: true })
  const found = await page.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#attach-file' })
  await page.send('DOM.setFileInputFiles', { files: [fixture], nodeId: found.result.nodeId })
  await page.waitFor('document.querySelector("#attach-cards .attach-card") !== null', 20_000)
  const card = JSON.parse(await page.evaluate(`JSON.stringify({
    name: document.querySelector('#attach-cards .attach-name')?.textContent,
    meta: document.querySelector('#attach-cards .attach-meta')?.textContent,
    remove: document.querySelector('#attach-cards .attach-remove')?.getAttribute('aria-label'),
    path: document.querySelector('#attach-cards .attach-card')?.dataset.path,
    draft: document.querySelector('#prompt textarea').value,
  })`))
  await page.screenshot(shot)
  await page.evaluate(`(() => {
    const field = document.querySelector('textarea')
    field.value = 'Reply with the single word ok.'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  /**
   * The session this turn wrote, found by **its own evidence**: the image block naming the exact file the card
   * carried. A previous attempt can leave an older session behind, so the newest row is not proof this run
   * delivered anything.
   */
  let session = null
  let log = null
  for (let attempt = 0; attempt < 90 && log === null; attempt += 1) {
    await sleep(1000)
    const rows = await page.evaluate(`(async () => (await (await fetch('/api/sessions')).json()).map((row) => row.id))()`)
    for (const id of rows) {
      const text = await page.evaluate(`(async () => (await fetch('/api/sessions/${id}/log')).text())()`)
      if (text.includes(card.path) && text.includes('turn/completed')) {
        session = id
        log = text
        break
      }
    }
  }
  if (log === null) throw new Error('the turn recording the card did not complete within a minute and a half')
  const events = log.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
  /**
   * The newest user message is this run's: the folder keeps one session, so its log can already hold earlier
   * attachments, and the evidence must be the message whose image names the card this run carried.
   */
  const user = events.filter((event) => event.type === 'message' && event.message?.role === 'user').at(-1)?.message
  const image = (user?.content ?? []).find((part) => part.type === 'image')
  if (image !== undefined && image.path !== card.path) {
    throw new Error(`the newest message names ${image.path}, not the card's ${card.path}`)
  }
  const completed = events.find((event) => event.type === 'assistant/completed')
  const answer = (completed?.text ?? '').trim()
  console.log(JSON.stringify({
    endpoints,
    card,
    draft: card.draft,
    image,
    storedBytes: image ? statSync(image.path).size : null,
    storedMatchesFixture: image ? readFileSync(image.path).equals(readFileSync(fixture)) : false,
    answer,
    turnCompleted: completed !== undefined,
  }, null, 2))
} finally {
  await page.close()
}
