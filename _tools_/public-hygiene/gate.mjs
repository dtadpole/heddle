#!/usr/bin/env node
// Public-hygiene gate — run before a branch is pushed onto main.
//
//   node _tools_/public-hygiene/gate.mjs                      # origin/main..HEAD
//   node _tools_/public-hygiene/gate.mjs --range REV..REV
//   node _tools_/public-hygiene/gate.mjs --tree HEAD
//
// The repository is public. This gate reads a private list of identifiers that must not
// appear in it, scans what a push would add — added lines, new paths, commit messages
// and commit identities — and prints one plain report without ever echoing a term.
//
//   0  clean
//   1  findings: do not push
//   2  the gate itself cannot run (no list, bad rule, not a repository, bad revision)
//
// The identifier list lives outside the repository; --identifiers or
// HEDDLE_PUBLIC_HYGIENE_FILE names it. One rule per line: a literal (matched
// case-insensitively) or "re:<regex>"; blank lines and lines starting with # are
// ignored. The list is never printed.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const OK = 0
export const FOUND = 1
export const CANNOT_RUN = 2

export const DEFAULT_IDENTIFIERS = join(homedir(), '.config', 'heddle', 'public-hygiene.txt')
export const EXPECTED_IDENTITY = 'D.Tadpole <gsk390@gmail.com>'

// Rules that hold whatever the private list says. They are deliberately narrow: a
// private address is not routable from outside, and a username or hostname belongs in
// the private list, where it can be named exactly. A generic "/Users/<name>" rule is
// not here because a fixture or a placeholder legitimately carries one.
export const BUILTIN_RULES = [
  {
    kind: 'regex',
    source: '(?:^|[^0-9])(?:10\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}|192\\.168\\.[0-9]{1,3}\\.[0-9]{1,3}|172\\.(?:1[6-9]|2[0-9]|3[01])\\.[0-9]{1,3}\\.[0-9]{1,3})(?![0-9])',
    label: 'builtin 1 private IPv4 address',
  },
]

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function parseIdentifiers(text) {
  const rules = []
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const where = `identifier line ${index + 1}`
    let rule
    if (trimmed.startsWith('re:')) {
      rule = { kind: 'regex', source: trimmed.slice(3).trim(), label: `private ${index + 1} regex`, where }
    } else {
      rule = { kind: 'literal', source: escape(trimmed), term: trimmed, label: `private ${index + 1} literal`, where }
    }
    if (!rule.source) throw new Error(`${where}: empty regular expression`)
    let re
    try {
      re = new RegExp(rule.source, 'gi')
    } catch (error) {
      throw new Error(`${where}: ${error.message}`)
    }
    re.lastIndex = 0
    if (re.test('')) throw new Error(`${where}: the rule matches the empty string`)
    re.lastIndex = 0
    rules.push({ ...rule, re })
  })
  return rules
}

export function compileBuiltins() {
  return BUILTIN_RULES.map((rule) => ({ ...rule, re: new RegExp(rule.source, 'gi') }))
}

function redact(line, rule) {
  const replaced = line.replace(rule.re, '[redacted]')
  return replaced.length > 160 ? `${replaced.slice(0, 157)}...` : replaced
}

// D-046: a placeholder UUID identifies nothing. Ignoring the version nibble (the first
// hex digit of the third group) and the variant nibble (the first of the fourth), a UUID
// is a placeholder when at least 29 of its remaining 30 hex digits are one and the same
// digit: the nil UUID, its v4-shaped form 00000000-0000-4000-8000-000000000000, the
// all-ones forms, each with or without one trailing counter digit. A random UUID never
// meets that. Tests must still carry well-formed ids, and building one at runtime to slip
// past the gate is not allowed (D-044), so the gate tells the two apart instead.
const UUID = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi

export function isPlaceholderUuid(text) {
  const hex = String(text).replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) return false
  const rest = hex.slice(0, 12) + hex.slice(13, 16) + hex.slice(17)
  const counts = new Map()
  for (const digit of rest) counts.set(digit, (counts.get(digit) ?? 0) + 1)
  return Math.max(...counts.values()) >= 29
}

