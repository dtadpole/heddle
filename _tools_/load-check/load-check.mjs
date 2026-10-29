#!/usr/bin/env node
// Load check — what this Mac is doing during a team review.
//
//   node _tools_/load-check/load-check.mjs
//
// Reads the machine (free disk, load average, swap), the build slots' owner files and
// the processes whose working directory is a ~/heddle--* worktree, prints one plain
// report and exits with a meaningful code:
//
//   0  ok      nothing to do
//   1  warn    the coordinator should slow down, or a slot was left behind
//   2  stop    the working model's stop conditions: report to the owner
//
// Thresholds are constants below and can be overridden from the environment.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const OK = 0
export const WARN = 1
export const STOP = 2

export const THRESHOLDS = {
  diskStopGb: 20, // working model: stop and report below 20 GB free
  diskWarnGb: 26, // working model: remove release artifacts below 26 GB free
  loadWarnPerCore: 1.5,
  loadStopPerCore: 2.0,
  teamWarnPerCore: 1.0,
  teamStopPerCore: 1.3,
  // D-061: memory_pressure free is the gate (under 25% nothing new starts); macOS swap is sticky, so swap used is
  // only a backstop at 7680M (7.5 GiB). The percent of total swap is printed as detail only.
  memWarnPct: 30,
  memStopPct: 25,
  swapWarnMb: 7424,
  swapStopMb: 7680,
  slots: 3,
}

