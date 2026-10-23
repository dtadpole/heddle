#!/usr/bin/env node
// One page of raw evidence for a member review.
//
//   node _tools_/review-collect/review-collect.mjs --team <TEAM.yaml> --seat developer-ten
//   HEDDLE_TEAM_FILE=<TEAM.yaml> node _tools_/review-collect/review-collect.mjs --seat integrator-one
//
// No team path is built in: the team record is named on the command line or in
// HEDDLE_TEAM_FILE, and the review log, action log and reporter come from that record.
//
// The coordinator reviews one member every pass. This gathers, in one read-only command,
// what that review needs: the seat's tip against origin/main, the commits ahead, the files
// it touches grouped by crate and judged against its recorded write scope, the uncommitted
// paths with the same verdict, its last sent report, the last test or verifier run it
// recorded in a scoped INDEX, and its action-log lines since its last review.
//
// Nothing here writes: no fetch into the seat's clone, no index refresh, no inbox mark.
// Exit 0 with the page, 1 when the seat or a required input is missing.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const OK = 0
export const ERROR = 1

// The inbox tool's own default home; the action log's place in any reflection tree.
const DEFAULT_INBOX_HOME = process.env.REFLECTION_INBOX_HOME || join(homedir(), '.reflection-inbox')
const ACTION_LOG_IN_TREE = join('_logs_', 'repo-actions', 'action-log.jsonl')

const expandHome = (path) => (typeof path === 'string' && path.startsWith('~') ? join(homedir(), path.slice(1)) : path)

// Where the team's record lives, from the record itself: the reflection root is its
// root_hint when that exists, else the team file's folder minus its project_path; the
// review log is references.execution_review under that root; the action log is the
// tree's own; the reporter is the record's owner gateway.
export function teamDefaults({ roster, teamFile }) {
  let root = expandHome(roster.reflection?.root_hint ?? null)
  if (!root || !existsSync(root)) {
    const project = String(roster.project_path ?? '').replace(/\/+$/, '')
    const folder = resolve(teamFile, '..')
    root = project && folder.endsWith(project) ? folder.slice(0, -project.length).replace(/\/+$/, '') : null
  }
  const review = roster.references?.execution_review
  return {
    root,
    reviewLog: root && review ? join(root, review) : null,
    actionLog: root ? join(root, ACTION_LOG_IN_TREE) : null,
    reporter: roster.coordination?.reporting?.owner_gateway ?? roster.record_owner ?? null,
  }
}

// ---- TEAM.yaml, the subset this page needs ------------------------------------------------

function splitKey(text) {
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") i += 1
        else quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === ':' && (i === text.length - 1 || /\s/.test(text[i + 1]))) {
      return { key: text.slice(0, i).trim(), value: text.slice(i + 1).trim() }
    }
  }
  return null
}

function splitTop(text, separator) {
  const parts = []
  let current = ''
  let quote = null
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    if (ch === '[' || ch === '{') depth += 1
    if (ch === ']' || ch === '}') depth -= 1
    if (ch === separator && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

export function parseScalar(raw) {
  const value = raw.trim()
  if (value === '') return ''
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    const inner = value.slice(1, -1)
    return value[0] === "'" ? inner.replace(/''/g, "'") : inner
  }
  if (value === 'null' || value === '~') return null
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return Number(value)
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    return inner === '' ? [] : splitTop(inner, ',').map(parseScalar)
  }
  return value
}

