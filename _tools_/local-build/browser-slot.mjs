#!/usr/bin/env node
// A fair first-in-first-out queue for the team's one browser slot.
//
//   _tools_/local-build/browser-slot take --seat <key> [--purpose <text>] [--wait <seconds>]
//   _tools_/local-build/browser-slot release --seat <key> [--force]
//   _tools_/local-build/browser-slot run --seat <key> [--purpose <text>] [--wait <seconds>] -- <command...>
//   _tools_/local-build/browser-slot status
//
// The slot is still the mkdir directory $ROOT/browser.lock with an `owner` file inside, so a seat that
// takes it by hand (mkdir) and this tool exclude each other. Waiting seats hold one ticket each in
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
const LOCK = path.join(ROOT, 'browser.lock')
const OWNER = path.join(LOCK, 'owner')
const NEXT = path.join(ROOT, 'browser.next')
const QUEUE = path.join(ROOT, 'browser.queue')
const STALE_HOLDER_S = number('BROWSER_SLOT_STALE_SECONDS', 900) // a holder older than this whose pid is gone is cleared
const TICKET_STALE_S = number('BROWSER_SLOT_TICKET_SECONDS', 300) // a ticket not refreshed for this long is dropped
const NEXT_STALE_S = number('BROWSER_SLOT_NEXT_SECONDS', 1800) // an older browser.next is ignored
const POLL_MS = number('BROWSER_SLOT_POLL_MS', 1000)
const MAX_HOLD_S = 600 // the team's rule: hold the slot at most ten minutes
const QUEUED = 75 // EX_TEMPFAIL: still waiting, the ticket is kept

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
export function readHolder() {
  let dirStat
  try {
    dirStat = fs.statSync(LOCK)
  } catch {
    return null
  }
  let text = ''
  let started = dirStat.mtimeMs / 1000
  try {
    text = fs.readFileSync(OWNER, 'utf8')
    started = fs.statSync(OWNER).mtimeMs / 1000
  } catch {}
  const field = (name) => (text.match(new RegExp(`^${name}=(.*)$`, 'm')) || [])[1]
  const line = text.split('\n')[0].trim()
  const start = Number(field('start')) || started
  const pid = Number(field('pid')) || null
  return { seat: field('seat') || line.split(/\s+/)[0] || '?', line: line || '(no owner file)', pid, start, ageS: nowS() - start }
}

function isStale(holder) {
  return holder.ageS > STALE_HOLDER_S && !alive(holder.pid)
}

