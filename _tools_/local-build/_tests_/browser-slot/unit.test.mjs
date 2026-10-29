import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// The wrapper under test. Every test gets its own slot root, so no test sees the Mac's real browser slot.
const SCRIPT = join(import.meta.dirname, '..', '..', 'browser-slot')

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'browser-slot-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function envFor(root, extra = {}) {
  const env = { ...process.env, LOCAL_BUILD_SLOT_ROOT: root, BROWSER_SLOT_POLL_MS: '50', ...extra }
  delete env.HD_SEAT
  return env
}

function bs(root, args, extra) {
  const r = spawnSync(SCRIPT, args, { env: envFor(root, extra), encoding: 'utf8' })
  return { status: r.status, out: r.stdout + r.stderr }
}

const take = (root, seat, wait = '0', extra) => bs(root, ['take', '--seat', seat, '--wait', wait], extra)
const lock = (root) => join(root, 'browser.lock')
const owner = (root) => readFileSync(join(lock(root), 'owner'), 'utf8')
const deadPid = () => spawnSync('true').pid
const minutesAgo = (m) => new Date(Date.now() - m * 60_000)

/** A holder made the way a seat does it by hand, or by an older run of this tool. */
function holder(root, { line = 'developer-nine ui gate 05:00:00', pid, startMinutesAgo = 0 } = {}) {
  mkdirSync(lock(root))
  const start = Math.floor(Date.now() / 1000 - startMinutesAgo * 60)
  const text = pid === undefined ? `${line}\n` : `${line}\nseat=${line.split(' ')[0]}\npid=${pid}\nstart=${start}\n`
  writeFileSync(join(lock(root), 'owner'), text)
  if (startMinutesAgo) utimesSync(join(lock(root), 'owner'), minutesAgo(startMinutesAgo), minutesAgo(startMinutesAgo))
}

test('take on a free slot holds it with an owner the hand-made lock understands', (t) => {
  const root = sandbox(t)
  const r = bs(root, ['take', '--seat', 'developer-one', '--purpose', 'ui gate', '--wait', '0'])
  assert.equal(r.status, 0, r.out)
  const text = owner(root)
  assert.match(text.split('\n')[0], /^developer-one ui gate \d\d:\d\d:\d\d$/, 'the first line keeps the old owner format')
  assert.match(text, /^seat=developer-one$/m)
  assert.match(text, /^pid=\d+$/m)
  assert.match(text, /^start=\d+$/m)
  assert.throws(() => mkdirSync(lock(root)), /EEXIST/, 'a seat taking it by hand is refused while the tool holds it')
})

test('a hand-made lock holds the slot against the tool', (t) => {
  const root = sandbox(t)
  holder(root)
  const r = take(root, 'developer-one')
  assert.equal(r.status, 75, r.out)
  assert.match(r.out, /queued, position 1 of 1; slot held by developer-nine ui gate/)
})

test('a queued seat keeps one ticket across calls and gets the slot after release', (t) => {
  const root = sandbox(t)
  assert.equal(take(root, 'developer-one').status, 0)
  assert.equal(take(root, 'developer-two').status, 75)
  const first = readdirSync(join(root, 'browser.queue'))
  assert.equal(take(root, 'developer-two').status, 75)
  assert.deepEqual(readdirSync(join(root, 'browser.queue')), first, 'the same ticket, so the same place')
  assert.equal(bs(root, ['release', '--seat', 'developer-one']).status, 0)
  assert.equal(take(root, 'developer-two').status, 0)
  assert.deepEqual(readdirSync(join(root, 'browser.queue')), [], 'the ticket is gone once the slot is taken')
})

test('each take refreshes the ticket, so a seat that keeps asking never ages out', (t) => {
  const root = sandbox(t)
  take(root, 'developer-one')
  take(root, 'developer-two')
  const [ticket] = readdirSync(join(root, 'browser.queue'))
  utimesSync(join(root, 'browser.queue', ticket), minutesAgo(4), minutesAgo(4))
  take(root, 'developer-two')
  assert.deepEqual(readdirSync(join(root, 'browser.queue')), [ticket])
  const ageS = (Date.now() - statSync(join(root, 'browser.queue', ticket)).mtimeMs) / 1000
  assert.ok(ageS < 30, `refreshed, ${ageS}s old`)
})

test('the queue is first come, first served', (t) => {
  const root = sandbox(t)
  take(root, 'developer-one')
  take(root, 'developer-two')
  take(root, 'developer-three')
  bs(root, ['release', '--seat', 'developer-one'])
  const late = take(root, 'developer-three')
  assert.equal(late.status, 75, 'a later ticket waits even when it asks first')
  assert.match(late.out, /position 2 of 2/)
  assert.equal(take(root, 'developer-two').status, 0)
})

test('browser.next puts a queued seat first and is used up when it takes the slot', (t) => {
  const root = sandbox(t)
  take(root, 'developer-one')
  take(root, 'developer-two')
  take(root, 'developer-five')
  writeFileSync(join(root, 'browser.next'), 'developer-five 06:04:02 R-12 (coordinator)\n')
  bs(root, ['release', '--seat', 'developer-one'])
  assert.equal(take(root, 'developer-two').status, 75)
  assert.equal(take(root, 'developer-five').status, 0)
  assert.equal(existsSync(join(root, 'browser.next')), false)
})

