import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/** #84: execute the delivered shared page scanner, DOM renderer and add(), not a second implementation.
 * All credentials below are synthetic shapes, not provider-issued values. No server, browser or private files.
 */
const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src/server/page.html'), 'utf8')
const fakeKey = 'sk-' + 'FakeFixture'.repeat(3) + '1'
const mask = (value: string) => value.slice(0, 8) + '*'.repeat(value.length - 8)

class Element {
  tagName: string
  className = ''
  dataset: Record<string, string> = {}
  attributes: Record<string, string> = {}
  children: Element[] = []
  parentElement: Element | null = null
  ownText = ''
  onclick?: () => void | Promise<void>
  type = ''
  classList = { add: (...names: string[]) => { this.className += ' ' + names.join(' ') } }
  constructor(tagName: string) { this.tagName = tagName.toUpperCase() }
  get textContent(): string { return this.ownText + this.children.map((child) => child.textContent).join('') }
  set textContent(text: string) { this.ownText = String(text); this.children = [] }
  get innerText(): string { return this.textContent }
  set innerHTML(_text: string) { throw new Error('raw user text must not enter innerHTML') }
  append(...children: Element[]) { for (const child of children) { child.parentElement = this; this.children.push(child) } }
  replaceChildren(...children: Element[]) { this.ownText = ''; this.children = []; this.append(...children) }
  setAttribute(name: string, value: string) { this.attributes[name] = String(value) }
  all(predicate: (element: Element) => boolean): Element[] {
    return this.children.flatMap((child) => [...(predicate(child) ? [child] : []), ...child.all(predicate)])
  }
}

function functionSource(name: string): string {
  const start = page.indexOf('function ' + name + '(')
  assert.ok(start >= 0, 'the page defines ' + name)
  const end = page.indexOf('\n}\n', start)
  assert.ok(end > start)
  return page.slice(start, end + 2)
}
interface Span { start: number; end: number; data: { masked: string } }
interface Harness {
  log: Element
  scan(text: string): Span[]
  render(text: string, interactive?: boolean): Element
  add(text: string, tool?: object): Element
  addOther(kind: string, text: string): Element
  rerender(node: Element, text: string): void
  copied: string[]
}
function harness(language = 'en'): Harness {
  const begin = page.indexOf('/* user-secrets:begin */')
  const end = page.indexOf('/* user-secrets:end */')
  const secretSource = begin >= 0 && end > begin ? page.slice(begin, end) : ''
  const log = new Element('div')
  const copied: string[] = []
  return runInNewContext(`
    ${secretSource}
    function lastTurnRow() { return null }
    function keepRunningLast() {}
    function followChatTail() {}
    function paintEmptyState() {}
    ${functionSource('questionAnswerText')}
    function copyIcon() { return document.createElement('svg') }
    function copiedIcon() { return document.createElement('svg') }
    ${functionSource('copyAction')}
    function userActions(row) { return copyAction(row, 'Copy') }
    function messageAttachments() { return document.createElement('aside') }
    function triggerNotice(_trigger, text) { const node = document.createElement('aside'); node.textContent = text; return node }
    ${functionSource('add')}
    ({ log, copied,
      scan: (text) => scanUserCredentials(text),
      rerender: (node, text) => renderSentUserText(node, text),
      render: (text, interactive = true) => { const node = document.createElement('div'); renderSentUserText(node, text, interactive); return node },
      add: (text, tool) => { add('user', text, false, undefined, tool); return log.children[log.children.length - 1] },
      addOther: (kind, text) => { add(kind, text, false); return log.children[log.children.length - 1] },
    })
  `, {
    log, copied, setTimeout: () => 0,
    navigator: { clipboard: { writeText: async (text: string) => { copied.push(text) } } },
    document: { documentElement: { lang: language }, createElement: (tag: string) => new Element(tag), createElementNS: (_namespace: string, tag: string) => new Element(tag), createTextNode: (text: string) => { const node = new Element('#text'); node.textContent = text; return node } },
  }) as Harness
}
const secrets = (node: Element) => node.all((child) => 'secret' in child.dataset)
const buttons = (node: Element) => node.all((child) => child.tagName === 'BUTTON')

test('the actual admitted-human add path masks a recognized fake key but keeps exact raw Copy', async () => {
  const h = harness()
  const row = h.add('please use ' + fakeKey)
  const bubble = row.children.find((child) => child.className.includes('bubble'))!
  assert.equal(bubble.textContent, 'please use ' + mask(fakeKey))
  assert.equal(row.dataset.copyText, 'please use ' + fakeKey)
  await row.children[row.children.length - 1]!.onclick!()
  assert.deepEqual(h.copied, ['please use ' + fakeKey])
})

