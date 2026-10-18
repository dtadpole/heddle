import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { describeEndpoint } from '../src/endpoints.ts'
import { toAnthropicContent, toChatMessage, toResponsesContent } from '../src/llm/adapters.ts'
import { acceptsImages, fileHandleText, projectAttachments, textOnlyImageText } from '../src/llm/attachments.ts'
import type { ContentPart, EndpointConfig, FilePart, ImagePart, Message } from '../src/llm/types.ts'

/**
 * Unit tests for the attachment projection: what the model is sent for an attached file.
 *
 * DSH never sends a non-image file to a provider and never sends image bytes to a route that accepts text
 * only: request assembly replaces the one with a deterministic handle naming the saved path, and the other
 * with a deterministic placeholder. The rules are asserted here because they are pure and exact, and the
 * browser contract (a recording chat double) judges the same facts end to end.
 */

const sha256 = 'ab'.repeat(32)

const imagePart = (path: string): ImagePart => ({
  type: 'image',
  name: 'shot.png',
  mimeType: 'image/png',
  path,
  bytes: 4,
  sha256,
})

const filePart = (path = '/tmp/notes.md'): FilePart => ({
  type: 'file',
  name: 'notes.md',
  path,
  bytes: 12,
  sha256,
})

const endpoint = (modalities?: readonly ('text' | 'image')[]): EndpointConfig => ({
  name: 'probe',
  kind: 'openai-chat',
  baseUrl: 'http://127.0.0.1:1',
  ...(modalities !== undefined ? { inputModalities: modalities } : {}),
})

const withImage = (run: (path: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'heddle-attachments-'))
  try {
    const path = join(dir, 'shot.png')
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    run(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a non-image file is a deterministic handle naming the saved read-only path', () => {
  assert.equal(
    fileHandleText(filePart()),
    `[File "notes.md" (12 bytes, sha256:${sha256.slice(0, 8)}): verbatim read-only copy saved at "/tmp/notes.md". ` +
      'Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. ' +
      'When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]',
  )
})

test('an image sent to a text-only route is a deterministic placeholder', () => {
  assert.equal(
    textOnlyImageText(imagePart('/tmp/shot.png')),
    `[image omitted because this model accepts text only; attachment sha256:${sha256.slice(0, 8)}]`,
  )
})

test('the projection keeps an image only for a route that declares image input', () => {
  withImage((path) => {
    const vision = projectAttachments([{ role: 'user', content: [imagePart(path)] }], endpoint(['text', 'image']))
    const kept = vision[0]?.content[0]
    assert.equal(kept?.type, 'image', 'the vision route keeps the image part')
    assert.equal(kept?.type === 'image' ? kept.data : undefined, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), 'with the encoded bytes')
    const text = projectAttachments([{ role: 'user', content: [imagePart(path)] }], endpoint())
    assert.deepEqual(text[0]?.content[0], {
      type: 'text',
      text: `[image omitted because this model accepts text only; attachment sha256:${sha256.slice(0, 8)}]`,
    })
  })
})

test('the projection replaces every file with its handle even on a vision route', () => {
  withImage((path) => {
    const projected = projectAttachments(
      [{ role: 'user', content: [filePart(), imagePart(path)] }],
      endpoint(['text', 'image']),
    )
    assert.equal(projected[0]?.content[0]?.type, 'text', 'the file is text')
    assert.match(projected[0]?.content[0]?.type === 'text' ? projected[0].content[0].text : '', /verbatim read-only copy saved at/)
    assert.equal(projected[0]?.content[1]?.type, 'image', 'and the image still travels')
  })
})

test('an unreadable image degrades to text instead of failing the turn', () => {
  const projected = projectAttachments([{ role: 'user', content: [imagePart('/nonexistent/shot.png')] }], endpoint(['text', 'image']))
  const part = projected[0]?.content[0]
  assert.equal(part?.type, 'text', 'the request is still sendable')
  assert.match(part?.type === 'text' ? part.text : '', /could not be read/)
  assert.match(part?.type === 'text' ? part.text : '', /shot\.png/)
})

