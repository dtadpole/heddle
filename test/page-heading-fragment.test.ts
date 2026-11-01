import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src/server/page.html'), 'utf8')
function fn(name: string) {
  const start = page.search(new RegExp(`function ${name}\\(`))
  return page.slice(start, page.indexOf('\n}', start) + 2)
}
function resolve(fragment: string, labels: string[]) {
  let selected: string | null = null
  const headings = labels.map((textContent) => ({ textContent, scrollIntoView: () => { selected = textContent } }))
  runInNewContext(`${fn('slug')} ${fn('scrollToHeading')} scrollToHeading(fragment)`, { fragment, fileBody: { querySelectorAll: () => headings } })
  return selected
}
test('literal and once-encoded Chinese fragments select the requested heading, not the first', () => {
  for (const fragment of ['第二节', encodeURIComponent('第二节')]) {
    assert.equal(resolve(fragment, ['第一节', '第二节']), '第二节')
  }
})
test('ASCII, accented and canonically equivalent heading text remain navigable', () => {
  assert.equal(resolve('second-section', ['First Section', 'Second Section']), 'Second Section')
  assert.equal(resolve('caf%C3%A9', ['Intro', 'Cafe\u0301']), 'Cafe\u0301')
})
test('unmatched, malformed escapes and empty punctuation do not jump to another heading', () => {
  assert.equal(resolve('absent', ['First', 'Second']), null)
  assert.equal(resolve('%E0%A4', ['First', 'Second']), null)
  assert.equal(resolve('!!!', ['第一节', '第二节']), null)
})
