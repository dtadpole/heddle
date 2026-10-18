import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { defaultEndpoints, describeEndpoints, resolveEndpoints } from '../src/endpoints.ts'
import { SessionStore, type SessionMeta } from '../src/session/store.ts'
import { resolveTurnEffort, resolveTurnEndpoint, sessionRequestSelection } from '../src/server/web.ts'

/**
 * The three pure decisions behind switching a session's model.
 *
 * The Web UI's switcher is judged in a browser by `_verifiers_/80-web-ui`, which is where a control
 * that renders but does nothing is visible. What is pinned **here** is the part underneath it, because
 * each rule is easy to get subtly wrong and cheap to state in isolation:
 *
 * - which of the four places a name can come from wins when a turn runs;
 * - what the page is told about the endpoints, and what it is never told;
 * - what a switch writes to a session's record, and what it leaves alone.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-model-switcher-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

test('a turn is answered by the nearest name: the request, the session, the server, the service', () => {
  /**
   * The order is the whole rule, and it is the one DSH's model selection keeps: a session that a person
   * switched is answered by what they chose, a run that names an endpoint is answered by that, and only a
   * session with no choice of its own falls back to the server's default — the flag `heddle web --endpoint`
   * carries — and then to the configuration's own nomination.
   *
   * Measured while writing this: the earlier code read `body.endpoint ?? serverDefault ?? serviceDefault`, so
   * a session switched from the panel was answered by the server flag the moment a reload lost the request's
   * choice. The session's own record has to sit above the server's default or the switch is a per-request
   * illusion.
   */
  assert.equal(
    resolveTurnEndpoint({ requested: 'a', recorded: 'b', serverDefault: 'c', serviceDefault: 'd' }),
    'a',
    'the request wins while it is present',
  )
  assert.equal(
    resolveTurnEndpoint({ recorded: 'b', serverDefault: 'c', serviceDefault: 'd' }),
    'b',
    'then the session’s own record, which is what makes a switch survive a reload',
  )
  assert.equal(resolveTurnEndpoint({ serverDefault: 'c', serviceDefault: 'd' }), 'c', 'then the server flag')
  assert.equal(resolveTurnEndpoint({ serviceDefault: 'd' }), 'd', 'then the configured default')
  assert.equal(resolveTurnEndpoint({}), undefined, 'and nothing named is nothing, not the empty string')
  /**
   * The empty string is not a name. A page that sends `endpoint: ''` must fall through rather than ask the
   * model service for an endpoint called nothing — which is the failure that reads as "no endpoint named
   * ''" in a log, and as a broken model in a browser.
   */
  assert.equal(resolveTurnEndpoint({ requested: '', recorded: 'b' }), 'b', 'an empty request is absent')
})

test('the page is told every endpoint, and never a credential', () => {
  /**
   * The switcher needs the list to offer anything at all, and the list is derived from the same
   * `describeEndpoint` the CLI prints, so there is one answer to "what is safe to say about an endpoint"
   * rather than two that can drift. The claim is the negative half: a key, a key path and a header are
   * all settings that can carry a secret, and none of them may appear in a payload an unauthenticated
   * error path or a browser's own console could print.
   */
  const described = describeEndpoints(
    [
      {
        name: 'plugboard',
        kind: 'openai-chat',
        baseUrl: 'https://example.invalid',
        model: 'deepseek-flash',
        apiKey: 'sk-do-not-print-this',
        apiKeyFile: '/home/someone/.keys/provider.key',
        headers: { authorization: 'Bearer also-a-secret' },
        capabilities: ['chat', 'stream'],
      },
      { name: 'scripted', kind: 'scripted', baseUrl: 'scripted.json', model: 'scripted' },
    ],
    'plugboard',
  )

  assert.deepEqual(
    described.endpoints.map((endpoint) => endpoint.name),
    ['plugboard', 'scripted'],
    'every configured endpoint is offered, in declaration order',
  )
  assert.equal(described.default, 'plugboard', 'the resolved default travels with the list')
  const text = JSON.stringify(described)
  assert.doesNotMatch(text, /sk-do-not-print-this/, 'the key value is not in the payload')
  assert.doesNotMatch(text, /also-a-secret/, 'nor is a header value')
  assert.match(text, /"credential":"set"/, 'only that a credential exists')
  /**
   * The **path** a key is read from is reported, and that is the existing contract rather than a leak:
   * `describeEndpoint` says "presence, never the value", the CLI's `models` command prints the same
   * summary, and the whole reason this route reuses it is so there is one answer to what is safe to say.
   * A second, stricter shape here would be the drift the reuse prevents — and a file name is what a
   * person needs to fix a missing key.
   */
  assert.match(text, /"credentialFile":"\/home\/someone\/\.keys\/provider\.key"/, 'the file it is read from, as presence')
})