// The matches of a rule that count. A match is exempt only when it overlaps at least one
// UUID and every UUID it overlaps is a placeholder; a match on a real UUID, or on text
// with no full UUID in it, is judged exactly as before. The rule is not named by its
// number, because numbers are lines of the private list and move when it is edited.
export function liveMatches(text, rule) {
  const matches = [...text.matchAll(rule.re)]
  if (matches.length === 0) return matches
  const spans = [...text.matchAll(UUID)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    placeholder: isPlaceholderUuid(match[0]),
  }))
  if (spans.length === 0) return matches
  return matches.filter((match) => {
    const start = match.index
    const end = match.index + match[0].length
    const overlapped = spans.filter((span) => span.start < end && start < span.end)
    return overlapped.length === 0 || overlapped.some((span) => !span.placeholder)
  })
}

export function scanText(text, rules, { path = null, firstLine = 1 } = {}) {
  const findings = []
  text.split(/\r?\n/).forEach((line, index) => {
    for (const rule of rules) {
      const matches = liveMatches(line, rule)
      if (matches.length === 0) continue
      findings.push({ kind: 'content', path, line: firstLine + index, rule, excerpt: redact(line, rule) })
    }
  })
  return findings
}

// Added lines of a unified diff with their new-file line numbers; path names are
// returned separately so a leaked name in a file name is a finding of its own.
export function parseDiff(text) {
  const added = []
  const paths = []
  let path = null
  let lineNumber = 0
  for (const raw of text.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4).replace(/\t.*$/, '')
      path = target === '/dev/null' ? null : target.replace(/^b\//, '')
      if (path && !paths.includes(path)) paths.push(path)
      continue
    }
    if (raw.startsWith('@@')) {
      const match = /\+(\d+)(?:,\d+)?\s+@@/.exec(raw)
      lineNumber = match ? Number(match[1]) : 0
      continue
    }
    if (path === null) continue
    if (raw.startsWith('+')) {
      added.push({ path, line: lineNumber, text: raw.slice(1) })
      lineNumber += 1
    } else if (raw.startsWith(' ')) {
      lineNumber += 1
    }
  }
  return { added, paths }
}

const FIELDS = '\x00'
const RECORD = '\x1e'

// git log --format=%H%x00%an <%ae>%x00%cn <%ce>%x00%B%x1e
export function parseLog(text) {
  return text
    .split(RECORD)
    .map((record) => record.replace(/^\n+/, ''))
    .filter(Boolean)
    .map((record) => {
      const fields = record.split(FIELDS)
      const hash = (fields[0] ?? '').trim()
      return {
        hash,
        short: hash.slice(0, 7),
        author: (fields[1] ?? '').trim(),
        committer: (fields[2] ?? '').trim(),
        message: fields.slice(3).join(FIELDS),
      }
    })
    .filter((commit) => commit.hash)
}

export function checkIdentity(commits, expected = EXPECTED_IDENTITY) {
  const findings = []
  for (const commit of commits) {
    const short = commit.short ?? String(commit.hash ?? '').slice(0, 7)
    if (commit.author !== expected) {
      findings.push({ kind: 'identity', commit: short, side: 'author', expected, actual: commit.author })
    }
    if (commit.committer !== expected) {
      findings.push({ kind: 'identity', commit: short, side: 'committer', expected, actual: commit.committer })
    }
  }
  return findings
}

// The report is subject to the same rule: a wrong identity's address must not be
// echoed, so an unexpected value is shown only as a masked string.
const mask = (identity) => {
  const at = identity.indexOf('@')
  return at > 0 ? `${identity.slice(0, 1)}***${identity.slice(at)}` : '<unexpected value>'
}

export function describe(findings) {
  return findings.map((finding) => {
    if (finding.kind === 'content') {
      return `content   ${finding.path}:${finding.line}  ${finding.rule.label}  ${finding.excerpt}`
    }
    if (finding.kind === 'path') {
      const path = finding.path.replace(finding.rule.re, '[redacted]')
      return `path      ${path}  ${finding.rule.label}`
    }
    if (finding.kind === 'message') {
      return `message   ${finding.commit}:${finding.line}  ${finding.rule.label}  ${finding.excerpt}`
    }
    return `identity  ${finding.commit.slice(0, 7)} ${finding.side} ${mask(finding.actual)} is not ${finding.expected}`
  })
}