export function thresholdsFrom(env = process.env) {
  const number = (name, fallback) => {
    const value = env[name]
    if (value === undefined || value === '') return fallback
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return {
    diskStopGb: number('LOAD_CHECK_DISK_STOP_GB', THRESHOLDS.diskStopGb),
    diskWarnGb: number('LOAD_CHECK_DISK_WARN_GB', THRESHOLDS.diskWarnGb),
    loadWarnPerCore: number('LOAD_CHECK_LOAD_WARN_PER_CORE', THRESHOLDS.loadWarnPerCore),
    loadStopPerCore: number('LOAD_CHECK_LOAD_STOP_PER_CORE', THRESHOLDS.loadStopPerCore),
    teamWarnPerCore: number('LOAD_CHECK_TEAM_WARN_PER_CORE', THRESHOLDS.teamWarnPerCore),
    teamStopPerCore: number('LOAD_CHECK_TEAM_STOP_PER_CORE', THRESHOLDS.teamStopPerCore),
    memWarnPct: number('LOAD_CHECK_MEM_WARN_PCT', THRESHOLDS.memWarnPct),
    memStopPct: number('LOAD_CHECK_MEM_STOP_PCT', THRESHOLDS.memStopPct),
    swapWarnMb: number('LOAD_CHECK_SWAP_WARN_MB', THRESHOLDS.swapWarnMb),
    swapStopMb: number('LOAD_CHECK_SWAP_STOP_MB', THRESHOLDS.swapStopMb),
    slots: number('LOAD_CHECK_SLOTS', THRESHOLDS.slots),
  }
}

const gib = (kb) => kb / 1024 / 1024
const mib = (mb) => mb

export function parseDf(text) {
  const lines = text.trim().split('\n').filter((l) => l.trim())
  if (lines.length < 2) throw new Error(`df output has no data line: ${JSON.stringify(text)}`)
  const fields = lines.at(-1).trim().split(/\s+/)
  if (fields.length < 4) throw new Error(`df data line has ${fields.length} fields: ${lines.at(-1)}`)
  return {
    filesystem: fields[0],
    totalKb: Number(fields[1]),
    usedKb: Number(fields[2]),
    availKb: Number(fields[3]),
    mount: fields.at(-1),
  }
}

export function parseLoadavg(text) {
  const numbers = text.match(/-?\d+(?:\.\d+)?/g)
  if (!numbers || numbers.length < 3) throw new Error(`load average not understood: ${JSON.stringify(text)}`)
  return numbers.slice(0, 3).map(Number)
}

export function parseMemory(text) {
  const match = /free percentage:\s*(\d+)%/.exec(text)
  if (!match) throw new Error(`memory_pressure not understood: ${JSON.stringify(text.slice(-200))}`)
  return { freePct: Number(match[1]) }
}

export function parseSwap(text) {
  const match = /total\s*=\s*([\d.]+)M\s+used\s*=\s*([\d.]+)M\s+free\s*=\s*([\d.]+)M/.exec(text)
  if (!match) throw new Error(`swap not understood: ${JSON.stringify(text)}`)
  return { totalMb: Number(match[1]), usedMb: Number(match[2]), freeMb: Number(match[3]) }
}

// An owner file is "<pid> <epoch> <cargo> <cwd>" or the earlier "<pid> <epoch> <cwd>".
export function parseOwner(text) {
  const fields = text.trim().split(/\s+/)
  const [pid, ts, third, ...rest] = fields
  const pidNumber = Number(pid) || 0
  const stamp = Number(ts) || 0
  const thirdIsPid = /^\d+$/.test(third ?? '') && rest.length > 0
  return {
    pid: pidNumber,
    stamp,
    cargo: thirdIsPid ? Number(third) : 0,
    cwd: thirdIsPid ? rest.join(' ') : [third, ...rest].filter(Boolean).join(' '),
  }
}

const pidAlive = (pid) => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export function readSlots({ root, slots, now = Date.now(), alive = pidAlive }) {
  const found = []
  for (let i = 0; i < slots; i += 1) {
    const dir = join(root, `slot-${i}`)
    if (!existsSync(dir)) {
      found.push({ index: i, state: 'free' })
      continue
    }
    const ownerFile = join(dir, 'owner')
    if (!existsSync(ownerFile)) {
      found.push({ index: i, state: 'unclaimed' })
      continue
    }
    const owner = parseOwner(readFileSync(ownerFile, 'utf8'))
    const age = Math.max(0, Math.round((now - owner.stamp * 1000) / 1000))
    const held = alive(owner.pid) || alive(owner.cargo)
    found.push({ index: i, state: held ? 'busy' : 'stale', age, ...owner })
  }
  return found
}

// lsof -F pcn, one process per "p<pid>" block: "c<command>" and "n<cwd>".
export function parseLsof(text) {
  const processes = []
  let current = null
  for (const line of text.split('\n')) {
    if (!line) continue
    const tag = line[0]
    const value = line.slice(1)
    if (tag === 'p') {
      current = { pid: Number(value) }
      processes.push(current)
    } else if (!current) {
      continue
    } else if (tag === 'c') {
      current.command = value
    } else if (tag === 'n') {
      current.cwd = value
    }
  }
  return processes.filter((p) => p.pid && p.cwd)
}

export function parsePs(text) {
  const byPid = new Map()
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match) continue
    byPid.set(Number(match[1]), {
      pid: Number(match[1]),
      cpu: Number(match[2]),
      mem: Number(match[3]),
      elapsed: match[4],
      command: match[5],
    })
  }
  return byPid
}

// Group the processes whose working directory is a seat worktree, ~/heddle--<seat>.
export function groupWorktrees(processes, home = homedir()) {
  const prefix = `${home}/heddle--`
  const groups = new Map()
  for (const proc of processes) {
    if (!proc.cwd || !proc.cwd.startsWith(prefix)) continue
    const rest = proc.cwd.slice(prefix.length)
    const seat = rest.split('/')[0]
    if (!seat) continue
    const key = `heddle--${seat}`
    if (!groups.has(key)) groups.set(key, { worktree: key, processes: [], cpu: 0 })
    const group = groups.get(key)
    group.processes.push(proc)
    group.cpu += proc.cpu ?? 0
  }
  return [...groups.values()].sort((a, b) => b.cpu - a.cpu || a.worktree.localeCompare(b.worktree))
}

export const BUILD_COMMANDS = /^(cargo|rustc|rustdoc|cargo-clippy|cargo-fmt|clippy-driver|cc|ld)$/

export function countBuilds(processes) {
  const counts = { cargo: 0, rustc: 0, other: 0 }
  for (const proc of processes) {
    const name = basename(proc.command ?? '')
    if (name === 'cargo' || name.startsWith('cargo-')) counts.cargo += 1
    else if (name === 'rustc' || name === 'rustdoc' || name === 'clippy-driver') counts.rustc += 1
    else if (/^(cc|ld|clang|gcc)$/.test(name)) counts.other += 1
  }
  return counts
}

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

