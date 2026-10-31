import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { renderMarkdown } from '../src/server/markdown.ts'
import { decodeCharacterReferences } from '../src/server/sanitize.ts'
import { pageAccess } from '../src/server/web.ts'
import { WorkspaceService } from '../src/workspace/service.ts'

function imageUrl(destination: string, base?: string, raw = false): URL {
  const source = raw ? `<img src="${destination.replaceAll('&', '&amp;')}">` : `![image](<${destination}>)`
  const html = renderMarkdown(source, { ...(base === undefined ? {} : { base, remoteImages: true }) })
  const src = /<img[^>]* src="([^"]+)"/.exec(html)?.[1]
  assert.ok(src, html)
  return new URL(decodeCharacterReferences(src), 'http://fixture.invalid')
}

test('local Markdown image paths decode exactly once before joining and preserve fragments', () => {
  for (const raw of [false, true]) {
    for (const [authored, expected] of [
      ['shot%20one.png#part%20one', '/work/docs/shot one.png'],
      ['shot%2520one.png', '/work/docs/shot%20one.png'],
      ['%E6%96%87%E5%AD%97%26image.png', '/work/docs/文字&image.png'],
      ['hash%23name.png#view', '/work/docs/hash#name.png'],
      ['..%2Fimages%2Fshot%20one.png', '/work/images/shot one.png'],
      ['/work/shot%20one.png', '/work/shot one.png'],
      ['%2Fwork%2Fshot%20one.png', '/work/shot one.png'],
    ]) {
      const url = imageUrl(authored!, '/work/docs', raw)
      assert.equal(url.pathname, '/api/raw')
      assert.equal(url.searchParams.get('path'), expected, `${authored}, raw HTML ${raw}`)
      assert.equal(url.hash, authored!.includes('#') ? `#${authored!.split('#')[1]}` : '')
    }
  }
})

test('absolute answer images without a base use the same once-only path decoding', () => {
  for (const raw of [false, true]) {
    assert.equal(imageUrl('/work/shot%20one.png#view', undefined, raw).searchParams.get('path'), '/work/shot one.png')
    assert.equal(imageUrl('/work/shot%2520one.png', undefined, raw).searchParams.get('path'), '/work/shot%20one.png')
  }
})

test('malformed local path escapes are refused, never partially or recursively decoded', () => {
  for (const name of ['100%.png', 'bad%2.png', 'bad%GG.png', 'bad%20%GG.png', 'bad%FF.png', 'bad%ED%A0%80.png']) {
    for (const base of [undefined, '/work']) {
      for (const destination of [name, `/work/${name}`]) {
        for (const source of [`![image](${destination})`, `<img src="${destination}">`]) {
          const html = renderMarkdown(source, { ...(base === undefined ? {} : { base }), remoteImages: true })
          assert.ok(!/<img[^>]*\bsrc=/.test(html), html)
        }
      }
    }
  }
  assert.equal(imageUrl('literal%252520.png', '/work').searchParams.get('path'), '/work/literal%2520.png')
})

test('authored decoding leaves filesystem bases and already emitted raw-route transport paths alone', () => {
  assert.equal(imageUrl('shot%20one.png', '/work/literal%20folder').searchParams.get('path'), '/work/literal%20folder/shot one.png')
  for (const raw of [false, true]) {
    const url = imageUrl('/api/raw?path=%2Fwork%2Fshot%2520one.png#part%20one', '/work', raw)
    assert.equal(url.pathname, '/api/raw')
    assert.equal(url.searchParams.get('path'), '/work/shot%20one.png')
    assert.equal(url.hash, '#part%20one')
  }
})

test('shared local link resolution decodes paths once while retaining encoded anchors', () => {
  for (const source of ['[note](note%20one.md#part%20one)', '<a href="note%20one.md#part%20one">note</a>']) {
    const html = renderMarkdown(source, { base: '/work' })
    assert.ok(html.includes('href="/api/raw?path=%2Fwork%2Fnote%20one.md#part%20one"'), html)
  }
  assert.ok(renderMarkdown('[note](note%2520one.md)', { base: '/work' }).includes('data-heddle-path="/work/note%20one.md"'))
})

test('remote image URL identity and refused schemes remain unchanged', () => {
  for (const source of ['https://example.invalid/shot%20one.png#part', '//example.invalid/shot%2520one.png']) {
    const html = renderMarkdown(`![image](${source})`, { base: '/work', remoteImages: true })
    assert.ok(html.includes(`src="${source}"`), html)
    assert.ok(!renderMarkdown(`![image](${source})`, { base: '/work' }).includes('<img'))
  }
  for (const source of ['javascript:alert(1)', 'data:image/png;base64,AA', 'file:///work/x.png', 'http%3A%2F%2Fexample.png', 'javascript%3Aalert(1)', 'file%3A%2F%2F%2Fwork%2Fx.png']) {
    assert.ok(!renderMarkdown(`![image](${source})`, { base: '/work', remoteImages: true }).includes('<img'))
  }
})

test('resolved destinations select distinct filename bytes under existing workspace policy (not HTTP proof)', () => {
  mkdirSync(resolve('.heddle-tmp'), { recursive: true })
  const scratch = realpathSync(mkdtempSync(join(resolve('.heddle-tmp'), 'markdown-paths-')))
  const workspace = join(scratch, 'workspace')
  mkdirSync(workspace)
  const workspaces = new WorkspaceService(new Context(), { file: join(scratch, 'workspaces.json') })
  const record = workspaces.ensure(workspace)
  try {
    const urls: string[] = []
    for (const [authored, filename, bytes] of [
      ['shot%20one.png', 'shot one.png', Buffer.from([0, 1, 255])],
      ['shot%2520one.png', 'shot%20one.png', Buffer.from([0, 2, 254])],
      ['%E6%96%87%E5%AD%97%26image.png', '文字&image.png', Buffer.from([0, 3, 253])],
    ] as const) {
      writeFileSync(join(workspace, filename), bytes)
      const url = imageUrl(authored, workspace)
      const wanted = url.searchParams.get('path')!
      urls.push(url.href)
      assert.equal(wanted, join(workspace, filename))
      assert.equal(workspaces.owner(wanted)?.id, record.id)
      assert.deepEqual(readFileSync(wanted), bytes, 'resolved destination names these exact bytes; no HTTP endpoint is exercised')
    }
    assert.equal(new Set(urls).size, 3)
    const outside = imageUrl('..%2Foutside.png', workspace).searchParams.get('path')!
    assert.equal(workspaces.owner(outside), undefined, 'decoding does not bypass the raw route workspace gate')
    assert.equal(pageAccess({ ok: false }, { cookie: false }).status, 401)
    assert.equal(pageAccess({ ok: true }, { cookie: true }).status, 200)
  } finally {
    assert.ok(scratch.startsWith(`${realpathSync(resolve('.heddle-tmp'))}/markdown-paths-`))
    rmSync(scratch, { recursive: true, force: true })
  }
})