// Maps, lists, lists of maps, quoted scalars and inline arrays; the shape TEAM.yaml uses.
// It deliberately does not parse the YAML this file does not need (anchors, block scalars).
export function parseTeamYaml(text) {
  const lines = text
    .split('\n')
    .map((raw) => ({ indent: (raw.match(/^ */) ?? [''])[0].length, text: raw.trim() }))
    .filter((line) => line.text !== '' && !line.text.startsWith('#'))
  let at = 0
  const parseMap = (indent) => {
    const map = {}
    while (at < lines.length) {
      const line = lines[at]
      if (line.indent !== indent || line.text.startsWith('- ')) break
      const pair = splitKey(line.text)
      if (pair === null) {
        at += 1
        continue
      }
      const key = parseScalar(pair.key)
      at += 1
      if (pair.value !== '') {
        map[key] = parseScalar(pair.value)
      } else if (at < lines.length && lines[at].indent > indent) {
        map[key] = parseNode(lines[at].indent)
      } else {
        map[key] = null
      }
    }
    return map
  }
  const parseSeq = (indent) => {
    const seq = []
    while (at < lines.length) {
      const line = lines[at]
      if (line.indent !== indent || !line.text.startsWith('- ')) break
      const rest = line.text.slice(2)
      const pair = splitKey(rest)
      at += 1
      if (pair === null) {
        seq.push(parseScalar(rest))
        continue
      }
      const item = { [parseScalar(pair.key)]: pair.value === '' ? null : parseScalar(pair.value) }
      if (pair.value === '' && at < lines.length && lines[at].indent > indent) {
        item[parseScalar(pair.key)] = parseNode(lines[at].indent)
      }
      if (at < lines.length && lines[at].indent > indent) Object.assign(item, parseMap(lines[at].indent))
      seq.push(item)
    }
    return seq
  }
  const parseNode = (indent) => (lines[at].text.startsWith('- ') ? parseSeq(indent) : parseMap(indent))
  if (lines.length === 0) return {}
  return parseNode(lines[0].indent)
}

// ---- write scope -------------------------------------------------------------------------

const PATH_TOKEN = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.*-]*\/?/g

// The scopes are prose with paths in them ("heddle rust/crates/x/", "the backend
// _verifiers_ folders"). Keep the paths, keep the prose that has none, and never guess a
// path that is not written.
export function parseScopes(member) {
  const includes = []
  const excludes = []
  const unparsed = []
  const add = (text, kind) => {
    let tokens = [...String(text).matchAll(PATH_TOKEN)].map((match) => match[0])
    if (tokens.length === 0 && /\b_verifiers_\b/.test(text)) tokens = ['_verifiers_/']
    if (tokens.length === 0 && /\brust\/crates\b/.test(text)) tokens = ['rust/crates/']
    tokens = tokens.filter((token) => !token.startsWith('~'))
    if (tokens.length === 0) {
      if (kind === 'include') unparsed.push(String(text))
      return
    }
    for (const token of tokens) (kind === 'include' ? includes : excludes).push({ prefix: token, text: String(text) })
  }
  for (const text of member.write_scopes ?? []) add(text, 'include')
  for (const text of member.excluded_write_scopes ?? []) add(text, 'exclude')
  return { includes, excludes, unparsed }
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function matchesScope(path, prefix) {
  const clean = String(prefix).replace(/\/+$/, '')
  if (clean === '') return false
  if (clean.includes('*')) {
    const pattern = `^${clean.split('*').map(escapeRe).join('[^/]*')}(?:/|$)`
    return new RegExp(pattern).test(path)
  }
  return path === clean || path.startsWith(`${clean}/`)
}

export function classifyPath(path, scopes) {
  if (path === undefined || path === null || path === '') return { verdict: 'unknown' }
  for (const scope of scopes.includes) {
    if (matchesScope(path, scope.prefix)) return { verdict: 'in', scope: scope.text, prefix: scope.prefix }
  }
  for (const scope of scopes.excludes ?? []) {
    if (matchesScope(path, scope.prefix)) return { verdict: 'excluded', scope: scope.text, prefix: scope.prefix }
  }
  if (scopes.includes.length === 0) return { verdict: 'unscoped', scope: scopes.unparsed[0] ?? null }
  return { verdict: 'outside' }
}

// ---- git, read-only ----------------------------------------------------------------------

function git(dir, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw new Error(`git ${args[0]} could not run: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args.slice(0, 2).join(' ')} failed in ${dir}: ${String(result.stderr).trim()}`)
  return result
}

export function parseStatusZ(output) {
  const entries = []
  const tokens = output.split('\0')
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (!token) continue
    const index = token[0]
    const worktree = token[1]
    let path = token.slice(3)
    if (index === 'R' || index === 'C') i += 1
    if (path.endsWith('/')) path = path.slice(0, -1)
    entries.push({ path, index, worktree, untracked: index === '?' && worktree === '?' })
  }
  return entries
}