function git(args, cwd, { allowFailure = false, input } = {}) {
  // cat-file --batch reads and writes bytes, so it gets no encoding; the text commands
  // ask for utf8.
  const options = { cwd, input, maxBuffer: 256 * 1024 * 1024 }
  if (input === undefined) options.encoding = 'utf8'
  const result = spawnSync('git', args, options)
  if (result.error) throw new Error(`git ${args[0]} could not run: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.slice(0, 2).join(' ')} failed: ${String(result.stderr || '').trim()}`)
  }
  return result
}

function parseBatch(buffer) {
  const blobs = []
  let at = 0
  while (at < buffer.length) {
    const newline = buffer.indexOf(0x0a, at)
    if (newline < 0) break
    const header = buffer.slice(at, newline).toString('utf8').trim()
    at = newline + 1
    const fields = header.split(' ')
    if (fields.length !== 3) throw new Error(`unexpected cat-file header ${JSON.stringify(header)}`)
    const [, type, sizeText] = fields
    const size = Number(sizeText)
    if (!Number.isFinite(size)) throw new Error(`unexpected cat-file size in ${JSON.stringify(header)}`)
    const content = buffer.slice(at, at + size)
    at += size + 1
    blobs.push({ type, content })
  }
  return blobs
}

export function readTree(rev, cwd) {
  const listing = git(['ls-tree', '-r', '-z', '--name-only', rev], cwd).stdout
  const paths = listing.split('\0').filter(Boolean)
  if (paths.length === 0) return []
  const input = `${paths.map((path) => `${rev}:${path}`).join('\n')}\n`
  const output = git(['cat-file', '--batch'], cwd, { input })
  const blobs = parseBatch(output.stdout)
  if (blobs.length !== paths.length) throw new Error(`read ${blobs.length} of ${paths.length} objects at ${rev}`)
  return paths.map((path, index) => ({ path, blob: blobs[index].type === 'blob' ? blobs[index].content : null }))
}

export function scanRange({ cwd, range, rules, expectedIdentity = EXPECTED_IDENTITY }) {
  const commits = parseLog(git(['log', `--format=%H%x00%an <%ae>%x00%cn <%ce>%x00%B%x1e`, range], cwd).stdout)
  // What the range brings in is the change since the merge base (A...B). The tree diff
  // (A..B) also shows, reversed, every change main made after a behind branch forked, and
  // reported main's own fixes as lines the branch adds.
  const diffRange = /\.\.\./.test(range) ? range : range.replace('..', '...')
  const diffText = git(['diff', '--no-color', '--unified=0', '--find-renames', diffRange, '--'], cwd).stdout
  const diff = parseDiff(diffText)

  const findings = []
  for (const path of diff.paths) {
    for (const rule of rules) {
      if (liveMatches(path, rule).length > 0) findings.push({ kind: 'path', path, rule })
    }
  }
  for (const line of diff.added) {
    findings.push(...scanText(line.text, rules, { path: line.path, firstLine: line.line }).map((finding) => ({
      ...finding,
      line: line.line,
    })))
  }
  for (const commit of commits) {
    for (const finding of scanText(commit.message, rules)) {
      findings.push({ kind: 'message', commit: commit.short, line: finding.line, rule: finding.rule, excerpt: finding.excerpt })
    }
  }
  if (expectedIdentity) findings.push(...checkIdentity(commits, expectedIdentity))
  return { commits, files: diff.paths.length, findings }
}

export function scanTree({ cwd, rev, rules }) {
  const commits = parseLog(git(['log', '-1', '--format=%H%x00%an <%ae>%x00%cn <%ce>%x00%B%x1e', rev], cwd).stdout)
  const findings = []
  const entries = readTree(rev, cwd)
  for (const { path, blob } of entries) {
    for (const rule of rules) {
      if (liveMatches(path, rule).length > 0) findings.push({ kind: 'path', path, rule })
    }
    if (!blob || blob.includes(0)) continue // binary: its name was judged, its bytes are not text
    findings.push(...scanText(blob.toString('utf8'), rules, { path }))
  }
  return { commits, files: entries.length, findings }
}

