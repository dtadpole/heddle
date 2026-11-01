import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { SessionService, titleFrom } from '../src/session/service.ts'
import type { TitleAnswer } from '../src/session/title.ts'

/**
 * #33: every title the store writes is announced, not only a person's rename. DSH records each title change, and every
 * view of the session follows it (inventory-shell S16). Heddle keeps the title in the meta record, so the store's
 * `onRenamed` hook is the one seam. The session plugin re-emits it as `session/renamed`, and the Web UI pushes it to
 * every page.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-session-renamed-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

const PROMPT = 'Please summarise the quarterly revenue figures for the northern region and compare them with last year, thanks.'
const stop = (text: string): TitleAnswer => ({ text, finishReason: 'stop', toolCalls: [] })

test("every title the store writes is announced after the write: the first message's, the model's and a person's", async () => {
  /** Each announcement, with the title the store holds when it is heard: a listener never hears ahead of the record. */
  const heard: { id: string; title: string; stored: string | undefined }[] = []
  const sessions: SessionService = new SessionService(
    new Context(),
    { root: join(scratch, 'sessions') },
    { onRenamed: (id, title) => heard.push({ id, title, stored: sessions.list().find((meta) => meta.id === id)?.title }) },
  )
  sessions.store.titles.attach(async () => stop('Quarterly revenue comparison'))
  const handle = sessions.start({ cwd: scratch })
  assert.deepEqual(heard, [], 'a new session is untitled, so nothing is announced')

  sessions.user(handle, PROMPT)
  sessions.store.modelRequest(handle, { endpoint: 'scripted', messages: 1, tools: [] })
  await sessions.store.titles.settle()
  sessions.rename(handle.id, 'named by a person')
  sessions.user(handle, 'a second prompt names nothing')
  assert.equal(heard.length, 3, 'a message that writes no title announces none')
  sessions.rename(handle.id, '')
  const id = handle.id
  assert.deepEqual(heard, [
    { id, title: titleFrom(PROMPT), stored: titleFrom(PROMPT) },
    { id, title: 'Quarterly revenue comparison', stored: 'Quarterly revenue comparison' },
    { id, title: 'named by a person', stored: 'named by a person' },
    { id, title: '', stored: undefined },
  ])
})

test('a rename listener that throws is logged, and the title it announced still lands', () => {
  /** developer-eight's review: the first-message fallback renames inside userContent, which a throwing listener failed. */
  const sessions = new SessionService(new Context(), { root: join(scratch, 'throwing') }, {
    onRenamed: () => {
      throw new Error('listener down')
    },
  })
  const handle = sessions.start({ cwd: scratch })
  const written: string[] = []
  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => (written.push(String(chunk)), true)) as typeof process.stderr.write
  try {
    assert.doesNotThrow(() => sessions.user(handle, PROMPT), 'the message is recorded')
    assert.doesNotThrow(() => sessions.rename(handle.id, 'named by a person'), 'and a rename returns')
  } finally {
    process.stderr.write = write
  }
  assert.equal(sessions.list().find((meta) => meta.id === handle.id)?.title, 'named by a person', 'each title landed')
  assert.equal(written.filter((line) => line.includes('a rename listener failed') && line.includes('listener down')).length, 2, 'and each failure was logged')
})
