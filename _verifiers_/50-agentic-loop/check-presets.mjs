import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Agent presets (inventory A96): "a new session with a non-default preset gets its tool set".
 *
 * DSH's preset registry (dsh-agent-preset-registry, dsh-agent-preset, dsh-persona): a preset is a named composition of
 * an agent's tools and persona; the registry has a default; a session records the preset it was created with and keeps
 * it; a preset that is not declared is refused. heddle declares presets as one `presets` profile row. The check adds the
 * row through a `--patch` overlay on the default tree and drives `heddle web` through its routes with the offline
 * scripted endpoint, reading what each model request offered from the turn's own `model/request` records.
 */
const CAPABILITY = 'agent presets in the Web UI'
const PERSONA = 'You are a careful reviewer who reads files and never edits them.'

async function startServer(label) {
  const home = isolatedHome(`presets-${label}`)
  const work = fixtureDir(`presets-${label}-work`)
  const { config, script } = scriptedConfig({ home, steps: [{ text: 'idle' }] })
  const overlay = join(home, 'presets.yml')
  writeFileSync(
    overlay,
    `- insert:
    - id: presets
      name: ${repoRoot}/src/plugins/presets.ts
      config:
        default: standard
        presets:
          - id: standard
            name: Standard
          - id: reader
            name: Reader
            tools: [read_file, list_dir]
            persona: ${PERSONA}
`,
  )
  const child = spawn(
    ...heddleCommand([
      'web', '--host', '127.0.0.1', '--port', '0',
      '--config', join(repoRoot, 'cordis.yml'), '--patch', join(repoRoot, 'heddle.patch.yml'), '--patch', overlay,
      '--endpoint', 'scripted', '--session-root', join(home, 'sessions'),
    ]),
    { cwd: work, env: { ...process.env, NO_COLOR: '1', HEDDLE_HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  const close = () => {
    child.kill('SIGKILL')
    removeDir(home)
    removeDir(work)
  }
  try {
    const url = await new Promise((resolvePromise, reject) => {
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match) resolvePromise(match[1])
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => reject(new Error(`the server exited ${code} before printing a URL\n${output}`)))
      setTimeout(() => reject(new Error(`the server printed no URL within 15s\n${output}`)), 15_000).unref()
    })
    const handshake = await fetch(url, { redirect: 'manual' })
    const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
    if (cookie === undefined) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
    return { home, work, url, script, cookie, close }
  } catch (error) {
    close()
    throw error
  }
}

/** One turn through the page's route: its status, the session it ran in, and the session events it streamed. */
async function turn(server, body, steps) {
  writeFileSync(server.script, JSON.stringify({ steps }))
  const response = await fetch(new URL('/api/turn', server.url), {
    method: 'POST',
    headers: { cookie: server.cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const payloads = text
    .split('\n\n')
    .filter((block) => block.startsWith('event: session\n'))
    .map((block) => JSON.parse(block.slice(block.indexOf('data: ') + 'data: '.length)))
  return { status: response.status, text, session: payloads[0]?.session, events: payloads.map((payload) => payload.event) }
}

async function get(server, path) {
  const response = await fetch(new URL(path, server.url), { headers: { cookie: server.cookie } })
  return { status: response.status, body: await response.json().catch(() => null) }
}

const offeredTools = (events) => events.filter((event) => event.type === 'model/request').map((event) => event.tools)
const systemPrompt = (events) =>
  events.find((event) => event.type === 'context/note' && event.message?.role === 'system')?.message.content[0]?.text

test('a new session under a non-default preset is offered its tools and persona, and keeps that preset', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('roster')
  try {
    const roster = await get(server, '/api/presets')
    assert.equal(roster.status, 200, 'the server lists its presets')
    assert.equal(roster.body.default, 'standard', 'with the registry default')
    assert.deepEqual(roster.body.presets.map((preset) => preset.id), ['standard', 'reader'], 'and every declared preset')

    const reader = await turn(server, { prompt: 'look around', preset: 'reader' }, [{ text: 'looked' }])
    assert.equal(reader.status, 200, `the turn ran\n${reader.text.slice(0, 400)}`)
    assert.deepEqual(offeredTools(reader.events), [['read_file', 'list_dir']], 'the reader session is offered only its tools')
    assert.equal(systemPrompt(reader.events), PERSONA, 'and its system prompt is the preset’s persona')
    assert.equal((await get(server, `/api/sessions/${reader.session}`)).body.preset, 'reader', 'the session records its preset')

    const plain = await turn(server, { prompt: 'hello' }, [{ text: 'hi' }])
    const tools = offeredTools(plain.events)[0] ?? []
    assert.ok(tools.includes('write_file') && tools.includes('bash'), `a default session is offered every tool (${tools.join(', ')})`)
    assert.equal((await get(server, `/api/sessions/${plain.session}`)).body.preset, 'standard', 'and records the default')

    const switched = await turn(server, { prompt: 'widen', session: reader.session, preset: 'standard' }, [{ text: 'no' }])
    assert.equal(switched.status, 409, 'a session keeps the preset it was created with')
    assert.match(switched.text, /session\/preset-fixed/)

    const unknown = await turn(server, { prompt: 'x', preset: 'nope' }, [{ text: 'no' }])
    assert.equal(unknown.status, 400, 'an undeclared preset is refused')
    assert.match(unknown.text, /Unknown agent preset: nope; declared: standard, reader/, 'in DSH’s words')
  } finally {
    server.close()
  }
})

test('a call to a tool outside the session’s preset is answered as an unknown tool and does not run', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('outside')
  try {
    const reader = await turn(
      server,
      { prompt: 'write a file', preset: 'reader' },
      [{ toolCall: { name: 'write_file', arguments: { path: 'notes.txt', content: 'x' } } }, { text: 'done' }],
    )
    assert.equal(reader.status, 200, `the turn ran\n${reader.text.slice(0, 400)}`)
    const result = reader.events.find((event) => event.type === 'message' && event.message?.role === 'tool')
    const text = (result?.message.content ?? []).map((part) => part.text ?? '').join('')
    assert.match(text, /UNKNOWN_TOOL/, `the call is answered as an unknown tool (${text})`)
    assert.match(text, /no tool named 'write_file'; known: read_file, list_dir/, 'naming the tools the preset offers')
    assert.equal(existsSync(join(server.work, 'notes.txt')), false, 'and nothing was written')
  } finally {
    server.close()
  }
})
