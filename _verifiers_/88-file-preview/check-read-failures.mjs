/*
---
title: File preview read failures over the delivered CLI
version: 1.0.0
description: Offline HTTP-only proof of named text-read failures and unchanged access fences.
grounded_in:
  - source: owner policy for issue 45 and issue 106 unreadable status
---
*/
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/**
 * No browser, source imports, build, cargo, model calls or live daemon reuse.
 * Caller builds/pins the product first. HEDDLE_BIN selects its actual Rust CLI;
 * otherwise spawn delivered TypeScript dist/cli.js, never an in-process double.
 * Readable mode 000 skips ONLY the permission subtest (unjudged, not pass).
 * Use verify.sh's shared runner for 0/1/3; node --test alone exits 0 for skips.
 * Only this run's named nested file changes mode, restored before scoped cleanup.
 */
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const REQUEST_MS = 4_000
const STARTUP_MS = 20_000
const MAX_BODY = 256 * 1024

async function request(url, options, signal) {
  // One deadline covers headers AND body consumption, not just fetch().
  const response = await fetch(url, {
    ...options, redirect: 'manual',
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]),
  })
  const chunks = []
  let bytes = 0
  if (response.body) {
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > MAX_BODY) {
          await reader.cancel()
          throw new Error('HTTP response exceeded the verifier body bound')
        }
        chunks.push(Buffer.from(value))
      }
    } finally { reader.releaseLock() }
  }
  return { status: response.status, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    child.stdout.destroy()
    child.stderr.destroy()
    return
  }
  let exited = false
  const onExit = () => { exited = true }
  child.once('exit', onExit)
  const wait = (ms) => new Promise((done) => {
    if (exited) return done(true)
    const finish = () => { clearTimeout(timer); child.removeListener('exit', finish); done(true) }
    const timer = setTimeout(() => { child.removeListener('exit', finish); done(exited) }, ms)
    child.once('exit', finish)
  })
  try {
    child.kill('SIGTERM')
    if (!await wait(2_000)) {
      child.kill('SIGKILL')
      assert.equal(await wait(2_000), true, 'owned HTTP CLI must exit before fixture removal')
    }
  } finally {
    child.removeListener('exit', onExit)
    child.stdout.destroy()
    child.stderr.destroy()
  }
}

async function startServer(home, config, signal) {
  const args = ['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')]
  const command = process.env.HEDDLE_BIN || process.execPath
  const argv = process.env.HEDDLE_BIN ? args : [join(repoRoot, 'dist', 'cli.js'), ...args]
  const child = spawn(command, argv, {
    cwd: repoRoot,
    env: { ...process.env, HEDDLE_HOME: home, HEDDLE_CONFIG: config, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let childError
  child.on('error', (error) => { childError = error })
  let output = ''
  const capture = (data) => { output = (output + data.toString()).slice(-32_768) }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  try {
    const url = await new Promise((done, fail) => {
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.stdout.removeListener('data', onData)
        child.stderr.removeListener('data', onData)
        child.removeListener('error', onError)
        child.removeListener('exit', onExit)
        signal.removeEventListener('abort', onAbort)
        if (error) fail(error)
        else done(value)
      }
      const onData = () => {
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (!match) return
        try {
          const address = new URL(match[1])
          assert.equal(address.hostname, '127.0.0.1', 'private loopback only')
          assert.ok(Number(address.port) > 0, 'CLI reports its allocated port, not zero')
          finish(null, address.href)
        } catch (error) { finish(error) }
      }
      const onError = (error) => finish(error)
      const onExit = (code, sig) => finish(new Error(`HTTP CLI exited during startup (${code ?? sig})\n${output}`))
      const onAbort = () => finish(signal.reason ?? new Error('test aborted during startup'))
      const timer = setTimeout(() => finish(new Error(`HTTP CLI startup timed out\n${output}`)), STARTUP_MS)
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.once('error', onError)
      child.once('exit', onExit)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
      else if (childError) onError(childError)
      else if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode)
    })
    return { child, url }
  } catch (error) {
    try { await stopServer(child) } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'startup and owned CLI shutdown failed')
    }
    throw error
  }
}

function namedFailure(answer, status, expected, forbiddenPaths) {
  assert.equal(answer.status, status, answer.body)
  assert.match(answer.headers.get('content-type') ?? '', /^application\/json(?:;|$)/)
  assert.equal(answer.headers.get('cache-control'), 'no-store')
  assert.deepEqual(JSON.parse(answer.body), expected)
  for (const path of forbiddenPaths) assert.equal(answer.body.includes(path), false, 'no parent path in read failure')
  assert.doesNotMatch(answer.body, /EACCES|EPERM|ELOOP|errno|syscall|realpath|Error:|\bat (?:Object|async)\b/)
}