test('browser.next for a seat that is not queued does not hold the others back, and an old one is ignored', (t) => {
  const root = sandbox(t)
  writeFileSync(join(root, 'browser.next'), 'developer-five 06:04:02 (coordinator)\n')
  assert.equal(take(root, 'developer-two').status, 0)
  assert.equal(existsSync(join(root, 'browser.next')), true, 'kept for developer-five')
  take(root, 'developer-three')
  take(root, 'developer-five')
  utimesSync(join(root, 'browser.next'), minutesAgo(31), minutesAgo(31))
  bs(root, ['release', '--seat', 'developer-two'])
  assert.equal(take(root, 'developer-five').status, 75, 'a 31-minute-old browser.next no longer counts')
  assert.equal(take(root, 'developer-three').status, 0)
})

test('a holder older than 15 minutes whose pid is gone is cleared; a live or young one is not', (t) => {
  const root = sandbox(t)
  holder(root, { pid: process.pid, startMinutesAgo: 20 })
  assert.equal(take(root, 'developer-one').status, 75, 'old but alive')
  rmSync(lock(root), { recursive: true })
  holder(root, { pid: deadPid(), startMinutesAgo: 5 })
  assert.equal(take(root, 'developer-one').status, 75, 'gone but young')
  rmSync(lock(root), { recursive: true })
  holder(root, { pid: deadPid(), startMinutesAgo: 16 })
  const r = take(root, 'developer-one')
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /cleared a stale holder: developer-nine ui gate 05:00:00 \(age 16m\d\ds, pid \d+ gone\)/)
  assert.match(owner(root), /^seat=developer-one$/m)
})

test('a hand-made lock with no pid is cleared once it is older than 15 minutes', (t) => {
  const root = sandbox(t)
  holder(root, { startMinutesAgo: 20 })
  const r = take(root, 'developer-one')
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /no pid recorded/)
})

test('only the holder releases, unless forced', (t) => {
  const root = sandbox(t)
  take(root, 'developer-one')
  const refused = bs(root, ['release', '--seat', 'developer-two'])
  assert.equal(refused.status, 1)
  assert.match(refused.out, /refused, the slot is held by developer-one/)
  assert.equal(existsSync(lock(root)), true)
  assert.equal(bs(root, ['release', '--seat', 'developer-two', '--force']).status, 0)
  assert.equal(existsSync(lock(root)), false)
})

test('a ticket nobody refreshes is dropped and does not block the queue', (t) => {
  const root = sandbox(t)
  take(root, 'developer-one')
  take(root, 'developer-two')
  take(root, 'developer-three')
  const [ticket] = readdirSync(join(root, 'browser.queue')).filter((n) => n.endsWith('-developer-two'))
  utimesSync(join(root, 'browser.queue', ticket), minutesAgo(6), minutesAgo(6))
  bs(root, ['release', '--seat', 'developer-one'])
  assert.equal(take(root, 'developer-three').status, 0, 'developer-two gave up five minutes ago')
})

test('run holds the slot for the command, returns its status and always releases', (t) => {
  const root = sandbox(t)
  const check = `grep -q '^seat=developer-one$' "${join(lock(root), 'owner')}" && exit 3`
  const r = bs(root, ['run', '--seat', 'developer-one', '--wait', '0', '--', 'sh', '-c', check])
  assert.equal(r.status, 3, r.out)
  assert.equal(existsSync(lock(root)), false)
})

test('two seats racing for a free slot: exactly one gets it', async (t) => {
  const root = sandbox(t)
  const race = (seat) =>
    new Promise((resolve) => {
      const child = spawn(SCRIPT, ['take', '--seat', seat, '--wait', '1'], { env: envFor(root) })
      child.on('exit', resolve)
    })
  const codes = await Promise.all([race('developer-one'), race('developer-two')])
  assert.deepEqual(codes.sort(), [0, 75])
})

test('status names the holder, browser.next and the queue in serving order', (t) => {
  const root = sandbox(t)
  holder(root, { pid: deadPid(), startMinutesAgo: 16 })
  take(root, 'developer-two', '0', { BROWSER_SLOT_STALE_SECONDS: '100000' })
  take(root, 'developer-five', '0', { BROWSER_SLOT_STALE_SECONDS: '100000' })
  writeFileSync(join(root, 'browser.next'), 'developer-five (coordinator)\n')
  const r = bs(root, ['status'])
  assert.equal(r.status, 0)
  assert.match(r.out, /holder {2}developer-nine ui gate 05:00:00 {2}\(16m\d\ds, pid \d+ gone; over 10 minutes; stale, cleared on the next take\)/)
  assert.match(r.out, /next {4}developer-five \(browser\.next\)/)
  assert.match(r.out, /queue {3}1\. developer-five .*\n {8}2\. developer-two/)
  assert.equal(existsSync(lock(root)), true, 'status never clears anything')
})