export function groupPath(path) {
  const crate = /^rust\/crates\/([^/]+)\//.exec(path)
  if (crate) return { key: `crate ${crate[1]}`, path: path.split('/').slice(0, 3).join('/') }
  const verifier = /^_verifiers_\/([^/]+)\//.exec(path)
  if (verifier) return { key: `verifier ${verifier[1]}`, path: path.split('/').slice(0, 2).join('/') }
  const first = path.split('/')[0]
  return { key: first.includes('.') ? '(root)' : first, path: first }
}

// ---- report, runs, ledger ----------------------------------------------------------------

export function readInbox(home) {
  const messages = []
  if (!existsSync(home)) return messages
  for (const team of readdirSync(home)) {
    const teamDir = join(home, team)
    if (!existsSync(teamDir) || !statSync(teamDir).isDirectory()) continue
    for (const member of readdirSync(teamDir)) {
      const file = join(teamDir, member, 'inbox.jsonl')
      if (!existsSync(file)) continue
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          messages.push(JSON.parse(line))
        } catch {
          // a torn line is skipped, not fatal: the page reports what it can read
        }
      }
    }
  }
  return messages
}

// The seat's report is its newest message to the reporter (the coordinator by default);
// its newest message to anyone else is kept beside it as one line, because a seat that
// talks to peers but has not reported is itself a review finding.
export function lastSentReport({ inboxHome = DEFAULT_INBOX_HOME, seat, reporter = null }) {
  const seen = new Set()
  const sent = []
  for (const message of readInbox(inboxHome)) {
    if (message.from !== seat || seen.has(message.id)) continue
    seen.add(message.id)
    sent.push(message)
  }
  sent.sort((a, b) => String(b.created).localeCompare(String(a.created)))
  const report = reporter === null ? null : (sent.find((message) => message.to === reporter) ?? null)
  const latest = sent[0] ?? null
  return { report, latest: latest !== null && latest.id !== report?.id ? latest : null, sent: sent.length }
}

export function lastReview({ reviewLog = null, seat }) {
  if (!reviewLog || !existsSync(reviewLog)) return null
  let latest = null
  for (const line of readFileSync(reviewLog, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.member !== seat) continue
    if (latest === null || String(entry.date) > String(latest.date)) latest = entry
  }
  return latest
}

