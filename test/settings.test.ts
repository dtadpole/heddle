import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { compose, defaultLayers, type NamedLayer } from '../src/config/schema.ts'
import {
  handleSettingsRequest,
  loopbackHost,
  SETTINGS_BEGIN,
  SETTINGS_END,
  SettingsError,
  SettingsService,
  settingsTarget,
  type LayerOptions,
  type SettingsWrite,
} from '../src/config/settings.ts'
import type { ValidationResult } from '../src/config/validate.ts'

/**
 * The settings surface, judged against DSH's settings and config-editor behaviour. The Rust port's
 * `heddle-config` settings tests decide the same claims, and the block bytes asserted here are the bytes
 * that crate writes.
 */

const PROFILE =
  '# the dev profile, written by hand\n- insert:\n    - id: tools\n      name: tools\n      config: {bashTimeoutMs: 30000, label: plain}\n    - id: keys\n      name: keys\n      config: {token: "${D1_TOKEN}", label: shown}\n'

/** A stand-in for `validateRows`: `tools.bashTimeoutMs` must be a number, `tools` takes no other keys. */
const validate = async (layers: readonly NamedLayer[], env: NodeJS.ProcessEnv): Promise<ValidationResult> => {
  const rows = compose(layers, env)
  const problems: string[] = []
  for (const { row } of rows) {
    if (row.id !== 'tools') continue
    const config = (row.config ?? {}) as Record<string, unknown>
    if (config.bashTimeoutMs !== undefined && typeof config.bashTimeoutMs !== 'number') problems.push('tools: bashTimeoutMs expected number')
    for (const key of Object.keys(config)) if (!['bashTimeoutMs', 'label'].includes(key)) problems.push(`tools: unknown property ${key}`)
  }
  return { rows: rows.length, checked: rows.length, problems }
}
const schemaOf = async (row: { readonly name: string }) => (row.name === 'tools' ? { type: 'object', dict: { bashTimeoutMs: { type: 'number' } } } : null)

function fixture(label: string) {
  const root = join(tmpdir(), `heddle-settings-${process.pid}-${label}`)
  rmSync(root, { recursive: true, force: true })
  const profile = join(root, 'home/profiles/dev')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), PROFILE)
  const env = { HEDDLE_HOME: join(root, 'home'), HOME: root, D1_TOKEN: 'secret-value' }
  const patchFile = join(profile, 'heddle.patch.yml')
  const service = (patches: readonly string[] = []) => {
    const options: LayerOptions = { profile: 'dev', patches }
    const layers = defaultLayers({ ...options, env })
    return new SettingsService(layers, settingsTarget(options, layers, env), env, validate, schemaOf)
  }
  const composed = (ns: string) => {
    const rows = compose(defaultLayers({ profile: 'dev', env }), env)
    return rows.find((row) => row.row.id === ns)?.row.config as Record<string, unknown>
  }
  return { root, env, patchFile, service, composed, done: () => rmSync(root, { recursive: true, force: true }) }
}

const update = (fields: Record<string, unknown>): SettingsWrite => ({ kind: 'update', fields })

test('the target is the active profile patch and an overlay run has none', () => {
  const f = fixture('target')
  const options: LayerOptions = { profile: 'dev' }
  const layers = defaultLayers({ ...options, env: f.env })
  assert.deepEqual(settingsTarget(options, layers, f.env), { path: f.patchFile, label: 'dev/heddle.patch.yml', index: 1 })
  const project = join(f.root, 'project')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'cordis.yml'), '[]\n')
  const base: LayerOptions = { base: join(project, 'cordis.yml'), includeProjectPatch: true }
  assert.equal(settingsTarget(base, defaultLayers({ ...base, env: f.env }), f.env)?.path, join(project, 'heddle.patch.yml'))
  const overlay: LayerOptions = { base: join(project, 'cordis.yml'), patches: [join(project, 'cordis.yml')] }
  assert.equal(settingsTarget(overlay, defaultLayers({ ...overlay, env: f.env }), f.env), undefined)
  f.done()
})