test('text, reasoning and tool-call blocks pass through untouched', () => {
  const content: ContentPart[] = [
    { type: 'text', text: 'look' },
    { type: 'reasoning', text: 'thinking' },
    { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
  ]
  const messages: Message[] = [{ role: 'assistant', content }]
  assert.deepEqual(projectAttachments(messages, endpoint()), messages)
})

test('an image reaches the Chat Completions wire as an image_url data URL', () => {
  const message = { role: 'user' as const, content: [imagePart('/tmp/shot.png')] as ContentPart[] }
  const sent = toChatMessage({ ...message, content: [{ ...imagePart('/tmp/shot.png'), data: 'AAAA' } as ContentPart] })
  assert.deepEqual(sent.content, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }])
  assert.equal(toChatMessage({ role: 'user', content: [{ type: 'text', text: 'plain' }] }).content, 'plain', 'a message without images keeps the string form')
})

test('an image reaches the Responses wire as input_image', () => {
  assert.deepEqual(toResponsesContent([{ ...imagePart('/tmp/shot.png'), data: 'AAAA' } as ContentPart]), [
    { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
  ])
  assert.deepEqual(toResponsesContent([{ type: 'text', text: 'look' }]), [{ type: 'input_text', text: 'look' }])
})

test('an image reaches the Anthropic wire as a base64 source block', () => {
  assert.deepEqual(toAnthropicContent([{ ...imagePart('/tmp/shot.png'), data: 'AAAA' } as ContentPart]), [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ])
})

test('image capability is declared per endpoint, and defaults to text', () => {
  assert.equal(acceptsImages(endpoint()), false, 'no declaration means text only')
  assert.equal(acceptsImages(endpoint(['text'])), false)
  assert.equal(acceptsImages(endpoint(['text', 'image'])), true)
  const described = describeEndpoint(endpoint(['text', 'image']))
  assert.deepEqual(described.inputModalities, ['text', 'image'], 'the page can read what a route accepts')
})

test('an image budget offloads the oldest image first, with the DSH placeholder naming it', () => {
  withImage((path) => {
    const messages: Message[] = [
      { role: 'user', content: [{ ...imagePart(path), name: 'first.png' } as ContentPart] },
      { role: 'user', content: [{ ...imagePart(path), name: 'second.png' } as ContentPart] },
      { role: 'user', content: [{ ...imagePart(path), name: 'third.png' } as ContentPart] },
    ]
    const projected = projectAttachments(messages, endpoint(['text', 'image']), { maxImages: 2, maxBytes: 64 * 1024 * 1024 })
    const first = projected[0]?.content[0]
    assert.equal(first?.type, 'text', 'the oldest image is offloaded')
    const text = first?.type === 'text' ? first.text : ''
    assert.match(text, new RegExp(`^\\[image omitted to fit request image limits; "first\\.png" \\(sha256:${sha256}\\)\\. `), 'the placeholder uses DSH identity and wording')
    assert.match(text, /was not sent/, 'and says the stored copy was not sent')
    assert.equal(projected[1]?.content[0]?.type, 'image', 'the newer images are kept')
    assert.equal(projected[2]?.content[0]?.type, 'image')
  })
})

test('an image byte budget offloads as many oldest images as the encoded bytes require', () => {
  withImage((path) => {
    const one = { ...imagePart(path), bytes: 900 } as ContentPart
    const messages: Message[] = [one, one, one].map((part, index) => ({ role: 'user', content: [{ ...part, name: `${index}.png` } as ContentPart] }))
    // Each image is Math.ceil(900/3)*4 = 1200 encoded bytes; two fit 2500, three do not.
    const projected = projectAttachments(messages, endpoint(['text', 'image']), { maxImages: 10, maxBytes: 2500 })
    assert.equal(projected[0]?.content[0]?.type, 'text', 'the oldest is offloaded to fit the byte ceiling')
    assert.equal(projected[1]?.content[0]?.type, 'image')
    assert.equal(projected[2]?.content[0]?.type, 'image')
  })
})

test('the budget never turns a text-only route into an offload, and never touches a file', () => {
  withImage((path) => {
    const messages: Message[] = [
      { role: 'user', content: [filePart(), imagePart(path)] },
    ]
    const projected = projectAttachments(messages, endpoint(), { maxImages: 0, maxBytes: 0 })
    assert.match(projected[0]?.content[0]?.type === 'text' ? projected[0].content[0].text : '', /verbatim read-only copy saved at/, 'the file keeps its handle')
    assert.equal(projected[0]?.content[1]?.type, 'text', 'the image is a text-only placeholder, not an offload')
    assert.match(projected[0]?.content[1]?.type === 'text' ? projected[0].content[1].text : '', /accepts text only/, 'for the capability reason rather than the budget')
  })
})