test('the list points at something real, or at nothing', () => {
  /**
   * A default that names an endpoint which is not configured would make the page select an option that is
   * not in its own menu. DSH resolves the default the same way — a selection the catalog does not hold is
   * not a selection — and `null` is the honest answer, because the page has no option to mark.
   */
  const endpoints = [{ name: 'a', kind: 'scripted', baseUrl: 'a.json', model: 'a' }] as const
  assert.equal(describeEndpoints(endpoints, 'a').default, 'a', 'a name that is there is kept')
  assert.equal(describeEndpoints(endpoints, 'gone').default, null, 'a name that is not there is not invented')
  assert.equal(describeEndpoints(endpoints, undefined).default, null, 'and no nomination is no default')
})

test('switching a session records the endpoint and drops a model override the endpoint no longer carries', () => {
  const root = join(scratch, 'store')
  const sessions = new SessionStore(root)
  const handle = sessions.create({ cwd: scratch, endpoint: 'scripted', model: 'tiny' })
  const before = readFileSync(handle.transcript)

  const changed = sessions.setModel(handle.id, { endpoint: 'plugboard' })
  assert.equal(changed?.endpoint, 'plugboard', 'the new endpoint is recorded')
  assert.equal(changed?.model, undefined, 'the old model override is gone rather than merged')

  /**
   * Read back from disk rather than from the answer: a second process — another heddle, or the CLI —
   * learns a session's model by reading this file, and a switch that only changed a value in memory is a
   * switch that does not survive the browser being closed.
   */
  const meta = JSON.parse(readFileSync(handle.meta, 'utf8')) as Record<string, unknown>
  assert.equal(meta.endpoint, 'plugboard')
  assert.equal('model' in meta, false, 'a model that is not named is removed, not set to the empty string')

  /**
   * The meta file is a record, not the log. A switch must not touch the transcript: a run's events are
   * append-only, and rewriting them to record a preference would be the one thing the store promises not
   * to do.
   */
  assert.ok(readFileSync(handle.transcript).equals(before), 'the transcript is untouched')

  const withModel = sessions.setModel(handle.id, { endpoint: 'plugboard', model: 'deepseek-chat' })
  assert.equal(withModel?.model, 'deepseek-chat', 'a model that is named is recorded with the endpoint')
  assert.equal(sessions.setModel('session-00000000-0000-0000-0000-000000000000', { endpoint: 'x' }), null, 'an unknown session answers null rather than writing a file')
})

test('an endpoint summary carries the context window when it declares one', () => {
  /** The status line's context share needs a denominator the endpoint itself states; inventing one is worse. */
  const described = describeEndpoints([{ name: 'big', kind: 'openai-chat', baseUrl: 'http://127.0.0.1:1', contextWindow: 128000 }])
  assert.equal(described.endpoints[0]?.contextWindow, 128000)
  const quiet = describeEndpoints([{ name: 'unstated', kind: 'openai-chat', baseUrl: 'http://127.0.0.1:1' }])
  assert.equal('contextWindow' in (quiet.endpoints[0] ?? {}), false, 'and says nothing when the endpoint does not')
})