const word = (l) => ['ok', 'warn', 'stop'][l]

// A build process is team work even when its cwd is not visible to lsof; everything
// else the team runs has a cwd under a seat worktree and is already in `processes`.
export const TEAM_PROCESS = /^(cargo|rustc|rustdoc|cargo-clippy|clippy-driver)$/

// The Mac is shared with the desktop. `ps` gives every process' cpu share, so the
// team's own share can be told apart from Spotlight, Chrome and WindowServer — which is
// what decides whether the coordinator should throttle the team or leave the desktop be.
export function splitLoad({ processes = [], allProcesses = [], ncpu = 1, home = homedir() }) {
  const byPid = new Map(allProcesses.map((proc) => [proc.pid, proc]))
  const prefix = `${home}/heddle--`
  const team = new Map()
  // Only a process whose working directory is a seat worktree is the team's; `processes`
  // carries every process lsof could read, the desktop's included.
  for (const proc of processes) {
    if (proc.cwd && proc.cwd.startsWith(prefix)) team.set(proc.pid, byPid.get(proc.pid) ?? proc)
  }
  for (const proc of allProcesses) {
    if (TEAM_PROCESS.test(basename(proc.command ?? ''))) team.set(proc.pid, proc)
  }
  const teamCpu = [...team.values()].reduce((sum, proc) => sum + (proc.cpu ?? 0), 0)
  const teamPids = new Set(team.keys())
  const other = allProcesses
    .filter((proc) => !teamPids.has(proc.pid))
    .sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0) || a.pid - b.pid)
    .slice(0, 5)
  return { teamCpu, teamPerCore: teamCpu / 100 / ncpu, teamCount: team.size, other }
}

export function assess({ disk, load, ncpu, swap, memory = null, slots, processes, allProcesses = processes, home = homedir(), thresholds = THRESHOLDS }) {
  const findings = []
  const diskFreeGb = gib(disk.availKb)
  const diskVerdict =
    diskFreeGb < thresholds.diskStopGb ? STOP : diskFreeGb < thresholds.diskWarnGb ? WARN : OK

  const systemLoadPerCore = load[0] / ncpu
  const split = splitLoad({ processes, allProcesses, ncpu, home })
  // The verdict follows the team's share; the system load average is context, because
  // the desktop's Spotlight or Chrome must not throttle the team.
  const loadVerdict =
    split.teamPerCore >= thresholds.teamStopPerCore ? STOP : split.teamPerCore >= thresholds.teamWarnPerCore ? WARN : OK

  const swapPct = pct(swap.usedMb, swap.totalMb)
  const swapVerdict =
    swap.usedMb >= thresholds.swapStopMb ? STOP : swap.usedMb >= thresholds.swapWarnMb ? WARN : OK
  const swapDetail =
    swapVerdict === STOP
      ? `${Math.round(swap.usedMb)}M used >= ${thresholds.swapStopMb}M, nothing new starts (D-061 backstop)`
      : `${Math.round(swap.usedMb)}M used, under ${thresholds.swapStopMb}M: one start at a time (D-061)`
  const memFreePct = memory ? memory.freePct : null
  const memVerdict =
    memFreePct === null ? OK : memFreePct < thresholds.memStopPct ? STOP : memFreePct < thresholds.memWarnPct ? WARN : OK
  const memDetail =
    memVerdict === STOP
      ? `${memFreePct}% free < ${thresholds.memStopPct}%, nothing new starts (D-061)`
      : `${memFreePct}% free, under ${thresholds.memWarnPct}%: one start at a time (D-061)`

  const stale = slots.filter((s) => s.state === 'stale' || s.state === 'unclaimed')
  const slotVerdict = stale.length > 0 ? WARN : OK

  const busy = slots.filter((s) => s.state === 'busy').length
  const builds = countBuilds(processes)
  const cap = thresholds.slots * (Number(process.env.LOCAL_BUILD_JOBS) || 3)
  // A slot runs at most `jobs` rustc processes, so more than slots x jobs means a build
  // outside the runner; cargo parents and linkers are counted for the report, not the cap.
  const buildVerdict = builds.rustc > cap ? WARN : OK

  const topOther = split.other[0] ? ` (${basename(split.other[0].command ?? '?')})` : ''
  for (const [name, verdict, detail] of [
    ['disk', diskVerdict, `${diskFreeGb.toFixed(1)} GB free`],
    ['load', loadVerdict, `team ${split.teamPerCore.toFixed(2)}/core, system ${systemLoadPerCore.toFixed(2)}/core${topOther}`],
    ['memory', memVerdict, memDetail],
    ['swap', swapVerdict, swapDetail],
    ['slots', slotVerdict, stale.length ? `${stale.length} stale` : `${busy} busy`],
    ['builds', buildVerdict, `${builds.rustc} rustc > ${cap}`],
  ]) {
    if (verdict !== OK) findings.push(`${name}: ${detail}`)
  }

  const verdict = Math.max(diskVerdict, loadVerdict, memVerdict, swapVerdict, slotVerdict, buildVerdict)
  return {
    verdict,
    findings,
    diskFreeGb,
    diskVerdict,
    systemLoadPerCore,
    teamPerCore: split.teamPerCore,
    teamCpu: split.teamCpu,
    teamCount: split.teamCount,
    other: split.other,
    loadVerdict,
    memFreePct,
    memVerdict,
    swapPct,
    swapVerdict,
    busy,
    stale: stale.length,
    slotVerdict,
    builds,
    buildVerdict,
    cap,
  }
}

