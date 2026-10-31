#!/usr/bin/env node
// A fair first-in-first-out queue for the team's one browser slot.
//
//   _tools_/local-build/browser-slot take --seat <key> [--purpose <text>] [--wait <seconds>]
//   _tools_/local-build/browser-slot release --seat <key> [--force]
//   _tools_/local-build/browser-slot run --seat <key> [--purpose <text>] [--wait <seconds>] -- <command...>
//   _tools_/local-build/browser-slot status
//
// Slot 1 is still the mkdir directory $ROOT/browser.lock (slot n is browser.lock<n>) with an `owner` file
// inside, so a seat that takes it by hand (mkdir) and this tool exclude each other. $ROOT/browser-cap holds
// "<count> [reserve=<role>]" (default 1); with a reservation the last slot serves only that role, and the
// others serve every seat, that role included. No new holder is admitted while memory is short (D-060). Waiting seats hold one ticket each in
// $ROOT/browser.queue; a ticket keeps its place across calls, so a seat whose tool calls are bounded to
// two minutes calls `take` again until it gets the slot. $ROOT/browser.next (written by the coordinator)
// puts its seat first while that seat is queued, and is consumed when that seat takes the slot.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const env = process.env
const number = (name, fallback) => {
  const value = Number(env[name])
  return env[name] !== undefined && env[name] !== '' && Number.isFinite(value) ? value : fallback
}

export const ROOT = env.LOCAL_BUILD_SLOT_ROOT || path.join(os.homedir(), '.hd-build-slots')
const CAP_FILE = path.join(ROOT, 'browser-cap')
const NEXT = path.join(ROOT, 'browser.next')
const QUEUE = path.join(ROOT, 'browser.queue')
const STALE_HOLDER_S = number('BROWSER_SLOT_STALE_SECONDS', 900) // a holder older than this whose pid is gone is cleared
const TICKET_STALE_S = number('BROWSER_SLOT_TICKET_SECONDS', 300) // a ticket not refreshed for this long is dropped
const NEXT_STALE_S = number('BROWSER_SLOT_NEXT_SECONDS', 1800) // an older browser.next is ignored
const POLL_MS = number('BROWSER_SLOT_POLL_MS', 1000)
const MAX_HOLD_S = 600 // the team's rule: hold the slot at most ten minutes
const QUEUED = 75 // EX_TEMPFAIL: still waiting, the ticket is kept
const STALE_COPY = 78 // EX_CONFIG: this copy is older than one already in use
export const VERSION = 5 // bump on every change to the queue's rules; older copies then refuse
const VERSION_FILE = path.join(ROOT, 'browser-slot.version')
// A free slot the first waiter has not taken for this long may go to the next waiter whose gate passes.
const HEAD_GRACE_S = number('BROWSER_SLOT_HEAD_GRACE_SECONDS', 60)
const freeSince = (n) => path.join(ROOT, `browser.free-since${n}`)
// D-064: a new holder needs memory_pressure free >= 25% and disk free >= 20 GiB on the volume of the slot folder.
// Swap is no gate (macOS keeps stale pages there and grows it on demand); browser-cap's old swap keys are ignored.
// browser-cap may move the lines ("min-free=25 disk-min=20"); the environment overrides both (tests).
const MIN_FREE_PCT = 25
const MIN_DISK_GB = 20

export const lockDir = (n) => path.join(ROOT, n === 1 ? 'browser.lock' : `browser.lock${n}`)

/** The slot count and the reserved role from browser-cap ("2 reserve=integrator"); a reservation needs 2 slots. */
export function config() {
  let text = ''
  try {
    text = fs.readFileSync(CAP_FILE, 'utf8')
  } catch {}
  const count = Math.max(1, Math.floor(Number(text.trim().split(/\s+/)[0])) || 1)
  const reserve = (text.match(/reserve=([a-z0-9-]+)/) || [])[1] || null
  const key = (name, fallback) => Number((text.match(new RegExp(`${name}=(\\d+)`)) || [])[1]) || fallback
  const minFree = number('BROWSER_SLOT_MIN_FREE_PCT', key('min-free', MIN_FREE_PCT))
  const minDisk = number('BROWSER_SLOT_MIN_DISK_GB', key('disk-min', MIN_DISK_GB))
  return { count, reserve: count >= 2 ? reserve : null, minFree, minDisk }
}

export const roleOf = (seat, role) => role || (seat.startsWith('integrator-') ? 'integrator' : 'developer')