test('describe lists each entry with secrets reduced to presence', async () => {
  const f = fixture('describe')
  const view = await f.service().describe()
  assert.equal(view.writable, true)
  assert.equal(view.hasDocument, false)
  const tools = view.namespaces.find((entry) => entry.ns === 'tools')
  assert.deepEqual(tools?.value, { bashTimeoutMs: 30000, label: 'plain' })
  assert.equal(tools?.revision, 1)
  assert.equal(tools?.editable, true)
  assert.equal(tools?.applies, 'restart')
  const keys = view.namespaces.find((entry) => entry.ns === 'keys')
  assert.deepEqual(keys?.value, { label: 'shown' })
  assert.deepEqual(keys?.secrets, [{ path: ['token'], set: true }])
  assert.ok(!JSON.stringify(view).includes('secret-value'))
  f.done()
})

test('an update lands in the profile patch, keeps the rest byte for byte, and the next boot composes it', async () => {
  const f = fixture('update')
  const handwritten = '# kept as written\n- patch:\n    - id: keys\n      config: {token: "${D1_TOKEN}", label: by-hand}\n'
  writeFileSync(f.patchFile, handwritten)
  const service = f.service()
  const revision = (await service.describe()).namespaces.find((entry) => entry.ns === 'tools')?.revision
  const entry = await service.write('tools', update({ bashTimeoutMs: 60000 }), revision)
  const text = readFileSync(f.patchFile, 'utf8')
  assert.ok(text.startsWith(handwritten))
  assert.equal(
    text.slice(handwritten.length),
    `${SETTINGS_BEGIN} (written by the settings API; a value may be edited here, keep both marker lines)\n- patch:\n    - id: "tools"\n      config: {"bashTimeoutMs": 60000, "label": "plain"}\n${SETTINGS_END}\n`,
    'the same bytes the Rust port writes',
  )
  assert.deepEqual(f.composed('tools'), { bashTimeoutMs: 60000, label: 'plain' })
  assert.equal(entry.revision, (revision ?? 0) + 1)
  assert.deepEqual(entry.user, { bashTimeoutMs: 60000 })
  assert.deepEqual(entry.base, { bashTimeoutMs: 30000, label: 'plain' })
  f.done()
})

test('a stale write is refused as a conflict and changes nothing', async () => {
  const f = fixture('stale')
  const service = f.service()
  const read = (await service.describe()).namespaces.find((entry) => entry.ns === 'tools')?.revision ?? 0
  await service.write('tools', update({ label: 'first' }), read)
  const written = readFileSync(f.patchFile, 'utf8')
  await assert.rejects(service.write('tools', update({ label: 'second' }), read), (error: unknown) => {
    assert.ok(error instanceof SettingsError)
    assert.equal(error.code, 'settings-conflict')
    assert.equal(error.expected, read)
    assert.equal(error.actual, read + 1)
    return true
  })
  assert.equal(readFileSync(f.patchFile, 'utf8'), written)
  f.done()
})

test('an invalid value is refused naming the row and no file is written', async () => {
  const f = fixture('invalid')
  await assert.rejects(f.service().write('tools', update({ bashTimeoutMs: 'soon' })), /tools/)
  assert.equal(existsSync(f.patchFile), false)
  f.done()
})

test('a higher layer that restates the row refuses the write', async () => {
  const f = fixture('override')
  const overlay = join(f.root, 'overlay.yml')
  writeFileSync(overlay, '- patch:\n    - id: tools\n      config: {bashTimeoutMs: 1000}\n')
  const service = f.service([overlay])
  const tools = (await service.describe()).namespaces.find((entry) => entry.ns === 'tools')
  assert.equal(tools?.editable, false)
  assert.match(tools?.reason ?? '', /takes precedence/)
  await assert.rejects(service.write('tools', update({ label: 'x' })), new RegExp(overlay))
  assert.equal(existsSync(f.patchFile), false)
  f.done()
})

test('unset restores the base and an empty block restores the file', async () => {
  const f = fixture('unset')
  const original = '# my patch\n- patch:\n    - id: keys\n      config: {token: "${D1_TOKEN}", label: mine}\n'
  writeFileSync(f.patchFile, original)
  const service = f.service()
  await service.write('tools', update({ bashTimeoutMs: 5 }))
  await service.write('tools', { kind: 'mutate', ops: [{ op: 'unset', path: ['bashTimeoutMs'] }] })
  assert.equal(readFileSync(f.patchFile, 'utf8'), original)
  assert.equal(f.composed('tools').bashTimeoutMs, 30000)
  f.done()
})

