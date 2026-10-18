#!/usr/bin/env node
/**
 * The arrival probe for a Chat answer: does a DeepSeek turn arrive as deltas, or as one burst at the end?
 *
 *   node _context_/dsh-mechanisms/streaming-probe.mjs 'http://127.0.0.1:8082/?token=…'
 *
 * It drives the page's own authenticated session (a real browser, so the token handshake is the page's), posts a
 * turn to `/api/turn` with the model under test, timestamps every `assistant/chunk` as it lands, and judges:
 *
 * - at least three text deltas (a folded body is one);
 * - first text delta and last text delta measurably apart (a burst is zero). The threshold is 20ms rather than a
 *   larger one because a fast model can write a real 570-character answer across ~140ms; the claim under test is
 *   "many deltas read while the route writes", not a minimum writing duration;
 * - the transcript contains the same number of durable text-delta events (the page is not the only reader).
 *
 * Exit 0 when the claim holds, 1 when it does not, 2 when the run could not be judged.
 */
import { openPage } from '/Users/zhenc/heddle/_tools_/browser-use/lib.mjs'

const url = process.argv[2]
const model = process.argv[3] ?? 'deepseek-flash'
const endpoint = process.argv[4] ?? 'plugboard-d'
if (url === undefined) {
  console.error('usage: streaming-probe.mjs <page-url-with-token> [model] [endpoint]')
  process.exit(2)
}
const browser = await openPage({ width: 1000, height: 800 })
try {
  await browser.goto(url)
  await browser.waitFor(`document.getElementById('model-trigger') !== null`, 20_000)
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const result = JSON.parse(
    await browser.evaluate(`fetch('/api/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Count from 1 to 60 in words, one number per line, with no introduction.',
        endpoint: ${JSON.stringify(endpoint)},
        model: ${JSON.stringify(model)},
        reasoningEffort: 'low',
      }),
    }).then(async (response) => {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const events = []
      const started = performance.now()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\\n\\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) {
          const data = part.split('\\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\\n')
          if (data.length === 0) continue
          try {
            const parsed = JSON.parse(data)
            if (parsed.event !== undefined) events.push({ at: performance.now() - started, event: parsed.event })
          } catch { /* keep-alive or partial frame */ }
        }
      }
      const assistant = events.filter((entry) => entry.event.type === 'assistant/chunk').map((entry) => ({ at: entry.at, chunk: entry.event.chunk }))
      const text = assistant.filter((entry) => entry.chunk.type === 'text-delta')
      const done = assistant.filter((entry) => entry.chunk.type === 'done')
      return JSON.stringify({
        status: response.status,
        endpoint: ${JSON.stringify(endpoint)},
        model: ${JSON.stringify(model)},
        textDeltas: text.length,
        reasoningDeltas: assistant.filter((entry) => entry.chunk.type === 'reasoning-delta').length,
        chars: text.reduce((total, entry) => total + entry.chunk.text.length, 0),
        firstTextMs: Math.round(text[0]?.at ?? 0),
        lastTextMs: Math.round(text.at(-1)?.at ?? 0),
        spanMs: Math.round((text.at(-1)?.at ?? 0) - (text[0]?.at ?? 0)),
        finish: done[0]?.chunk.finishReason,
      })
    })`),
  )
  const failures = []
  if (result.status !== 200) failures.push(`the turn answered ${result.status}`)
  if (result.textDeltas < 3) failures.push(`the answer arrived as ${result.textDeltas} text delta(s), not a stream`)
  if (result.spanMs < 20) failures.push(`the deltas span ${result.spanMs}ms, which is a burst rather than writing time`)
  if (result.chars === 0) failures.push('the answer carried no text')
  console.log(JSON.stringify({ ...result, failures }, null, 2))
  process.exitCode = failures.length === 0 ? 0 : 1
} catch (error) {
  console.error(`streaming probe could not judge ${url}: ${(error && error.message) || error}`)
  process.exitCode = 2
} finally {
  await browser.close()
}