/**
 * With a reservation the last slot serves only the reserved role; every other slot serves every seat, the reserved
 * role included. A reservation is a slot an integrator never waits behind a developer for, not a fence that keeps an
 * integrator off a free shared slot (measured 2026-10-30 23:47: integrator-one waited for browser.lock4 while
 * slots 2 and 3 were free).
 */
export function eligible(n, role, cfg) {
  if (!cfg.reserve) return true
  return n === cfg.count ? role === cfg.reserve : true
}

/** Slots to look at: the configured ones plus any held beyond a lowered cap. */
function slotNumbers(cfg) {
  const extra = []
  try {
    for (const name of fs.readdirSync(ROOT)) {
      const m = name.match(/^browser\.lock(\d+)$/)
      if (m && Number(m[1]) > cfg.count) extra.push(Number(m[1]))
    }
  } catch {}
  return [...Array.from({ length: cfg.count }, (_, i) => i + 1), ...extra.sort((a, b) => a - b)]
}

/** D-064: no new holder while memory_pressure reports under 25% free, or the slot folder's volume has under 20 GiB. */
export function memoryGate(cfg = config()) {
  const fake = (name) => (env[name] !== undefined && env[name] !== '' ? Number(env[name]) : undefined)
  let free = fake('BROWSER_SLOT_FAKE_FREE_PCT')
  if (free === undefined) {
    const m = (spawnSync('memory_pressure', [], { encoding: 'utf8' }).stdout || '').match(/free percentage:\s*(\d+)%/)
    free = m ? Number(m[1]) : null
  }
  let disk = fake('BROWSER_SLOT_FAKE_DISK_GB')
  if (disk === undefined) {
    // df -k: the last line's fourth field is the available KiB of the volume holding the slot folder
    const lines = (spawnSync('df', ['-k', fs.existsSync(ROOT) ? ROOT : os.homedir()], { encoding: 'utf8' }).stdout || '').trim().split('\n')
    const kb = Number((lines.at(-1) || '').split(/\s+/)[3])
    disk = lines.length > 1 && Number.isFinite(kb) ? kb / 1024 / 1024 : null
  }
  const reading = `memory free ${free ?? '?'}%, disk ${disk === null ? '?' : disk.toFixed(1)} GiB free`
  if (free !== null && free < cfg.minFree) return { ok: false, reading, why: `memory free ${free}% < ${cfg.minFree}% (D-064)` }
  if (disk !== null && disk < cfg.minDisk)
    return { ok: false, reading, why: `disk free ${disk.toFixed(1)} GiB < ${cfg.minDisk} GiB (D-064)` }
  return { ok: true, reading, why: '' }
}

const nowS = () => Date.now() / 1000
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const clock = (date = new Date()) => date.toTimeString().slice(0, 8)
const age = (s) => (s >= 60 ? `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}s` : `${Math.floor(s)}s`)

export function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** The holder of the slot, or null when it is free. Hand-made locks have a one-line owner and no pid. */
export function readHolder(n = 1) {
  const dir = lockDir(n)
  const ownerFile = path.join(dir, 'owner')
  let dirStat
  try {
    dirStat = fs.statSync(dir)
  } catch {
    return null
  }
  let text = ''
  let started = dirStat.mtimeMs / 1000
  try {
    text = fs.readFileSync(ownerFile, 'utf8')
    started = fs.statSync(ownerFile).mtimeMs / 1000
  } catch {}
  const field = (name) => (text.match(new RegExp(`^${name}=(.*)$`, 'm')) || [])[1]
  const line = text.split('\n')[0].trim()
  const start = Number(field('start')) || started
  const pid = Number(field('pid')) || null
  return { n, seat: field('seat') || line.split(/\s+/)[0] || '?', line: line || '(no owner file)', pid, start, ageS: nowS() - start }
}

function isStale(holder) {
  return holder.ageS > STALE_HOLDER_S && !alive(holder.pid)
}

/** Clear a holder older than the stale bound whose pid is gone (or never recorded). Rename first: atomic. */
export function clearStale(n = 1, log = (msg) => process.stderr.write(`${msg}\n`)) {
  const holder = readHolder(n)
  if (!holder || !isStale(holder)) return false
  const aside = `${lockDir(n)}.stale-${Date.now()}-${process.pid}`
  try {
    fs.renameSync(lockDir(n), aside)
  } catch {
    return false // another caller cleared it first
  }
  fs.rmSync(aside, { recursive: true, force: true })
  const why = holder.pid ? `pid ${holder.pid} gone` : 'no pid recorded'
  log(`browser-slot: cleared a stale holder: ${holder.line} (age ${age(holder.ageS)}, ${why})`)
  return true
}

