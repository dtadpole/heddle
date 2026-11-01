import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { failureCode, failureMessage, providerMessage, WINDOW_REMEDY, wire } from '../src/llm/http.ts'
import { CONTEXT_WINDOW_EXCEEDED, ModelError } from '../src/llm/types.ts'

/**
 * What a refused HTTP call is coded as, and what it says (#153).
 *
 * Live: a session moved to `conclave-claude/claude-sonnet-4-5` was refused with Anthropic's
 * `{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 352406 tokens > 200000 maximum"}}`.
 * The matcher knew only the OpenAI and DeepSeek wordings, so the refusal was a plain `HTTP` failure, overflow recovery
 * logged "not a window overflow", and the page showed the raw JSON. The Rust build pins the same cases in
 * `heddle-llm/src/http.rs`.
 */

const ANTHROPIC_REFUSAL = JSON.stringify({
  type: 'error',
  error: { type: 'invalid_request_error', message: 'prompt is too long: 352406 tokens > 200000 maximum' },
})

test('the OpenAI and DeepSeek wordings are a window refusal, as before', () => {
  assert.equal(failureCode(400, '{"error":{"code":"context_length_exceeded"}}'), CONTEXT_WINDOW_EXCEEDED)
  assert.equal(failureCode(400, "This model's maximum context length is 8192 tokens"), CONTEXT_WINDOW_EXCEEDED)
  assert.equal(failureCode(413, 'the request would exceed the context window'), CONTEXT_WINDOW_EXCEEDED)
  assert.equal(failureCode(422, 'Please reduce the length of the messages'), CONTEXT_WINDOW_EXCEEDED)
  assert.equal(failureCode(400, 'too many tokens in the request'), CONTEXT_WINDOW_EXCEEDED)
  assert.equal(failureCode(400, "request exceeds the model's context limit"), CONTEXT_WINDOW_EXCEEDED)
  assert.equal(failureCode(400, 'CONTEXT_LENGTH_EXCEEDED'), CONTEXT_WINDOW_EXCEEDED, 'case does not matter')
})

test("Anthropic's window refusals are recognised too: a 400 'prompt is too long' and a 413 request_too_large", () => {
  assert.equal(failureCode(400, ANTHROPIC_REFUSAL), CONTEXT_WINDOW_EXCEEDED)
  assert.equal(
    failureCode(413, JSON.stringify({ type: 'error', error: { type: 'request_too_large', message: 'Request exceeds the maximum size' } })),
    CONTEXT_WINDOW_EXCEEDED,
  )
  assert.equal(failureCode(400, 'Prompt too long for the context'), CONTEXT_WINDOW_EXCEEDED)
  assert.equal(failureCode(400, 'input is too long for this model'), CONTEXT_WINDOW_EXCEEDED, "dsh-llm's wording")
  assert.equal(failureCode(400, 'Request is too large for the model'), CONTEXT_WINDOW_EXCEEDED)
})

test('every other failure is an HTTP failure, and the status still decides', () => {
  assert.equal(failureCode(400, 'bad request'), 'HTTP')
  assert.equal(failureCode(401, 'context window'), 'HTTP')
  assert.equal(failureCode(500, 'prompt is too long'), 'HTTP')
  assert.equal(failureCode(529, 'request_too_large'), 'HTTP')
  assert.equal(failureCode(400, 'the tool exceeded its output budget'), 'HTTP')
})

test("a failure says the provider's sentence rather than its JSON", () => {
  assert.equal(providerMessage(ANTHROPIC_REFUSAL), 'prompt is too long: 352406 tokens > 200000 maximum')
  assert.equal(providerMessage('{"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}'), 'Incorrect API key provided')
  assert.equal(providerMessage('{"error":"rate limited"}'), 'rate limited')
  assert.equal(providerMessage('{"message":"no such model"}'), 'no such model')
  // JSON without a sentence, and a body that is not JSON, are kept as they came.
  assert.equal(providerMessage('{"error":{"code":"context_length_exceeded"}}'), '{"error":{"code":"context_length_exceeded"}}')
  assert.equal(providerMessage(' Bad Gateway\n'), 'Bad Gateway')
  assert.equal(providerMessage(''), '')
  assert.equal(providerMessage('x'.repeat(1000)).length, 400)
})

test('a window refusal names the way out, and any other failure does not', () => {
  assert.equal(
    failureMessage('conclave-claude', 400, ANTHROPIC_REFUSAL),
    `'conclave-claude' answered 400 — prompt is too long: 352406 tokens > 200000 maximum. ${WINDOW_REMEDY}`,
  )
  assert.equal(failureMessage('conclave-claude', 400, ANTHROPIC_REFUSAL).includes('"type"'), false, 'no JSON')
  assert.equal(
    failureMessage('chat', 400, "This model's maximum context length is 8192 tokens."),
    `'chat' answered 400 — This model's maximum context length is 8192 tokens. ${WINDOW_REMEDY}`,
    'a sentence that already ends is not given a second full stop',
  )
  assert.equal(failureMessage('chat', 401, '{"error":{"message":"bad key"}}'), "'chat' answered 401 — bad key")
  assert.equal(failureMessage('chat', 503, ''), "'chat' answered 503")
})

test("over the wire, Anthropic's refusal is recoverable and fails with the sentence and the way out", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(ANTHROPIC_REFUSAL)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    const error = await wire({ url: `http://127.0.0.1:${port}/v1/messages`, body: { model: 'm' }, endpoint: 'conclave-claude' }).then(
      () => undefined,
      (failure: unknown) => failure,
    )
    assert.ok(error instanceof ModelError, `a ModelError (${String(error)})`)
    assert.equal(error.code, CONTEXT_WINDOW_EXCEEDED)
    assert.equal(error.status, 400)
    assert.match(error.message, /answered 400 — prompt is too long: 352406 tokens > 200000 maximum\./)
    assert.ok(error.message.endsWith(WINDOW_REMEDY), error.message)
    assert.equal(error.message.includes('{'), false, error.message)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