/** Clear a holder older than the stale bound whose pid is gone (or never recorded). Rename first: atomic. */
export function clearStale(log = (msg) => process.stderr.write(`${msg}\n`)) {
  const holder = readHolder()
  if (!holder || !isStale(holder)) return false
  const aside = `${LOCK}.stale-${Date.now()}-${process.pid}`
  try {
    fs.renameSync(LOCK, aside)
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
    tickets.push({ name, file, seat: m[2], queuedS: Number(m[1]) / 1000, stale })
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

function ensureTicket(seat, purpose) {
  fs.mkdirSync(QUEUE, { recursive: true })
  const mine = listTickets().find((t) => t.seat === seat)
  if (mine) {
    const now = new Date()
    fs.utimesSync(mine.file, now, now) // refresh: still waiting
    return mine
  }
  const name = `${String(Date.now()).padStart(13, '0')}-${seat}`
  fs.writeFileSync(path.join(QUEUE, name), `seat=${seat}\npurpose=${purpose}\nqueued=${clock()}\n`)
  return listTickets().find((t) => t.seat === seat)
}

function dropTicket(seat) {
  for (const t of listTickets({ prune: false })) if (t.seat === seat) fs.rmSync(t.file, { force: true })
}

function tryTake(seat, purpose, pid) {
  try {
    fs.mkdirSync(LOCK)
  } catch {
    return false // held, by this tool or by hand
  }
  const tmp = path.join(LOCK, `.owner-${process.pid}`)
  fs.writeFileSync(tmp, `${seat} ${purpose} ${clock()}\nseat=${seat}\npid=${pid}\nstart=${Math.floor(nowS())}\n`)
  fs.renameSync(tmp, OWNER)
  return true
}

/** Queue for the slot and wait up to waitS seconds. 0 when held, QUEUED when still waiting (ticket kept). */
export function take({ seat, purpose = 'browser gate', waitS = 100, pid = process.ppid, out = console.log }) {
  const deadline = Date.now() + waitS * 1000
  for (;;) {
    clearStale()
    const holder = readHolder()
    if (holder && holder.seat === seat) {
      dropTicket(seat)
      out(`browser-slot: ${seat} already holds the slot (${age(holder.ageS)})`)
      return 0
    }
    ensureTicket(seat, purpose)
    const order = servingOrder(listTickets())
    if (!holder && order[0]?.seat === seat && tryTake(seat, purpose, pid)) {
      dropTicket(seat)
      if (nextSeat() === seat) fs.rmSync(NEXT, { force: true }) // the priority turn is used
      out(`browser-slot: ${seat} took the slot at ${clock()}; release it within ${MAX_HOLD_S / 60} minutes`)
      return 0
    }
    if (Date.now() >= deadline) {
      const position = order.findIndex((t) => t.seat === seat) + 1
      const held = holder ? `held by ${holder.line} (${age(holder.ageS)})` : 'free, another seat is first'
      out(`browser-slot: ${seat} is queued, position ${position} of ${order.length}; slot ${held}. Run take again to keep the place.`)
      return QUEUED
    }
    sleep(POLL_MS)
  }
}

export function release({ seat, force = false, out = console.log }) {
  const holder = readHolder()
  dropTicket(seat)
  if (!holder) {
    out('browser-slot: the slot was already free')
    return 0
  }
  if (holder.seat !== seat && !force) {
    out(`browser-slot: refused, the slot is held by ${holder.line}; --force clears it`)
    return 1
  }
  const aside = `${LOCK}.released-${Date.now()}-${process.pid}`
  try {
    fs.renameSync(LOCK, aside)
    fs.rmSync(aside, { recursive: true, force: true })
  } catch {}
  out(`browser-slot: released (${holder.line}, held ${age(holder.ageS)})`)
  return 0
}

export function status({ out = console.log } = {}) {
  const holder = readHolder()
  if (!holder) out('holder  free')
  else {
    const pid = holder.pid ? `pid ${holder.pid} ${alive(holder.pid) ? 'alive' : 'gone'}` : 'no pid (taken by hand)'
    const flags = [holder.ageS > MAX_HOLD_S ? 'over 10 minutes' : '', isStale(holder) ? 'stale, cleared on the next take' : '']
    out(`holder  ${holder.line}  (${age(holder.ageS)}, ${pid}${flags.filter(Boolean).map((f) => `; ${f}`).join('')})`)
  }
  const priority = nextSeat()
  out(`next    ${priority ? `${priority} (browser.next)` : 'none'}`)
  const order = servingOrder(listTickets({ prune: false }))
  if (!order.length) out('queue   empty')
  order.forEach((t, i) =>
    out(`${i ? '        ' : 'queue   '}${i + 1}. ${t.seat}  waiting ${age(nowS() - t.queuedS)}${t.stale ? ' (stale, dropped on the next take)' : ''}`),
  )
  return 0
}

/** Take the slot, run the command while holding it, and always release. Exit status is the command's. */
export function run({ seat, purpose, waitS, command, out = console.log }) {
  const took = take({ seat, purpose, waitS, pid: process.pid, out })
  if (took !== 0) return took
  try {
    const child = spawnSync(command[0], command.slice(1), { stdio: 'inherit' })
    return child.status ?? 1
  } finally {
    release({ seat, out })
  }
}

function usage() {
  console.error('usage: browser-slot take|release|run|status --seat <key> [--purpose <text>] [--wait <s>] [--force] [-- <command...>]')
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
  if (verb === 'take') return take({ seat, purpose, waitS })
  if (verb === 'release') return release({ seat, force: opt.force })
  if (!command.length) return usage()
  return run({ seat, purpose, waitS, command })
}

const invoked = process.argv[1] && fs.realpathSync(process.argv[1])
if (invoked === fs.realpathSync(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)))