/** Waiting tickets, oldest first, one per seat. Stale tickets are dropped (or only marked, when not pruning). */
export function listTickets({ prune = true } = {}) {
  let names = []
  try {
    names = fs.readdirSync(QUEUE)
  } catch {
    return []
  }
  const seen = new Set()
  const tickets = []
  for (const name of names.sort()) {
    const m = name.match(/^(\d{13})-([a-z0-9][a-z0-9-]*)$/)
    if (!m) continue
    const file = path.join(QUEUE, name)
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    const stale = nowS() - stat.mtimeMs / 1000 > TICKET_STALE_S
    if ((stale || seen.has(m[2])) && prune) {
      fs.rmSync(file, { force: true })
      continue
    }
    seen.add(m[2])
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {}
    const field = (k) => (text.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] || null
    tickets.push({ name, file, seat: m[2], role: roleOf(m[2], field('role')), queuedS: Number(m[1]) / 1000, stale,
      verdict: field('verdict'), checkedS: Number(field('checked')) || null })
  }
  return tickets
}

/** The seat browser.next names, while it is younger than its bound. */
export function nextSeat() {
  try {
    if (nowS() - fs.statSync(NEXT).mtimeMs / 1000 > NEXT_STALE_S) return null
    return fs.readFileSync(NEXT, 'utf8').trim().split(/\s+/)[0] || null
  } catch {
    return null
  }
}

/** The queue in serving order: browser.next's seat first while it is queued, then first come first served. */
export function servingOrder(tickets) {
  const priority = nextSeat()
  const first = tickets.find((t) => t.seat === priority)
  return first ? [first, ...tickets.filter((t) => t !== first)] : tickets
}

function ensureTicket(seat, purpose, role) {
  fs.mkdirSync(QUEUE, { recursive: true })
  const mine = listTickets().find((t) => t.seat === seat)
  if (mine) {
    const now = new Date()
    fs.utimesSync(mine.file, now, now) // refresh this seat's ticket only: still waiting
    return mine
  }
  const name = `${String(Date.now()).padStart(13, '0')}-${seat}`
  fs.writeFileSync(path.join(QUEUE, name), `seat=${seat}\nrole=${role}\npurpose=${purpose}\nqueued=${clock()}\n`)
  return listTickets().find((t) => t.seat === seat)
}

/** Record why this seat did not take a slot on its last call; status shows it. Also refreshes the ticket. */
function noteVerdict(seat, verdict) {
  const mine = listTickets().find((t) => t.seat === seat)
  if (!mine) return
  const text = fs.readFileSync(mine.file, 'utf8').replace(/^(verdict|checked)=.*\n/gm, '')
  fs.writeFileSync(mine.file, `${text}verdict=${verdict.replace(/\n/g, ' ')}\nchecked=${Math.floor(nowS())}\n`)
}

function dropTicket(seat) {
  for (const t of listTickets({ prune: false })) if (t.seat === seat) fs.rmSync(t.file, { force: true })
}

function tryTake(n, seat, purpose, pid) {
  const dir = lockDir(n)
  try {
    fs.mkdirSync(dir)
  } catch {
    return false // held, by this tool or by hand
  }
  const tmp = path.join(dir, `.owner-${process.pid}`)
  fs.writeFileSync(tmp, `${seat} ${purpose} ${clock()}\nseat=${seat}\npid=${pid}\nstart=${Math.floor(nowS())}\n`)
  fs.renameSync(tmp, path.join(dir, 'owner'))
  return true
}

/** Null when this copy is current; otherwise the message telling the seat to sync. Records a newer version. */
export function staleCopy() {
  let recorded = 0
  try {
    recorded = Number(fs.readFileSync(VERSION_FILE, 'utf8').trim()) || 0
  } catch {}
  if (recorded > VERSION)
    return `browser-slot: this copy is version ${VERSION}, but version ${recorded} is in use. Sync it from heddle main ` +
      '(git fetch && git checkout origin/main -- _tools_/local-build) and run take again; your ticket keeps no place meanwhile.'
  if (recorded < VERSION) {
    try {
      fs.mkdirSync(ROOT, { recursive: true })
      fs.writeFileSync(VERSION_FILE, `${VERSION}\n`)
    } catch {}
  }
  return null
}

function age_of(file) {
  try {
    return nowS() - fs.statSync(file).mtimeMs / 1000
  } catch {
    return null
  }
}