test('replace resets every field then sets the given ones', async () => {
  const f = fixture('replace')
  const service = f.service()
  await service.write('tools', update({ bashTimeoutMs: 5, label: 'x' }))
  await service.write('tools', { kind: 'replace', fields: { label: 'y' } })
  assert.deepEqual(f.composed('tools'), { bashTimeoutMs: 30000, label: 'y' })
  f.done()
})

test('secrets and references are never written and an existing reference stays raw', async () => {
  const f = fixture('secrets')
  const service = f.service()
  await assert.rejects(service.write('keys', update({ token: 'pasted' })), /secret/)
  await assert.rejects(service.write('keys', update({ label: '${HOME}' })), /environment reference/)
  await service.write('keys', update({ label: 'edited' }))
  const text = readFileSync(f.patchFile, 'utf8')
  assert.ok(text.includes('"token": "${D1_TOKEN}"'), text)
  assert.ok(!text.includes('secret-value'))
  assert.equal(f.composed('keys').token, 'secret-value')
  f.done()
})

test('a hand edit moves the revision and a write holding the old one is a conflict', async () => {
  const f = fixture('hand-edit')
  const service = f.service()
  const first = (await service.describe()).namespaces.find((entry) => entry.ns === 'tools')?.revision ?? 0
  writeFileSync(f.patchFile, '- patch:\n    - id: tools\n      config: {bashTimeoutMs: 7}\n')
  const second = (await service.describe()).namespaces.find((entry) => entry.ns === 'tools')?.revision
  assert.equal(second, first + 1)
  await assert.rejects(service.write('tools', update({ label: 'x' }), first), { code: 'settings-conflict' })
  f.done()
})

