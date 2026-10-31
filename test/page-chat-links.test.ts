import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * Unit tests for the page's chat-link resolution (C62 in the parity inventory): a file link in an answer opens the
 * file in the page's preview instead of navigating away. The function is read out of page.html between its markers,
 * so the page and this test judge one source.
 */
const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const begin = page.indexOf('/* chat-links:begin */')
const end = page.indexOf('/* chat-links:end */')
assert.ok(begin !== -1 && end > begin, 'page.html fences chatLinkPath with its markers')
const { chatLinkPath, fragmentLine } = new Function(`${page.slice(begin, end)}\nreturn { chatLinkPath, fragmentLine }`)() as {
  chatLinkPath: (href: string, folder: string | null) => string | null
  fragmentLine: (fragment: string) => number | null
}

const folder = '/work/project'

test('a relative link names a file in the session folder, with . and .. resolved', () => {
  assert.equal(chatLinkPath('README.md', folder), '/work/project/README.md')
  assert.equal(chatLinkPath('src/app.ts', folder), '/work/project/src/app.ts')
  assert.equal(chatLinkPath('./docs/../docs/guide.md', folder), '/work/project/docs/guide.md')
  assert.equal(chatLinkPath('../sibling/notes.md', `${folder}/`), '/work/sibling/notes.md', 'a trailing slash on the folder changes nothing')
})

test('the fragment and the query are not part of the path', () => {
  assert.equal(chatLinkPath('docs/guide.md#install', folder), '/work/project/docs/guide.md')
  assert.equal(chatLinkPath('notes.md?plain=1', folder), '/work/project/notes.md')
  assert.equal(chatLinkPath('my%20file.md', folder), '/work/project/my file.md', 'an encoded name is decoded')
})

test('an absolute path is taken as written, and a raw-route link names the file in its query', () => {
  assert.equal(chatLinkPath('/etc/hosts', folder), '/etc/hosts')
  assert.equal(chatLinkPath('/api/raw?path=%2Fwork%2Fproject%2Fimg.png', folder), '/work/project/img.png')
})

test('a link that is not a file is left to the browser', () => {
  for (const href of ['https://example.com/', 'http://example.com/a.md', 'mailto:someone@example.com', '#section', '//cdn.example.com/x.js', '', 'javascript:void(0)']) {
    assert.equal(chatLinkPath(href, folder), null, href)
  }
})

test('a relative link without a session folder resolves to nothing, and a broken escape is not a path', () => {
  assert.equal(chatLinkPath('README.md', null), null)
  assert.equal(chatLinkPath('README.md', ''), null)
  assert.equal(chatLinkPath('bad%E0%A4%A.md', folder), null)
})

test('#L24 and #L24-L30 name the first line; any other fragment names no line', () => {
  assert.equal(fragmentLine('L24'), 24)
  assert.equal(fragmentLine('L24-L30'), 24, 'a range goes to its first line, as in DSH')
  assert.equal(fragmentLine('L24-30'), 24, 'the second L is optional')
  assert.equal(fragmentLine('L30-L24'), 30, 'the first line named, even when the range runs backwards')
  for (const fragment of ['', 'install', 'L0', 'L', 'Lx', 'l24', 'L24x', 'section-L24']) {
    assert.equal(fragmentLine(fragment), null, fragment)
  }
})