/** Queue for a slot and wait up to waitS seconds. 0 when held, QUEUED when still waiting (ticket kept). */
export function take({ seat, role, purpose = 'browser gate', waitS = 100, pid = process.ppid, out = console.log }) {
  role = roleOf(seat, role)
  const stale = staleCopy()
  if (stale) {
    out(stale)
    return STALE_COPY
  }
  const deadline = Date.now() + waitS * 1000
  for (;;) {
    const cfg = config()
    const slots = slotNumbers(cfg)
    slots.forEach((n) => clearStale(n))
    const holders = new Map(slots.map((n) => [n, readHolder(n)]))
    const mine = [...holders.values()].find((h) => h && h.seat === seat)
    if (mine) {
      dropTicket(seat)
      out(`browser-slot: ${seat} already holds slot ${mine.n} (${age(mine.ageS)})`)
      return 0
    }
    ensureTicket(seat, purpose, role)
    const order = servingOrder(listTickets())
    for (const n of slots) if (holders.get(n)) fs.rmSync(freeSince(n), { force: true }) // held again: a new free period
    let held = ''
    const open = slots.filter((k) => k <= cfg.count && !holders.get(k) && eligible(k, role, cfg))
    // The reserved role tries its own slot first, so a shared slot stays with the others while that one is free.
    if (cfg.reserve && role === cfg.reserve) open.sort((a, b) => (b === cfg.count) - (a === cfg.count))
    for (const n of open) {
      if (!fs.existsSync(freeSince(n))) fs.writeFileSync(freeSince(n), `${clock()}\n`)
      const head = order.find((t) => eligible(n, t.role, cfg))
      const freeFor = age_of(freeSince(n)) ?? 0
      // The head goes first; once the slot has been free past the grace, the next waiter may take it instead.
      if (head?.seat !== seat && freeFor < HEAD_GRACE_S) {
        held = `slot ${n} free, ${head?.seat} is first (${Math.ceil(HEAD_GRACE_S - freeFor)}s before the next may take it)`
        continue
      }
      const gate = memoryGate(cfg)
      if (!gate.ok) {
        held = `no new holder: ${gate.why}`
        break
      }
      if (tryTake(n, seat, purpose, pid)) {
        dropTicket(seat)
        fs.rmSync(freeSince(n), { force: true })
        if (head?.seat !== seat) out(`browser-slot: ${head?.seat} did not take slot ${n} within ${HEAD_GRACE_S}s; it keeps first place`)
        if (nextSeat() === seat) fs.rmSync(NEXT, { force: true }) // the priority turn is used
        out(`browser-slot: ${seat} took slot ${n} (${path.basename(lockDir(n))}) at ${clock()}; release it within ${MAX_HOLD_S / 60} minutes`)
        return 0
      }
    }
    const busyNow = slots
      .filter((k) => k <= cfg.count && eligible(k, role, cfg) && holders.get(k))
      .map((k) => `slot ${k} held by ${holders.get(k).seat}`)
    noteVerdict(seat, held || busyNow.join('; ') || 'waiting')
    if (Date.now() >= deadline) {
      // The reserved role counts only its own role ahead (its slot serves no one else); every other seat counts
      // every earlier waiter, since the reserved role takes shared slots too.
      const mineClass = order.filter((t) => !cfg.reserve || role !== cfg.reserve || t.role === cfg.reserve)
      const position = mineClass.findIndex((t) => t.seat === seat) + 1
      const busy = slots
        .filter((k) => k <= cfg.count && eligible(k, role, cfg))
        .map((k) => (holders.get(k) ? `slot ${k} held by ${holders.get(k).line} (${age(holders.get(k).ageS)})` : `slot ${k} free`))
      out(`browser-slot: ${seat} is queued, position ${position} of ${mineClass.length}; ${held || busy.join('; ')}. Run take again to keep the place.`)
      return QUEUED
    }
    sleep(POLL_MS)
  }
}

export function release({ seat, force = false, slot, out = console.log }) {
  const slots = slotNumbers(config())
  const held = slots.map((n) => readHolder(n)).filter(Boolean)
  dropTicket(seat)
  let target = held.find((h) => h.seat === seat)
  if (!target && force) target = slot ? held.find((h) => h.n === Number(slot)) : held.length === 1 ? held[0] : null
  if (!target) {
    if (!held.length) out('browser-slot: every slot was already free')
    else out(`browser-slot: refused, ${seat} holds no slot (${held.map((h) => `slot ${h.n}: ${h.line}`).join('; ')}); --force [--slot n] clears one`)
    return held.length ? 1 : 0
  }
  const aside = `${lockDir(target.n)}.released-${Date.now()}-${process.pid}`
  try {
    fs.renameSync(lockDir(target.n), aside)
    fs.rmSync(aside, { recursive: true, force: true })
  } catch {}
  out(`browser-slot: released slot ${target.n} (${target.line}, held ${age(target.ageS)})`)
  return 0
}