function parseArgs(argv) {
  const args = { range: 'origin/main..HEAD', tree: null, identifiers: null, identity: EXPECTED_IDENTITY, builtins: true }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--range') args.range = argv[++i]
    else if (arg === '--tree') args.tree = argv[++i] || 'HEAD'
    else if (arg === '--identifiers') args.identifiers = argv[++i]
    else if (arg === '--author') args.identity = argv[++i]
    else if (arg === '--no-identity') args.identity = null
    else if (arg === '--no-builtin') args.builtins = false
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`)
  }
  return args
}

const USAGE = `usage: gate.mjs [--range REV] [--tree [REV]] [--identifiers FILE] [--author "Name <email>"] [--no-identity] [--no-builtin]
  --range      commits and added lines to judge (default origin/main..HEAD)
  --tree [REV] every text file and path at REV (default HEAD)
  --identifiers  private identifier list (default $HEDDLE_PUBLIC_HYGIENE_FILE or ~/.config/heddle/public-hygiene.txt)
  exit 0 clean, 1 findings, 2 the gate cannot run`

export function main(argv, env = process.env, cwd = process.cwd()) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    console.error(`public-hygiene: ${error.message}`)
    console.error(USAGE)
    return CANNOT_RUN
  }
  if (args.help) {
    console.log(USAGE)
    return OK
  }

  const top = git(['rev-parse', '--show-toplevel'], cwd, { allowFailure: true })
  if (top.status !== 0) {
    console.error('public-hygiene: not inside a git repository')
    return CANNOT_RUN
  }
  // Resolve symlinks: on this Mac /var is a link to /private/var, and the list path and
  // the repository root must be compared as the same spelling.
  const root = realpathSync(top.stdout.trim())

  const asked = resolve(args.identifiers ?? env.HEDDLE_PUBLIC_HYGIENE_FILE ?? DEFAULT_IDENTIFIERS)
  const listPath = existsSync(asked) ? realpathSync(asked) : join(realpathSync(dirname(asked)), basename(asked))
  if (listPath === root || listPath.startsWith(`${root}${sep}`)) {
    console.error(`public-hygiene: the identifier list must live outside the repository, not at ${listPath}`)
    return CANNOT_RUN
  }
  if (!existsSync(listPath)) {
    console.error(`public-hygiene: no identifier list at ${listPath}; set HEDDLE_PUBLIC_HYGIENE_FILE or --identifiers`)
    return CANNOT_RUN
  }
  let rules
  try {
    rules = parseIdentifiers(readFileSync(listPath, 'utf8'))
  } catch (error) {
    console.error(`public-hygiene: ${error.message}`)
    return CANNOT_RUN
  }
  if (rules.length === 0) {
    console.error(`public-hygiene: ${listPath} has no rules; an empty gate is not a gate`)
    return CANNOT_RUN
  }
  const builtins = args.builtins ? compileBuiltins() : []
  const allRules = [...rules, ...builtins]
  const privateCount = rules.length

  let result
  try {
    result = args.tree
      ? scanTree({ cwd, rev: args.tree, rules: allRules })
      : scanRange({ cwd, range: args.range, rules: allRules, expectedIdentity: args.identity })
  } catch (error) {
    console.error(`public-hygiene: ${error.message}`)
    return CANNOT_RUN
  }

  const where = args.tree ? `tree ${args.tree}` : `range ${args.range}`
  console.log(`public-hygiene: ${where}, ${result.commits.length} commit(s), ${result.files} file(s), ${privateCount} private rule(s), ${builtins.length} built-in rule(s)`)
  if (result.findings.length === 0) {
    console.log('ok: nothing to flag; main can take this')
    return OK
  }
  for (const line of describe(result.findings)) console.error(line)
  console.log(`FAIL ${result.findings.length} finding(s); do not push main`)
  return FOUND
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
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`public-hygiene: ${error.message}`)
    process.exitCode = CANNOT_RUN
  }
}