test('the repository ships no machine-specific endpoint default', () => {
  /**
   * The defaults are what a fresh clone runs against, so every one of them must be offline and true on any
   * machine. `localhost` was a loopback endpoint pointing at port 8790 — the plugboard signing helper, which only
   * exists where one is running — and it was removed on 2026-10-17 at the owner's instruction. It also read as a
   * real destination in a provider list while duplicating the `plugboard-d` endpoint beside it.
   *
   * This is asserted rather than recorded, because the failure it prevents is somebody adding a convenient loopback
   * default back: a fresh clone would then advertise an endpoint that cannot answer.
   */
  assert.deepEqual(
    defaultEndpoints().map((endpoint) => endpoint.name),
    ['scripted'],
    'the only default is the offline fixture',
  )
  assert.ok(
    defaultEndpoints().every((endpoint) => endpoint.kind === 'scripted'),
    'and it points at no network address at all',
test('a local configuration can exclude the repository’s offline default from the catalogue', () => {
  /**
   * The repository's remaining default after the 2026-10-17 endpoint cleanup is the offline `scripted` fixture,
   * which exists so a fresh clone runs its checks with no setup; it is not a backend a person chose. The local file
   * needs a way to say "not in my selector" without the repository giving up that default, so `exclude` is applied
   * after every layer has merged.
   *
   * The shape is asserted with the current defaults: the fixture is present unless excluded, and excluding it
   * leaves only the operator's own endpoints. Another session removed `localhost` from the defaults, so the check
   * names only what the merged tree actually ships.
   */
  const configured = [
    { name: 'claude-opus', kind: 'anthropic-vertex' as const, baseUrl: 'http://127.0.0.1:1', project: 'p', region: 'global' },
    { name: 'plugboard-d', kind: 'openai-chat' as const, baseUrl: 'http://127.0.0.1:2' },
  ]
  assert.deepEqual(defaultEndpoints().map((endpoint) => endpoint.name), ['scripted'], 'the only default is the offline fixture')
  const all = resolveEndpoints(configured, [])
  assert.deepEqual(all.map((endpoint) => endpoint.name), ['scripted', 'claude-opus', 'plugboard-d'], 'the fixture is offered by default')
  const filtered = resolveEndpoints(configured, [], {}, ['scripted'])
  assert.deepEqual(
    filtered.map((endpoint) => endpoint.name),
    ['claude-opus', 'plugboard-d'],
    'excluding it leaves the operator’s catalogue only',
  )
})
test('a switch records the reasoning level with the model, and a switch that names neither clears both', () => {
  /**
   * The level is part of the selection, not a second write: a session is run with one endpoint, one model and
   * one effort, and recording them apart would allow a model from one switch beside an effort from another —
   * which is a provider request nobody made and, for a model that does not declare that level, a refusal on
   * every following turn.
   */
  const root = join(scratch, 'effort-store')
  const sessions = new SessionStore(root)
  const handle = sessions.create({ cwd: scratch, endpoint: 'two-tier', model: 'model-a', reasoningEffort: 'low' })
  assert.equal(sessions.list().find((meta) => meta.id === handle.id)?.reasoningEffort, 'low', 'a born session can carry one')

  const changed = sessions.setModel(handle.id, { endpoint: 'two-tier', model: 'model-a', reasoningEffort: 'max' })
  assert.equal(changed?.reasoningEffort, 'max', 'the level is recorded with the selection')
  const meta = JSON.parse(readFileSync(handle.meta, 'utf8')) as Record<string, unknown>
  assert.equal(meta.reasoningEffort, 'max', 'and it is on disk, which is what a reload reads')

  const cleared = sessions.setModel(handle.id, { endpoint: 'two-tier', model: 'model-b' })
  assert.equal(cleared?.model, 'model-b', 'a new model is recorded')
  assert.equal(cleared?.reasoningEffort, undefined, 'and the previous model’s level is gone rather than carried over')
  assert.equal('reasoningEffort' in (JSON.parse(readFileSync(handle.meta, 'utf8')) as Record<string, unknown>), false)
})

test('a model request records the reasoning level it was sent with', () => {
  /**
   * The trajectory view reads this event, and so does a check that wants to know what a turn actually asked
   * for. Recording the level only in the request object would make "did the running turn use the effort I
   * switched to?" unanswerable after the fact.
   */
  const root = join(scratch, 'request-store')
  const sessions = new SessionStore(root)
  const handle = sessions.create({ cwd: scratch, endpoint: 'two-tier' })
  sessions.modelRequest(handle, {
    endpoint: 'two-tier',
    model: 'model-a',
    reasoningEffort: 'high',
    messages: 1,
    tools: [],
  })
  const request = sessions.read(handle).find((event) => event.type === 'model/request')
  assert.equal(request?.reasoningEffort, 'high', 'the level travels with the recorded request')
})

test('the effort a turn runs with is the request’s, then the session’s record, then nothing', () => {
  /**
   * The same ladder as the endpoint, and for the same reason: a reload sends the session id without a
   * choice, so a recorded level below the request is what makes a switch survive it. An empty string is
   * absence rather than a level named nothing.
   */
  assert.equal(resolveTurnEffort({ requested: 'low', recorded: 'max' }), 'low', 'a request that names one wins')
  assert.equal(resolveTurnEffort({ recorded: 'max' }), 'max', 'then the session’s own record')
  assert.equal(resolveTurnEffort({}), undefined, 'nothing named is nothing')
  assert.equal(resolveTurnEffort({ requested: '', recorded: 'max' }), 'max', 'an empty request is absent')
})

test('the session’s recorded selection is what every model call of its turn is given', () => {
  /**
   * The `model/request` waterfall's rule, as a pure function so it can be judged without a server: a running
   * turn may be switched, and DSH applies a concurrent switch to a **later step**. That is only true if each
   * request is rebuilt from the session's current record rather than from the values the turn started with.
   */
  const record = (selection: Partial<SessionMeta>): SessionMeta => ({
    id: 'session-a',
    created: '2026-10-17T00:00:00.000Z',
    cwd: scratch,
    turns: 0,
    ...selection,
  })
  assert.deepEqual(
    sessionRequestSelection(record({ endpoint: 'plugboard-ds', model: 'deepseek-flash', reasoningEffort: 'max' })),
    { endpoint: 'plugboard-ds', model: 'deepseek-flash', reasoningEffort: 'max' },
    'all three parts travel together',
  )
  assert.deepEqual(
    sessionRequestSelection(record({ endpoint: 'plugboard-ds' })),
    { endpoint: 'plugboard-ds' },
    'a record with no model names no model rather than an empty string',
  )
  assert.deepEqual(sessionRequestSelection(undefined), {}, 'a request with no session record is left alone')
  assert.deepEqual(
    sessionRequestSelection(record({ reasoningEffort: 'high' })),
    {},
    'a record without an endpoint cannot name a selection, so it changes nothing',
  )
})