export function status({ out = console.log } = {}) {
  const cfg = config()
  const gate = memoryGate(cfg)
  const reserved = cfg.reserve ? `, ${path.basename(lockDir(cfg.count))} reserved for ${cfg.reserve} (who may take the others too)` : ''
  out(`cap     ${cfg.count} slot(s)${reserved}; ${gate.reading}: ${gate.ok ? 'new holders allowed' : `no new holder, ${gate.why}`}`)
  let recorded = '?'
  try {
    recorded = fs.readFileSync(VERSION_FILE, 'utf8').trim()
  } catch {}
  out(`tool    version ${VERSION} (newest in use: ${recorded})`)
  for (const n of slotNumbers(cfg)) {
    const holder = readHolder(n)
    const label = `slot ${n}`.padEnd(8)
    const note = n > cfg.count ? ' [over the cap]' : cfg.reserve && n === cfg.count ? ` [${cfg.reserve}]` : ''
    if (!holder) {
      out(`${label}free${note}`)
      continue
    }
    const pid = holder.pid ? `pid ${holder.pid} ${alive(holder.pid) ? 'alive' : 'gone'}` : 'no pid (taken by hand)'
    const flags = [holder.ageS > MAX_HOLD_S ? 'over 10 minutes' : '', isStale(holder) ? 'stale, cleared on the next take' : '']
    out(`${label}${holder.line}  (${age(holder.ageS)}, ${pid}${flags.filter(Boolean).map((f) => `; ${f}`).join('')})${note}`)
  }
  const priority = nextSeat()
  out(`next    ${priority ? `${priority} (browser.next)` : 'none'}`)
  const order = servingOrder(listTickets({ prune: false }))
  if (!order.length) out('queue   empty')
  order.forEach((t, i) =>
    out(
      `${i ? '        ' : 'queue   '}${i + 1}. ${t.seat}${t.role !== 'developer' ? ` (${t.role})` : ''}  waiting ${age(nowS() - t.queuedS)}` +
        (t.verdict ? `; last take ${age(nowS() - (t.checkedS || nowS()))} ago: ${t.verdict}` : '; no take since queueing') +
        (t.stale ? ' (stale, dropped on the next take)' : ''),
    ),
  )
  return 0
}

/** Take the slot, run the command while holding it, and always release. Exit status is the command's. */
export function run({ seat, role, purpose, waitS, command, out = console.log }) {
  const took = take({ seat, role, purpose, waitS, pid: process.pid, out })
  if (took !== 0) return took
  try {
    const child = spawnSync(command[0], command.slice(1), { stdio: 'inherit' })
    return child.status ?? 1
  } finally {
    release({ seat, out })
  }
}

function usage() {
  console.error('usage: browser-slot take|release|run|status --seat <key> [--role <role>] [--purpose <text>] [--wait <s>] [--force [--slot <n>]] [-- <command...>]')
  return 64
}

export function main(argv) {
  const [verb, ...rest] = argv
  const dash = rest.indexOf('--')
  const flags = dash >= 0 ? rest.slice(0, dash) : rest
  const command = dash >= 0 ? rest.slice(dash + 1) : []
  const opt = {}
  for (let i = 0; i < flags.length; i++) {
    const key = flags[i].replace(/^--/, '')
    if (key === 'force') opt.force = true
    else opt[key] = flags[++i]
  }
  const seat = opt.seat || env.HD_SEAT
  if (verb === 'status') return status()
  if (!['take', 'release', 'run'].includes(verb) || !seat || !/^[a-z0-9][a-z0-9-]*$/.test(seat)) return usage()
  const waitS = opt.wait !== undefined ? Number(opt.wait) : 100
  const purpose = (opt.purpose || 'browser gate').replace(/\s+/g, ' ')
  if (verb === 'take') return take({ seat, role: opt.role, purpose, waitS })
  if (verb === 'release') return release({ seat, force: opt.force, slot: opt.slot })
  if (!command.length) return usage()
  return run({ seat, role: opt.role, purpose, waitS, command })
}

const invoked = process.argv[1] && fs.realpathSync(process.argv[1])
if (invoked === fs.realpathSync(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)))
