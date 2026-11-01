import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// Each test runs a child node process that tracks a folder under a scratch root of its own.
const SCRATCH = join(import.meta.dirname, '..', '..', 'scratch.mjs')
const LIB = join(import.meta.dirname, '..', '..', 'lib.mjs')

function root(t) {
  const dir = mkdtempSync(join(tmpdir(), 'scratch-cleanup-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function child(script) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('a tracked folder is removed when the check throws before its own cleanup', (t) => {
  const dir = join(root(t), 'profile')
  mkdirSync(dir)
  const r = child(`import { trackScratch } from ${JSON.stringify(SCRATCH)}; trackScratch(${JSON.stringify(dir)}); throw new Error('boom')`)
  assert.notEqual(r.status, 0)
  assert.equal(existsSync(dir), false)
})

test('a tracked folder is removed on a normal exit, an untracked one is kept', (t) => {
  const base = root(t)
  const gone = join(base, 'gone')
  const kept = join(base, 'kept')
  mkdirSync(gone)
  mkdirSync(kept)
  const r = child(
    `import { trackScratch, untrackScratch } from ${JSON.stringify(SCRATCH)}; trackScratch(${JSON.stringify(gone)}); trackScratch(${JSON.stringify(kept)}); untrackScratch(${JSON.stringify(kept)})`,
  )
  assert.equal(r.status, 0, r.stderr)
  assert.equal(existsSync(gone), false)
  assert.equal(existsSync(kept), true)
})

test('SIGTERM removes the folder, kills the tracked browser, and the process still ends by the signal', async (t) => {
  const dir = join(root(t), 'profile')
  mkdirSync(dir)
  const script = `import { spawn } from 'node:child_process'
import { trackScratch } from ${JSON.stringify(SCRATCH)}
const browser = spawn('sleep', ['60'], { stdio: 'ignore' })
trackScratch(${JSON.stringify(dir)}, browser)
console.log(browser.pid)
setInterval(() => {}, 1000)`
  const proc = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  const pid = await new Promise((resolve) => proc.stdout.once('data', (d) => resolve(Number(String(d).trim()))))
  const ended = new Promise((resolve) => proc.on('exit', (code, signal) => resolve(signal)))
  proc.kill('SIGTERM')
  assert.equal(await ended, 'SIGTERM')
  assert.equal(existsSync(dir), false)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(alive(pid), false, 'the browser child is gone too')
})

test('tempDir() folders are removed when the check process ends', (t) => {
  const r = child(`import { tempDir } from ${JSON.stringify(LIB)}; console.log(tempDir('heddle-check-scratch-test-'))`)
  assert.equal(r.status, 0, r.stderr)
  const dir = r.stdout.trim()
  assert.match(dir, /heddle-check-scratch-test-/)
  assert.equal(existsSync(dir), false)
})