test('all installed provider literals match exact synthetic suffix shapes', () => {
  const h = harness()
  const cases: [string, string, number][] = [
    ['sk-', 'a1'.repeat(10), 20], ['AIza', 'a'.repeat(35), 35],
    ...['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'npm_'].map((prefix): [string, string, number] => [prefix, 'a'.repeat(36), 36]),
    ['github_pat_', 'a_'.repeat(11), 22], ['glpat-', 'a-'.repeat(10), 20], ['hf_', 'a'.repeat(30), 30],
    ['AKIA', 'A1'.repeat(8), 16], ['ASIA', 'A1'.repeat(8), 16], ['LTAI', 'a'.repeat(12), 12], ['AKID', 'a'.repeat(28), 28],
    ...['xoxa-', 'xoxb-', 'xoxp-', 'xoxr-', 'xoxs-'].map((prefix): [string, string, number] => [prefix, 'a-'.repeat(5), 10]),
    ...['sk_live_', 'sk_test_', 'rk_live_', 'rk_test_'].map((prefix): [string, string, number] => [prefix, 'a'.repeat(16), 16]),
    ['whsec_', 'a'.repeat(24), 24],
  ]
  for (const [prefix, suffix, min] of cases) {
    const token = prefix + suffix
    const spans = h.scan(token)
    assert.equal(spans.length, 1, prefix)
    assert.equal(spans[0]!.data.masked, mask(token), prefix)
    assert.equal(spans[0]!.end, token.length, prefix)
    assert.equal(h.scan(prefix + suffix.slice(0, min - 1)).length, 0, prefix + ' below min')
    assert.equal(h.scan('word_' + token).length, 0, prefix + ' left word boundary')
  }
  for (const [prefix, max] of [['AKIA', 16], ['ASIA', 16], ['LTAI', 20], ['AKID', 36]] as const) {
    assert.equal(h.scan(prefix + 'A'.repeat(max)).length, 1)
    assert.equal(h.scan(prefix + 'A'.repeat(max + 1)).length, 0)
    assert.equal(h.scan(prefix + 'A'.repeat(max) + '_').length, 0)
  }
  const google = 'AIza' + 'a'.repeat(40)
  assert.equal(h.scan(google)[0]!.end, 39, 'Google takes only the installed fixed 35-character suffix')
})

test('ordinary assignments/prose and malformed formats are not guessed as passwords', () => {
  const h = harness()
  for (const plain of [
    'password=ordinary API_KEY=ordinary token=2048 123456', 'my password is ordinary',
    'sk-' + 'letters'.repeat(20), 'sk-' + 'a'.repeat(256) + '1',
    'eyJ' + 'a'.repeat(8) + '.notPayload.' + 'a'.repeat(8),
    'eyJ' + 'a'.repeat(2049) + '.eyJ' + 'a'.repeat(8) + '.' + 'a'.repeat(8),
    'HTTP://user:password@host', 'x://user:password@host', 'postgres://user:@host',
    'postgres://user:pass/word@host', 'postgres://user:pass?word@host', 'postgres://user:pass#word@host',
    'postgres://' + 'u'.repeat(257) + ':password@host',
    '-----BEGIN CERTIFICATE-----\nnot a private key\n-----END CERTIFICATE-----',
  ]) assert.equal(h.scan(plain).length, 0, plain.slice(0, 80))
  assert.equal(h.scan('API_KEY=' + fakeKey).length, 1, 'recognized value still matches after an assignment')
  assert.equal(h.scan('sk-' + 'a'.repeat(255) + '1').length, 1)
})

test('JWT and address passwords use exact spans and completely mask token-shaped passwords', () => {
  const h = harness()
  const jwt = 'eyJ' + 'a'.repeat(8) + '.eyJ' + 'b'.repeat(8) + '.' + 'c'.repeat(8)
  assert.equal(h.scan(jwt)[0]!.data.masked, mask(jwt))
  const url = 'postgres://user:' + fakeKey + '@host/db'
  const span = h.scan(url)[0]!
  assert.equal(span.start, 'postgres://user:'.length)
  assert.equal(span.end, url.indexOf('@'))
  assert.equal(span.data.masked, '*'.repeat(fakeKey.length), 'password does not keep eight token characters')
  assert.equal(h.render(url).textContent, 'postgres://user:' + '*'.repeat(fakeKey.length) + '@host/db')
  assert.equal(h.scan('postgres://:p:a@host')[0]!.data.masked, '***', 'empty user and password colon allowed')
  const unicode = 'postgres://user:🔒a\u0301@host'
  assert.equal(h.scan(unicode)[0]!.data.masked, '***', 'one star per code point, not UTF16 unit')
})

test('private-key blocks preserve CRLF/header/footer, mask unfinished and single-line bodies and join overlaps', () => {
  const h = harness()
  const header = '-----BEGIN RSA PRIVATE KEY-----'
  const footer = '-----END RSA PRIVATE KEY-----'
  const pem = header + '\r\n🔒body' + fakeKey + '\r\n' + footer
  const span = h.scan(pem)[0]!
  assert.equal(span.end, pem.length)
  assert.equal(span.data.masked, header + '\r\n' + '*'.repeat(5 + fakeKey.length) + '\r\n' + footer)
  assert.equal(h.scan(header + '\nsecret\n')[0]!.data.masked, header + '\n******\n')
  assert.equal(h.scan(header + 'secret' + footer)[0]!.data.masked, '*'.repeat((header + 'secret' + footer).length))
  const mismatched = '-----BEGIN PRIVATE KEY-----\nx\n-----END EC PRIVATE KEY-----'
  assert.equal(h.scan(mismatched)[0]!.end, mismatched.length, 'installed END labels need not equal BEGIN labels')
  const overlap = 'sk-' + 'a1'.repeat(10) + '-ghp_' + 'b'.repeat(36)
  assert.equal(h.scan(overlap).length, 1)
  assert.equal(h.scan(overlap)[0]!.data.masked, mask(overlap))
})

test('per-occurrence controls reveal only one value; hide, remount and different original all start masked', () => {
  const h = harness()
  const node = h.render(fakeKey + ' / ' + fakeKey)
  const values = secrets(node)
  const toggles = buttons(node)
  assert.equal(toggles.length, 2)
  assert.equal(values[0]!.textContent, mask(fakeKey))
  assert.equal(toggles[0]!.type, 'button')
  assert.equal(toggles[0]!.attributes['aria-label'], 'Show secret')
  assert.equal(toggles[0]!.attributes['aria-pressed'], 'false')
  toggles[0]!.onclick!()
  assert.equal(values[0]!.textContent, fakeKey)
  assert.equal(values[1]!.textContent, mask(fakeKey), 'duplicate raw spellings do not share reveal state')
  assert.equal(toggles[0]!.attributes['aria-label'], 'Hide secret')
  assert.equal(toggles[0]!.attributes['aria-pressed'], 'true')
  toggles[0]!.onclick!()
  assert.equal(values[0]!.textContent, mask(fakeKey))
  toggles[0]!.onclick!()
  assert.equal(h.render(fakeKey).textContent, mask(fakeKey), 'remount starts hidden')
  h.rerender(node, fakeKey + '2')
  assert.equal(node.textContent, mask(fakeKey + '2'), 'different original at the same DOM position starts hidden')
  assert.equal(h.render(fakeKey + '2').textContent, mask(fakeKey + '2'), 'changed raw starts hidden')
  const zh = harness('zh-CN').render(fakeKey)
  assert.equal(buttons(zh)[0]!.attributes['aria-label'], '显示密钥')
  buttons(zh)[0]!.onclick!()
  assert.equal(buttons(zh)[0]!.attributes['aria-label'], '隐藏密钥')
  assert.equal(buttons(h.render(fakeKey, false)).length, 0)
  for (const element of [node, ...node.all(() => true)]) {
    assert.ok(!JSON.stringify(element.dataset).includes(fakeKey))
    assert.ok(!JSON.stringify(element.attributes).includes(fakeKey))
  }
})

test('question-answer shaping masks displayed words while original copy stays exact; nonhuman/assistant remain plain', () => {
  const h = harness()
  const raw = JSON.stringify({ kind: 'answer_to_pending_question', questions: [{ id: 'q', question: 'Answer' }], answers: [{ id: 'q', selected: [], custom: fakeKey }] })
  const row = h.add(raw, { attachments: [{}] })
  const bubble = row.children.find((child) => child.className.includes('bubble'))!
  assert.equal(bubble.textContent, 'Answer\n→ ' + mask(fakeKey))
  assert.ok(bubble.className.includes('question-answer'))
  assert.equal(row.dataset.copyText, raw)
  assert.equal(secrets(h.add(fakeKey, { trigger: { kind: 'goal' } })).length, 0)
  assert.equal(h.addOther('assistant', fakeKey).textContent, fakeKey)
  assert.equal(h.add('', { attachments: [{}] }).children.length, 2, 'attachment-only user row remains intact')
  const injection = '<img src=x onerror=alert(1)> ' + fakeKey
  assert.equal(h.render(injection).textContent, '<img src=x onerror=alert(1)> ' + mask(fakeKey))
})

test('the complete shared module parses without global declaration collisions', () => {
  const start = page.indexOf('<script type="module">') + '<script type="module">'.length
  const end = page.indexOf('</script>', start)
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (body: string) => unknown
  assert.doesNotThrow(() => new AsyncFunction(page.slice(start, end)))
})

test('prefix-heavy and long ordinary text progress without broad regex backtracking', () => {
  const h = harness()
  const plain = ('word_sk-' + 'a'.repeat(30) + ' ').repeat(2000)
  assert.equal(h.scan(plain).length, 0)
  const tokens = Array.from({ length: 1000 }, () => fakeKey).join(' ')
  const spans = h.scan(tokens)
  assert.equal(spans.length, 1000)
  assert.ok(spans.every((span, index) => index === 0 || span.start >= spans[index - 1]!.end))
})