export function format({ at, disk, load, ncpu, swap, slots, processes, thresholds = THRESHOLDS, assessment }) {
  const a = assessment
  const mark = (v) => `[${word(v)}]`
  const lines = []
  lines.push(`load-check ${at} (${ncpu} cores)`)
  lines.push(
    `disk     ${a.diskFreeGb.toFixed(1)} GB free of ${gib(disk.totalKb).toFixed(0)} GB on ${disk.mount} ${mark(a.diskVerdict)}` +
      ` (warn < ${thresholds.diskWarnGb} GB, stop < ${thresholds.diskStopGb} GB)`,
  )
  lines.push(
    `load     ${load.map((n) => n.toFixed(2)).join(' ')} = ${a.systemLoadPerCore.toFixed(2)}/core [context]` +
      ` (system warn >= ${thresholds.loadWarnPerCore}/core, stop >= ${thresholds.loadStopPerCore}/core; verdict follows team)`,
  )
  lines.push(
    `team     ${(a.teamCpu / 100).toFixed(1)} core(s) = ${a.teamPerCore.toFixed(2)}/core ${mark(a.loadVerdict)}` +
      ` (warn >= ${thresholds.teamWarnPerCore}/core, stop >= ${thresholds.teamStopPerCore}/core; ${a.teamCount} process(es))`,
  )
  const otherText = a.other.length
    ? a.other.map((proc) => `${basename(proc.command ?? '?')} ${Math.round(proc.cpu ?? 0)}%`).join(', ')
    : 'none'
  lines.push(`other    ${otherText}`)
  if (a.memFreePct !== null)
    lines.push(`memory   ${a.memFreePct}% free ${mark(a.memVerdict)} (D-061: warn < ${thresholds.memWarnPct}%, stop < ${thresholds.memStopPct}%)`)
  lines.push(
    `swap     ${Math.round(swap.usedMb)}M used of ${Math.round(swap.totalMb)}M = ${a.swapPct}% ${mark(a.swapVerdict)}` +
      ` (D-061 backstop: warn >= ${thresholds.swapWarnMb}M, stop >= ${thresholds.swapStopMb}M)`,
  )
  const free = slots.filter((s) => s.state === 'free').length
  lines.push(`slots    ${slots.length} of ${thresholds.slots}: ${a.busy} busy, ${a.stale} stale, ${free} free`)
  for (const slot of slots) {
    if (slot.state === 'free') continue
    const owner =
      slot.state === 'busy' || slot.state === 'stale'
        ? `pid=${slot.pid} cargo=${slot.cargo} age=${slot.age}s cwd=${slot.cwd || '?'}`
        : 'no owner file'
    lines.push(`         slot ${slot.index} ${slot.state} ${owner}`)
  }
  const groups = groupWorktrees(processes)
  lines.push(`worktrees ${groups.length} with a process`)
  for (const group of groups) {
    const names = [...new Set(group.processes.map((p) => basename(p.command ?? '?')))].sort().join(', ')
    lines.push(`         ~/${group.worktree} ${group.processes.length} proc ${Math.round(group.cpu)}% cpu: ${names}`)
  }
  lines.push(
    `builds   ${a.builds.cargo} cargo, ${a.builds.rustc} rustc, ${a.builds.other} other ${mark(a.buildVerdict)}` +
      ` (cap ${a.cap} rustc = ${thresholds.slots} slots x ${a.cap / thresholds.slots} jobs)`,
  )
  lines.push(`verdict  ${word(a.verdict)}${a.findings.length ? `: ${a.findings.join(', ')}` : ''}`)
  return lines.join('\n')
}