test('an entry an overlay inserts is not the profile’s to edit', async () => {
  const f = fixture('overlay-insert')
  const overlay = join(f.root, 'extra.yml')
  writeFileSync(overlay, '- insert:\n    - id: extra\n      name: tools\n      config: {label: o}\n')
  const extra = (await f.service([overlay]).describe()).namespaces.find((entry) => entry.ns === 'extra')
  assert.equal(extra?.editable, false)
  assert.match(extra?.reason ?? '', /not the profile's own layer/)
  f.done()
})

test('the routes answer as DSH settings calls do', async () => {
  const f = fixture('routes')
  const service = f.service()
  const call = async (method: string, path: string, body: unknown = null) => {
    const answer = await handleSettingsRequest(service, method, path, JSON.stringify(body))
    assert.ok(answer !== undefined)
    return answer as { status: number; body: Record<string, unknown> }
  }
  const view = await call('GET', '/api/settings')
  assert.equal(view.status, 200)
  assert.equal(view.body.writable, true)
  const written = await call('POST', '/api/settings/tools', { update: { label: 'routed' }, expectedRevision: 1 })
  assert.equal(written.status, 200)
  assert.equal((written.body.value as Record<string, unknown>).label, 'routed')
  assert.equal(written.body.revision, 2)
  const stale = await call('POST', '/api/settings/tools', { update: { label: 'late' }, expectedRevision: 1 })
  assert.equal(stale.status, 409)
  assert.deepEqual([stale.body.code, stale.body.expected, stale.body.actual], ['settings-conflict', 1, 2])
  const invalid = await call('POST', '/api/settings/tools', { update: { bashTimeoutMs: [] } })
  assert.equal(invalid.status, 422)
  assert.equal(invalid.body.code, 'settings-rejected')
  const ops = await call('POST', '/api/settings/tools', { ops: [{ op: 'unset', path: ['label'] }] })
  assert.equal(ops.status, 200)
  assert.equal((ops.body.value as Record<string, unknown>).label, 'plain')
  assert.equal((await call('POST', '/api/settings/tools', { update: {}, replace: {} })).status, 400)
  assert.equal((await call('GET', '/api/settings/keys')).body.ns, 'keys')
  assert.equal((await call('GET', '/api/settings/nowhere')).status, 404)
  assert.equal((await call('DELETE', '/api/settings/tools')).status, 405)
  assert.equal(await handleSettingsRequest(service, 'GET', '/api/status', ''), undefined)
  f.done()
})

test('with an applier a write is applied to the running tree at once and reported live', async () => {
  const f = fixture('live')
  const options: LayerOptions = { profile: 'dev' }
  const layers = defaultLayers({ ...options, env: f.env })
  const applied: [string, unknown][] = []
  const service = new SettingsService(layers, settingsTarget(options, layers, f.env), f.env, validate, schemaOf, async (ns, config) => {
    applied.push([ns, config])
  })
  assert.equal((await service.describe()).namespaces.find((entry) => entry.ns === 'tools')?.applies, 'live')
  const entry = await service.write('tools', update({ bashTimeoutMs: 60000 }))
  assert.deepEqual(applied, [['tools', { bashTimeoutMs: 60000, label: 'plain' }]], 'the composed config, as the next boot would give it')
  assert.equal(entry.applyError, undefined)
  await service.write('keys', update({ label: 'edited' }))
  assert.deepEqual(applied[1], ['keys', { token: 'secret-value', label: 'edited' }], 'resolved, so the running entry gets the value, not the reference')
  f.done()
})

test('a write the running tree refuses is still written and says so', async () => {
  const f = fixture('live-refused')
  const options: LayerOptions = { profile: 'dev' }
  const layers = defaultLayers({ ...options, env: f.env })
  const service = new SettingsService(layers, settingsTarget(options, layers, f.env), f.env, validate, schemaOf, async () => {
    throw new Error('the entry could not be re-applied')
  })
  const entry = await service.write('tools', update({ bashTimeoutMs: 60000 }))
  assert.equal(entry.applyError, 'the entry could not be re-applied')
  assert.match(readFileSync(f.patchFile, 'utf8'), /"bashTimeoutMs": 60000/, 'the next boot still applies it')
  const plain = new SettingsService(layers, settingsTarget(options, layers, f.env), f.env, validate, schemaOf)
  assert.equal((await plain.describe()).namespaces.find((entry) => entry.ns === 'tools')?.applies, 'restart', 'without an applier the next boot applies a write')
  f.done()
})

test('Open configuration file: only for a page on this machine, pathless, and an absent patch is created empty (A95)', async () => {
  assert.equal(loopbackHost('127.0.0.1:8082'), true)
  assert.equal(loopbackHost('localhost:3000'), true)
  assert.equal(loopbackHost('[::1]:80'), true)
  assert.equal(loopbackHost('heddle.example.com'), false)
  assert.equal(loopbackHost('203.0.113.4:8082'), false)
  assert.equal(loopbackHost(undefined), false)
  const f = fixture('open-document')
  try {
    const opened: string[] = []
    const opener = async (path: string) => {
      opened.push(path)
    }
    const ask = (loopback: boolean, body: unknown) => handleSettingsRequest(f.service(), 'POST', '/api/settings', JSON.stringify(body), { loopback, opener })
    assert.equal((await ask(false, { open: 'document' }))?.status, 403)
    assert.equal((await ask(true, { open: 'folder' }))?.status, 400)
    assert.equal((await ask(true, { open: 'document', path: '/etc/passwd' }))?.status, 400, 'pathless: a body naming anything else is refused')
    assert.deepEqual(opened, [], 'nothing opened for a refusal')
    assert.equal(existsSync(f.patchFile), false)
    assert.deepEqual(await ask(true, { open: 'document' }), { status: 200, body: { opened: true } })
    assert.deepEqual(opened, [f.patchFile], 'the profile patch, resolved by the server')
    assert.equal(readFileSync(f.patchFile, 'utf8'), '', 'created empty')
    writeFileSync(f.patchFile, '- insert: []\n')
    await ask(true, { open: 'document' })
    assert.equal(readFileSync(f.patchFile, 'utf8'), '- insert: []\n', 'an existing patch is left alone')
  } finally {
    f.done()
  }
})
