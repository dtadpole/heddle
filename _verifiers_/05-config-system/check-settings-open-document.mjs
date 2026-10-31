// Open configuration file (A95, DSH's settings/openSettingsDocument): POST /api/settings {"open": "document"} opens the
// profile's patch in the person's text editor, creating it empty when absent. It is pathless (the server resolves the
// file), offered only to a page on this machine, and refused for a run without a profile patch. HEDDLE_OPEN_COMMAND
// names a recorder here instead of an editor. Runs against whichever harness HEDDLE_BIN names, or the TypeScript build.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { heddleCommand, isolatedHome, removeDir, repoRoot } from '../../_tools_/verify-runner/lib.mjs'

function scratchProfile(home) {
  const profile = join(home, 'open-document-profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`)
  writeFileSync(join(profile, 'heddle.patch.yml'), tree)
  return profile
}

function startServer(args, env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(['web', '--port', '0', ...args]), {
        cwd: env.HOME,
        env: { ...process.env, NO_COLOR: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /(http:\/\/127\.0\.0\.1:\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ base: match[1], token: match[2], kill: () => child.kill('SIGKILL'), output: () => output })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => {
        if (!settled) {
          settled = true
          reject(new Error(`the server exited ${code} before printing a URL\n${output}`))
        }
      })
      setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill('SIGKILL')
          reject(new Error(`the server printed no URL within 20s\n${output}`))
        }
      }, 20_000).unref()
    })()
  })
}

async function call(server, method, path, body) {
  const response = await fetch(`${server.base}${path}?token=${server.token}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let parsed = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: response.status, body: parsed }
}


/** A program that records the path it is asked to open, standing in for the editor. */
function recorder(home) {
  const script = join(home, 'open-recorder.sh')
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${join(home, 'opened.txt')}"\n`)
  chmodSync(script, 0o755)
  return { script, opened: () => (existsSync(join(home, 'opened.txt')) ? readFileSync(join(home, 'opened.txt'), 'utf8').split('\n').filter(Boolean) : []) }
}

/** A raw request with a chosen Host header, which fetch does not let a caller set. */
function rawPost(server, path, body, host) {
  return new Promise((resolvePromise, reject) => {
    const url = new URL(`${server.base}${path}?token=${server.token}`)
    const outgoing = httpRequest(
      { hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: 'POST', headers: { host, 'content-type': 'application/json' } },
      (incoming) => {
        let text = ''
        incoming.on('data', (chunk) => (text += chunk))
        incoming.on('end', () => resolvePromise({ status: incoming.statusCode ?? 0, text }))
      },
    )
    outgoing.on('error', reject)
    outgoing.end(JSON.stringify(body))
  })
}

async function waitFor(predicate, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (predicate()) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  return predicate()
}

test('Open configuration file opens the profile patch for a page on this machine, creating it, and refuses otherwise', async () => {
  const home = isolatedHome('settings-open-document')
  const { script, opened } = recorder(home)
  let server
  try {
    const profile = scratchProfile(home)
    const patch = join(profile, 'heddle.patch.yml')
    server = await startServer(['--profile', profile, '--sandbox-root', home], { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_OPEN_COMMAND: script })

    const view = await call(server, 'GET', '/api/settings')
    assert.equal(view.body.writable, true, 'the run has a profile patch to open')

    const local = await call(server, 'POST', '/api/settings', { open: 'document' })
    assert.equal(local.status, 200, `a page on this machine opens it\n${JSON.stringify(local.body)}`)
    assert.deepEqual(local.body, { opened: true })
    assert.ok(await waitFor(() => opened().length === 1, 5_000), 'the opener was started')
    assert.equal(opened()[0], patch, 'with the profile patch, which the server resolved')

    const other = await rawPost(server, '/api/settings', { open: 'document' }, 'heddle.example.com')
    assert.ok(other.status === 403, `a page on another host is refused (${other.status} ${other.text.slice(0, 200)})`)
    const wrong = await call(server, 'POST', '/api/settings', { open: 'folder' })
    assert.equal(wrong.status, 400, 'only the document opens')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
    assert.equal(opened().length, 1, 'neither refusal started the opener')
  } finally {
    server?.kill()
    removeDir(home)
  }
})

test('an absent profile patch is created empty before it opens', async () => {
  const home = isolatedHome('settings-open-absent')
  const { script, opened } = recorder(home)
  let server
  try {
    const profile = join(home, '.heddle', 'profiles', 'fresh')
    mkdirSync(profile, { recursive: true })
    // The whole tree in the profile's cordis.yml, and no heddle.patch.yml beside it yet.
    writeFileSync(join(profile, 'cordis.yml'), readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`))
    const patch = join(profile, 'heddle.patch.yml')
    server = await startServer(['--profile', 'fresh', '--sandbox-root', home], { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_OPEN_COMMAND: script })
    assert.equal(existsSync(patch), false, 'the profile has no patch yet')
    const answer = await call(server, 'POST', '/api/settings', { open: 'document' })
    assert.equal(answer.status, 200, JSON.stringify(answer.body))
    assert.ok(await waitFor(() => opened().length === 1, 5_000), 'the opener was started')
    assert.equal(opened()[0], patch)
    assert.equal(readFileSync(patch, 'utf8'), '', 'the patch now exists, empty, so it changes nothing')
  } finally {
    server?.kill()
    removeDir(home)
  }
})