function collect({ home = homedir(), slotRoot = join(home, '.hd-build-slots'), thresholds }) {
  const run = (command, args) => spawnSync(command, args, { encoding: 'utf8' })
  const df = run('df', ['-k', home])
  if (df.status !== 0) throw new Error(`df failed: ${df.stderr}`)
  const loadavg = run('sysctl', ['-n', 'vm.loadavg'])
  if (loadavg.status !== 0) throw new Error(`sysctl vm.loadavg failed: ${loadavg.stderr}`)
  const ncpu = run('sysctl', ['-n', 'hw.ncpu'])
  if (ncpu.status !== 0) throw new Error(`sysctl hw.ncpu failed: ${ncpu.stderr}`)
  const swapOut = run('sysctl', ['-n', 'vm.swapusage'])
  if (swapOut.status !== 0) throw new Error(`sysctl vm.swapusage failed: ${swapOut.stderr}`)
  const memOut = run('memory_pressure', [])
  if (memOut.status !== 0) throw new Error(`memory_pressure failed: ${memOut.stderr}`)
  const user = run('id', ['-un']).stdout.trim()
  const lsof = run('lsof', ['-a', '-d', 'cwd', '-u', user, '-F', 'pcn'])
  // comm is the executable path with no arguments, spaces preserved: the display name
  // and the build test both need the executable, not the flags.
  const ps = run('ps', ['-axo', 'pid=,pcpu=,pmem=,etime=,comm='])
  if (ps.status !== 0) throw new Error(`ps failed: ${ps.stderr}`)
  const byPid = parsePs(ps.stdout)
  const processes = parseLsof(lsof.stdout ?? '').map((proc) => ({ ...byPid.get(proc.pid), ...proc }))
  const allProcesses = [...byPid.values()]
  const at = run('date', ['+%Y-%m-%dT%H:%M:%S%z']).stdout.trim()
  return {
    at,
    disk: parseDf(df.stdout),
    load: parseLoadavg(loadavg.stdout),
    ncpu: Number(ncpu.stdout.trim()),
    swap: parseSwap(swapOut.stdout),
    memory: parseMemory(memOut.stdout),
    slots: readSlots({ root: slotRoot, slots: thresholds.slots }),
    processes,
    allProcesses,
    home,
  }
}

function main(argv, env = process.env) {
  const args = argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: load-check.mjs [--home DIR] [--slots DIR]')
    console.log('exit: 0 ok, 1 warn, 2 stop')
    return OK
  }
  const option = (name, fallback) => {
    const i = args.indexOf(name)
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback
  }
  const home = option('--home', homedir())
  const thresholds = thresholdsFrom(env)
  const sources = collect({ home, slotRoot: option('--slots', join(home, '.hd-build-slots')), thresholds })
  const assessment = assess({ ...sources, thresholds })
  console.log(format({ ...sources, thresholds, assessment }))
  return assessment.verdict
}

// Node runs the main module from its real path, so compare real paths: through a symlink
// such as macOS /tmp the plain comparison was false and the command silently did nothing,
// which for the hygiene gate meant exit 0 with no judgement at all.
function invokedAsScript() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (invokedAsScript()) {
  try {
    process.exitCode = main(process.argv)
  } catch (error) {
    console.error(`load-check: ${error.message}`)
    process.exitCode = 3
  }
}