test('delivered CLI text preview names real read failures and preserves access fences', { timeout: 90_000 }, async (t) => {
  // Initialize shared root first, then realpath it so macOS aliases cannot turn
  // ELOOP's lexical fallback into an apparently outside-workspace path.
  const sharedRoot = join(repoRoot, '.heddle-tmp')
  mkdirSync(sharedRoot, { recursive: true })
  const canonicalRoot = realpathSync.native(sharedRoot)
  const scratch = mkdtempSync(join(canonicalRoot, 'file-preview-read-failures-'))
  let server
  let denied
  let originalMode
  try {
    const home = join(scratch, 'private-home')
    const workspace = join(scratch, 'read-failure-workspace')
    const nested = join(workspace, 'named-private-folder', 'nested-folder')
    mkdirSync(home, { mode: 0o700 })
    mkdirSync(nested, { recursive: true })
    denied = join(nested, 'denied.txt')
    const text = 'owned permission fixture — restored and readable\n'
    writeFileSync(denied, text, { mode: 0o600 })
    originalMode = statSync(denied).mode & 0o777
    const binary = join(workspace, 'binary.bin')
    const invalid = join(workspace, 'invalid.txt')
    const readable = join(workspace, 'readable.txt')
    const outside = join(scratch, 'outside.txt')
    const escape = join(workspace, 'outside-link.txt')
    const loop = join(workspace, 'loop.txt')
    writeFileSync(binary, Buffer.from([0, 1]))
    writeFileSync(invalid, Buffer.from([0xff]))
    writeFileSync(readable, 'readable control\n')
    writeFileSync(outside, 'outside control\n')
    symlinkSync(outside, escape)
    symlinkSync('loop.txt', loop)
    const script = join(home, 'script.json')
    const config = join(home, 'heddle.json')
    writeFileSync(script, JSON.stringify({ steps: [{ text: 'offline fixture' }] }))
    writeFileSync(config, JSON.stringify({ default: 'scripted', endpoints: [
      { name: 'scripted', kind: 'scripted', baseUrl: script, model: 'scripted' },
    ] }))
    server = await startServer(home, config, t.signal)
    const handshake = await request(server.url, {}, t.signal)
    assert.equal(handshake.status, 303, 'authenticate through CLI-issued token URL')
    const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie, 'token handshake must issue a session cookie')
    const origin = new URL(server.url).origin
    const call = (path, authorized = true) => request(
      `${origin}/api/file?path=${encodeURIComponent(path)}`,
      { headers: authorized ? { cookie } : {} }, t.signal,
    )
    const registered = await request(`${origin}/api/workspaces`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: workspace, name: 'read-failure-fixture' }),
    }, t.signal)
    assert.equal(registered.status, 200, registered.body)

    await t.test('actual mode-000 denial is HTTP 400 with basename-only unreadable body', async (permission) => {
      chmodSync(denied, 0)
      try {
        let osError
        try { readFileSync(denied) } catch (error) { osError = error }
        if (!osError) {
          permission.skip('OS can read mode 000 (including root); permission denial is unjudged, not passing')
          return
        }
        assert.ok(['EACCES', 'EPERM'].includes(osError.code), 'owned file must really be permission denied')
        assert.equal((await call(denied, false)).status, 401, 'authentication precedes denied read')
        namedFailure(await call(denied), 400, {
          error: 'cannot read "denied.txt": permission denied', code: 'workspace-file/unreadable',
        }, [repoRoot, canonicalRoot, scratch, workspace, nested, 'named-private-folder', 'nested-folder'])
      } finally { chmodSync(denied, originalMode) }
    })

    // Verified source wiring in BOTH real servers, not inferred from reader tests:
    // TS src/paths.ts + workspace owner keep lexical ELOOP path;
    // src/session/tree.ts statSync -> read-failed -> src/server/web.ts /api/file 500.
    // Rust heddle-web-files routes.rs canonical_path + PageHost::workspace_owner
    // use same fallback; PageHost::read_file_text maps actual workspace reader's
    // metadata ELOOP -> ReadFailed -> file_read_error 500.
    assert.throws(() => statSync(loop), { code: 'ELOOP' }, 'host really produces symlink-loop I/O failure')
    namedFailure(await call(loop), 500, {
      error: 'cannot read file: I/O error', code: 'workspace-file/read-failed',
    }, [repoRoot, canonicalRoot, scratch, workspace, 'loop.txt'])
    assert.equal((await call(loop, false)).status, 401)
    for (const path of [workspace, nested, join(workspace, 'missing.txt')]) {
      assert.equal((await call(path)).status, 404, 'missing and nonregular files remain 404')
    }
    for (const path of [binary, invalid]) assert.equal((await call(path)).status, 415, 'nontext remains 415')
    for (const path of [outside, escape]) assert.equal((await call(path)).status, 400, 'canonical ownership refuses outside paths')
    assert.equal((await call(readable, false)).status, 401)
    const recovery = await call(denied)
    assert.equal(recovery.status, 200, recovery.body)
    assert.equal(JSON.parse(recovery.body).text, text, 'restoring mode recovers same HTTP preview')
    const control = await call(readable)
    assert.equal(control.status, 200, control.body)
    assert.equal(JSON.parse(control.body).text, 'readable control\n')
  } finally {
    // Restore first even if startup/request/assertion failed. Never chmod a folder.
    try {
      if (denied && originalMode !== undefined) chmodSync(denied, originalMode)
    } finally {
      if (server) await stopServer(server.child)
    }
    // Verify resolved absolute deletion target, not a parent/shared directory.
    assert.equal(dirname(scratch), canonicalRoot)
    assert.ok(scratch.startsWith(`${canonicalRoot}${sep}file-preview-read-failures-`))
    assert.equal(realpathSync.native(scratch), scratch)
    rmSync(scratch, { recursive: true, force: true })
  }
})