const RUN_HINT = /cargo (test|check|clippy|build)|verify\.sh|node --test|verify-runner\/(run|all)\.mjs|local-build\/run\s+(test|check|build|clippy)/
// A line in a fence is a command when it starts like one; an import or a value is not.
const FENCED_COMMAND = /^(\$\s+)?(sh|bash|node|cargo|npm|[A-Z][A-Z0-9_]*=\S+|_tools_\/\S+|\.\/\S+)(\s|$)/
// A counted outcome, strong enough to pair with a command a few lines above it.
const COUNTED_RESULT = /\b\d+\s*(tests?|checks?|passed|failed|unjudged|cases?)\b|\b\d+\/\d+\b/i
// A recorded run carries a result: a count, a ratio, a pass word or a date. A usage line
// ("sh verify.sh --list  # why any was unjudged") does not, and is not a run.
const RESULT_HINT = /\b\d+\s*(tests?|checks?|passed|failed|unjudged|cases?)\b|\b\d+\/\d+\b|\b(green|passed|passes|all pass)\b|20\d\d-\d\d-\d\d/i
const COMMAND_IN_LINE = /`([^`]*(?:cargo (?:test|check|clippy)|verify\.sh|node --test)[^`]*)`/

// The INDEX of the unit a path belongs to: a crate, a verifier, a tool, a context folder.
export function unitIndex(path) {
  const parts = path.split('/')
  if (parts[0] === 'rust' && parts[1] === 'crates' && parts.length > 3) return parts.slice(0, 3).concat('INDEX.md').join('/')
  if (['_verifiers_', '_tools_', '_context_'].includes(parts[0]) && parts.length > 2) return parts.slice(0, 2).concat('INDEX.md').join('/')
  if (parts.length === 2 && parts[1] === 'INDEX.md') return path
  return null
}

// Which INDEX files can hold this seat's recorded runs: the ones its scope names
// specifically (a crate, a tool, rust/INDEX.md), and the ones whose unit it touched. A
// broad type folder in a scope ("_tools_/", "_verifiers_/") counts only where it was
// touched, so a seat is not credited with every tool in the tree.
export function candidateIndexes({ worktree, scopes, touched = [] }) {
  const found = new Map()
  const add = (relativePath, why) => {
    if (relativePath === null || found.has(relativePath)) return
    if (!existsSync(join(worktree, relativePath))) return
    const scope = classifyPath(relativePath, scopes)
    if (scope.verdict !== 'in') return
    found.set(relativePath, why)
  }
  for (const path of touched) add(unitIndex(path), 'touched')
  for (const scope of scopes.includes) {
    const prefix = scope.prefix.replace(/\/+$/, '')
    if (prefix.includes('*')) continue
    if (prefix.endsWith('.md')) {
      add(prefix, 'scope')
      continue
    }
    const depth = prefix.split('/').length
    const broad = depth < 2 || (prefix.startsWith('rust/crates') && depth < 3)
    if (!broad) add(`${prefix}/INDEX.md`, 'scope')
  }
  return [...found].map(([relativePath, why]) => ({ relativePath, file: join(worktree, relativePath), why }))
}

// The last line in each scoped INDEX that records a run (the command and its result on
// one line, outside a code fence), newest dated first; and, for an INDEX that records
// none, the test command it declares, labelled as declared. Evidence to read, not a
// verdict to trust blind.
export function recordedRuns({ worktree, scopes, touched = [], limit = 3 }) {
  const recorded = []
  const declared = []
  for (const { relativePath, file } of candidateIndexes({ worktree, scopes, touched })) {
    const lines = readFileSync(file, 'utf8').split('\n')
    let best = null
    let firstDeclared = null
    let block = null // the fenced block being read
    let lastBlock = null // the last fenced block that held a run command
    const dateNear = (from, to) => {
      for (let i = to; i >= Math.max(0, from); i -= 1) {
        const date = /20\d\d-\d\d-\d\d/.exec(lines[i])?.[0]
        if (date) return date
      }
      return null
    }
    lines.forEach((raw, index) => {
      const line = raw.trim()
      if (line.startsWith('```')) {
        if (block === null) {
          block = { start: index, commands: [], pending: '' }
        } else {
          if (block.pending) block.commands.push(block.pending)
          const runCommands = block.commands.filter((command) => RUN_HINT.test(command))
          if (runCommands.length > 0) {
            lastBlock = { start: block.start, end: index, command: runCommands.join(' ; ') }
            if (firstDeclared === null) firstDeclared = { file: relativePath, line: block.start + 2, command: runCommands[0] }
          }
          block = null
        }
        return
      }
      if (block !== null) {
        // Join backslash continuations, so a two-line HEDDLE_BIN=... \ node ... is one command.
        const text = line.replace(/\s+#.*$/, '').replace(/^\$\s+/, '')
        if (block.pending) {
          block.pending = `${block.pending} ${text.replace(/\\$/, '').trim()}`.trim()
          if (!text.endsWith('\\')) {
            block.commands.push(block.pending)
            block.pending = ''
          }
        } else if (FENCED_COMMAND.test(text)) {
          if (text.endsWith('\\')) block.pending = text.replace(/\\$/, '').trim()
          else block.commands.push(text)
        }
        return
      }
      const inline = COMMAND_IN_LINE.exec(line)?.[1]?.trim() ?? null
      if (inline && RUN_HINT.test(inline) && firstDeclared === null) firstDeclared = { file: relativePath, line: index + 1, command: inline }
      // One line that names a command and its result.
      if (inline && RUN_HINT.test(inline) && RESULT_HINT.test(line)) {
        best = { file: relativePath, line: index + 1, text: line, command: inline, date: dateNear(index, index) }
        return
      }
      // A counted result just after a fenced command block: that block is its command.
      if (lastBlock !== null && COUNTED_RESULT.test(line) && index - lastBlock.end <= 4) {
        best = { file: relativePath, line: index + 1, text: line, command: lastBlock.command, date: dateNear(index, index) ?? dateNear(lastBlock.start - 3, lastBlock.start) }
        lastBlock = null
      }
    })
    if (best) recorded.push(best)
    else if (firstDeclared) declared.push(firstDeclared)
  }
  // Newest dated first; undated keep the candidate order (touched units before scope names).
  recorded.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
  return { recorded: recorded.slice(0, limit), declared: declared.slice(0, limit), recordedTotal: recorded.length, declaredTotal: declared.length }
}

export function actionLedger({ actionLog = null, reviewLog = null, seat, since = null }) {
  const review = since === null ? lastReview({ reviewLog, seat }) : null
  const cutoff = since ?? review?.date ?? null
  const lines = []
  const before = []
  if (!actionLog || !existsSync(actionLog)) return { cutoff, lines, review, lastBefore: null, missing: true }
  for (const line of readFileSync(actionLog, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const reason = String(entry.reason ?? '')
    const mine = entry.actor === seat || reason.includes(`[hd] ${seat}:`) || reason.startsWith(`[hd] ${seat} `)
    if (!mine) continue
    if (cutoff !== null && new Date(entry.timestamp) <= new Date(cutoff)) {
      before.push(entry)
      continue
    }
    lines.push(entry)
  }
  lines.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
  before.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
  return { cutoff, lines, review, lastBefore: before.at(-1) ?? null }
}

// ---- the page ----------------------------------------------------------------------------

const tilde = (path) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path)

export function collectReview({ seat, team = process.env.HEDDLE_TEAM_FILE || null, repo = null, worktree = null, branch = null, inboxHome = DEFAULT_INBOX_HOME, actionLog = null, reviewLog = null, since = null, reporter = null }) {
  const notes = []
  if (!team) throw new Error('no team file: pass --team <TEAM.yaml> or set HEDDLE_TEAM_FILE')
  team = expandHome(team)
  if (!existsSync(team)) throw new Error(`no team file at ${team}`)
  const roster = parseTeamYaml(readFileSync(team, 'utf8'))
  const defaults = teamDefaults({ roster, teamFile: team })
  actionLog = actionLog ?? defaults.actionLog
  reviewLog = reviewLog ?? defaults.reviewLog
  reporter = reporter ?? defaults.reporter
  if (!reviewLog || !existsSync(reviewLog)) notes.push('no review log found from the team record; the action log is shown without a cutoff')
  if (!actionLog || !existsSync(actionLog)) notes.push('no action log found from the team record')
  if (!reporter) notes.push('the team record names no owner gateway; pass --reporter')
  const member = (roster.members ?? []).find((entry) => entry.key === seat)
  if (member === undefined) throw new Error(`no member ${JSON.stringify(seat)} in ${team}; seats: ${(roster.members ?? []).map((m) => m.key).join(', ')}`)
  const scopes = parseScopes(member)

  let reviewerRepo = repo
  if (reviewerRepo === null) {
    const top = spawnSync('git', ['--no-optional-locks', 'rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' })
    if (top.status !== 0) throw new Error('not inside a git checkout; pass --repo')
    reviewerRepo = top.stdout.trim()
  }
  const fetched = spawnSync('git', ['--no-optional-locks', '-C', reviewerRepo, 'fetch', '-q', 'origin'], { encoding: 'utf8', timeout: 20_000 })
  if (fetched.status !== 0) notes.push(`fetch failed (${String(fetched.stderr).trim().split('\n').at(-1) ?? 'unknown'}); origin/main may be stale`)
  const mainRef = 'origin/main'
  const mainSha = git(reviewerRepo, ['rev-parse', '--verify', mainRef]).stdout.trim()

  const identity = String(member.resource_identity_ref ?? '')
  const identityPath = /(~\/[^\s,]+)/.exec(identity)?.[1] ?? null
  const seatWorktree = worktree ?? (identityPath ? identityPath.replace(/^~/, homedir()) : join(homedir(), `heddle--${seat}`))
  const worktreeExists = existsSync(join(seatWorktree, '.git'))
  const branchName = branch ?? `hd/${seat}`

  const result = {
    seat,
    title: member.title ?? seat,
    lane: member.lane ?? null,
    focus: member.current_focus ?? null,
    team,
    scopes,
    worktree: seatWorktree,
    worktreeExists,
    branch: branchName,
    fetched: fetched.status === 0,
    main: { ref: mainRef, sha: mainSha, date: git(reviewerRepo, ['show', '-s', '--format=%cI', mainSha], { allowFailure: true }).stdout.trim() },
    notes,
    tip: null,
    base: null,
    ahead: 0,
    behind: 0,
    commits: [],
    files: [],
    uncommitted: [],
    report: null,
    runs: { recorded: [], declared: [], recordedTotal: 0, declaredTotal: 0 },
    reporter,
    ledger: { cutoff: null, lines: [], review: null },
  }

  if (!worktreeExists) {
    notes.push(`no worktree at ${tilde(seatWorktree)}`)
    result.report = lastSentReport({ inboxHome, seat, reporter })
    result.ledger = actionLedger({ actionLog, reviewLog, seat, since })
    result.runs = { recorded: [], declared: [], recordedTotal: 0, declaredTotal: 0 }
    return result
  }

  const tip = git(seatWorktree, ['rev-parse', 'HEAD']).stdout.trim()
  const branchNow = git(seatWorktree, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true }).stdout.trim()
  if (branchNow !== branchName) notes.push(`the worktree is on ${branchNow || 'a detached HEAD'}, not ${branchName}`)
  // The reviewer's freshly fetched main is only comparable if the seat's clone has the object.
  let base = mainSha
  if (git(seatWorktree, ['cat-file', '-e', `${mainSha}^{commit}`], { allowFailure: true }).status !== 0) {
    const localMain = git(seatWorktree, ['rev-parse', '--verify', mainRef], { allowFailure: true })
    if (localMain.status !== 0) throw new Error(`${tilde(seatWorktree)} has neither ${mainRef} nor the fetched tip; it needs a fetch`)
    base = localMain.stdout.trim()
    notes.push(`the seat clone lacks the fetched main tip; compared against its own ${mainRef} ${base.slice(0, 7)}`)
  }
  const counts = git(seatWorktree, ['rev-list', '--left-right', '--count', `${base}...HEAD`]).stdout.trim().split(/\s+/).map(Number)
  const [behind, ahead] = counts
  const commitLines = git(seatWorktree, ['log', '--format=%h%x09%cI%x09%s', `${base}..HEAD`], { allowFailure: true }).stdout.trim()
  const allCommits = commitLines ? commitLines.split('\n').map((line) => {
    const [sha, date, ...subject] = line.split('\t')
    return { sha, date, subject: subject.join('\t') }
  }) : []
  // A merge of main is plumbing, not the seat's work: keep the count, list the subjects.
  const merges = allCommits.filter((commit) => commit.subject.startsWith('Merge '))
  const commits = allCommits.filter((commit) => !commit.subject.startsWith('Merge '))

  const diff = git(seatWorktree, ['diff', '--name-only', '-z', `${base}...HEAD`]).stdout
  const changed = diff.split('\0').filter(Boolean)
  const status = parseStatusZ(git(seatWorktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout)

  const files = changed.map((path) => ({ path, ...classifyPath(path, scopes), group: groupPath(path).key }))
  const uncommitted = status.map((entry) => ({ ...entry, ...classifyPath(entry.path, scopes), group: groupPath(entry.path).key }))

  result.tip = { sha: tip, branch: branchNow }
  result.base = base
  result.behind = behind
  result.ahead = ahead
  result.commits = commits
  result.mergeCount = merges.length
  result.totalAhead = allCommits.length
  result.files = files
  result.uncommitted = uncommitted
  result.report = lastSentReport({ inboxHome, seat, reporter })
  result.runs = recordedRuns({ worktree: seatWorktree, scopes, touched: [...files.map((file) => file.path), ...uncommitted.map((entry) => entry.path)] })
  result.ledger = actionLedger({ actionLog, reviewLog, seat, since })
  return result
}

const scopeMark = (entry) => (entry.verdict === 'in' ? `in scope (${entry.scope})` : entry.verdict === 'excluded' ? `EXCLUDED (${entry.scope})` : entry.verdict === 'unscoped' ? 'no path scope recorded' : entry.verdict === 'unknown' ? 'unknown' : 'OUTSIDE SCOPE')

export function render(result) {
  const lines = []
  const push = (line = '') => lines.push(line)
  push(`review-collect: ${result.seat}  ${result.title}${result.lane ? `  lane ${result.lane}` : ''}`)
  push(`team        ${tilde(result.team)}`)
  push(`focus       ${result.focus ?? '-'}`)
  if (!result.worktreeExists) {
    push(`worktree    ${tilde(result.worktree)}  MISSING (seat not started, or the worktree is elsewhere)`)
  } else {
    push(`worktree    ${tilde(result.worktree)}  branch ${result.branch}  HEAD ${result.tip.sha.slice(0, 12)}${result.tip.branch !== result.branch ? `  (on ${result.tip.branch || 'detached'})` : ''}`)
    push(`tip         ${result.ahead} ahead, ${result.behind} behind  ${result.main.ref} ${result.main.sha.slice(0, 7)}${result.main.date ? ` (${result.main.date})` : ''}${result.fetched ? '' : '  [fetch failed]'}`)
    const off = (entries) => entries.filter((entry) => entry.verdict === 'outside' || entry.verdict === 'excluded')
    const offCommitted = off(result.files)
    const offUncommitted = off(result.uncommitted)
    push(
      `scope check ${offCommitted.length + offUncommitted.length === 0 ? 'clean' : 'ATTENTION'}: ` +
        `${offCommitted.length} committed and ${offUncommitted.length} uncommitted path(s) outside the write scope` +
        (offCommitted.length + offUncommitted.length > 0 ? ` (${[...offCommitted, ...offUncommitted].map((entry) => entry.path).slice(0, 6).join(', ')})` : ''),
    )
    push(`commits     ${result.commits.length} ahead with subjects${result.mergeCount > 0 ? ` (${result.mergeCount} merge(s) of main not listed; ${result.totalAhead} commits total)` : ''}`)
    for (const commit of result.commits.slice(0, 30)) push(`  ${commit.sha}  ${commit.date?.slice(0, 16) ?? ''}  ${commit.subject}`)
    if (result.commits.length > 30) push(`  ... ${result.commits.length - 30} more`)

    const groups = new Map()
    for (const file of result.files) {
      if (!groups.has(file.group)) groups.set(file.group, [])
      groups.get(file.group).push(file)
    }
    push(`files       ${result.files.length} changed vs ${result.main.ref}`)
    for (const [key, files] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      const verdicts = new Set(files.map((file) => file.verdict))
      const tag = verdicts.size === 1 ? `[${scopeMark(files[0])}]` : '[mixed]'
      push(`  ${key} (${files.length}) ${tag}`)
      for (const file of files) push(`    ${file.path}${verdicts.size === 1 ? '' : `  ${scopeMark(file)}`}`)
    }
    if (result.files.length === 0) push('  none')

    push(`uncommitted ${result.uncommitted.length} path(s)`)
    for (const entry of result.uncommitted) push(`  ${entry.index}${entry.worktree} ${entry.path}  ${scopeMark(entry)}`)
    if (result.uncommitted.length === 0) push('  none')
  }

  const { report, latest, sent } = result.report
  if (report === null) {
    push(`last report none to ${result.reporter ?? '(no reporter)'} (${sent} message(s) sent in all)`)
  } else {
    const bodyLines = String(report.body ?? '').split('\n')
    push(`last report ${report.created} to ${report.to} [${report.kind}] ${report.subject}`)
    for (const line of bodyLines.slice(0, 12)) push(`  ${line.length > 160 ? `${line.slice(0, 157)}...` : line}`)
    if (bodyLines.length > 12) push(`  ... ${bodyLines.length - 12} more line(s) in the inbox (${report.id})`)
  }
  if (latest !== null) push(`newer msg   ${latest.created} to ${latest.to} [${latest.kind}] ${latest.subject}`)

  const runs = result.runs
  push(`runs        ${runs.recordedTotal} recorded in a scoped INDEX${runs.recordedTotal > runs.recorded.length ? ` (newest ${runs.recorded.length} shown)` : ''}`)
  for (const run of runs.recorded) {
    push(`  ${run.file}:${run.line}${run.date ? `  ${run.date}` : ''}`)
    push(`    ${run.text.length > 300 ? `${run.text.slice(0, 297)}...` : run.text}`)
    push(`    command: ${run.command ?? '(no command in the line)'}`)
  }
  if (runs.recordedTotal === 0) {
    for (const run of runs.declared) push(`  declared, no recorded result: ${run.command}  (${run.file}:${run.line})`)
    if (runs.declared.length === 0) push('  no test command declared in a scoped INDEX either')
  }

  const lastBefore = result.ledger.lastBefore
  push(
    `action log  ${result.ledger.lines.length} line(s)${result.ledger.cutoff ? ` since ${result.ledger.review?.date ?? result.ledger.cutoff}` : ' (no previous review recorded)'}` +
      (result.ledger.lines.length === 0 && lastBefore ? ` (last seat line ${lastBefore.timestamp})` : ''),
  )
  for (const entry of result.ledger.lines) {
    const paths = (Array.isArray(entry.paths) ? entry.paths.join(', ') : String(entry.paths ?? '')) || '-'
    push(`  ${entry.timestamp}  ${entry.commit ?? '-'}  ${entry.action ?? '-'}  ${paths}`)
    push(`    ${String(entry.reason ?? '').slice(0, 300)}`)
  }

  push(`scope       include: ${result.scopes.includes.length === 0 ? 'none machine-readable' : result.scopes.includes.map((scope) => scope.prefix).join(', ')}`)
  if (result.scopes.unparsed.length > 0) push(`            unparsed: ${result.scopes.unparsed.join(' | ')} (an outside verdict is only for parsed prefixes)`)
  for (const note of result.notes) push(`note        ${note}`)
  return lines.join('\n')
}

function parseArgs(argv) {
  const args = { seat: null, team: process.env.HEDDLE_TEAM_FILE || null, repo: null, worktree: null, branch: null, inboxHome: DEFAULT_INBOX_HOME, actionLog: null, reviewLog: null, since: null, reporter: null, help: false }
  const value = (i, name) => {
    if (argv[i] === undefined) throw new Error(`${name} needs a value`)
    return argv[i]
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--seat') args.seat = value((i += 1), '--seat')
    else if (arg === '--team') args.team = value((i += 1), '--team')
    else if (arg === '--repo') args.repo = value((i += 1), '--repo')
    else if (arg === '--worktree') args.worktree = value((i += 1), '--worktree')
    else if (arg === '--branch') args.branch = value((i += 1), '--branch')
    else if (arg === '--inbox-home') args.inboxHome = value((i += 1), '--inbox-home')
    else if (arg === '--action-log') args.actionLog = value((i += 1), '--action-log')
    else if (arg === '--review-log') args.reviewLog = value((i += 1), '--review-log')
    else if (arg === '--since') args.since = value((i += 1), '--since')
    else if (arg === '--reporter') args.reporter = value((i += 1), '--reporter')
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`)
  }
  return args
}

const USAGE = `usage: review-collect.mjs --seat NAME --team TEAM.yaml [--repo DIR] [--worktree DIR] [--branch BRANCH]
       [--inbox-home DIR] [--action-log FILE] [--review-log FILE] [--since ISO] [--reporter SEAT]
  --team may come from HEDDLE_TEAM_FILE; the review log, action log and reporter default from that record
  the page is read-only; --repo is the clone whose freshly fetched origin/main is the base
  exit 0 with the page, 1 when the seat or a required input is missing`

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
      console.log(USAGE)
      process.exitCode = OK
    } else if (!args.seat) {
      console.error('review-collect: --seat is required')
      process.exitCode = ERROR
    } else {
      console.log(render(collectReview(args)))
      process.exitCode = OK
    }
  } catch (error) {
    console.error(`review-collect: ${error.message}`)
    process.exitCode = ERROR
  }
}
