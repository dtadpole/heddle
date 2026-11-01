import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { heldBy } from '../../sweep-lib.mjs'
import { isScratchWorktree, sweep, sweepWorktrees } from '../../tmp-sweep.mjs'

// Every test sweeps a folder of its own, never the real TMPDIR.
const SCRIPT = join(import.meta.dirname, '..', '..', 'tmp-sweep')
const NOW = Date.UTC(2026, 9, 29, 15, 0, 0)
const hoursAgo = (h) => new Date(NOW - h * 3_600_000)

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tmp-sweep-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** An entry aged `h` hours: a folder with one file, or a file. Children are aged too. */
function entry(dir, name, h, { file = false } = {}) {
  const p = join(dir, name)
  if (file) writeFileSync(p, 'x')
  else {
    mkdirSync(p)
    writeFileSync(join(p, 'inner'), 'x')
    utimesSync(join(p, 'inner'), hoursAgo(h), hoursAgo(h))
  }
  utimesSync(p, hoursAgo(h), hoursAgo(h))
  return p
}

test('stale entries of every kind go, testers\' Chrome profiles and hidden Chrome files included; others stay', (t) => {
  const dir = folder(t)
  const gone = [
    entry(dir, 'heddle-server-test-views-ab12', 3),
    entry(dir, 'hd-developer-five-browser-x1', 3),
    entry(dir, 'hd5-live-profile-1730361600-a', 3),
    entry(dir, 'hd-live-profile-b', 3),
    entry(dir, 'round104-chrome-profile-q9', 3),
    entry(dir, 'scoped_dir1234_567', 3),
    entry(dir, 'com.google.Chrome.abc', 3, { file: true }),
    entry(dir, '.com.google.Chrome.002LhB', 3, { file: true }),
  ]
  const kept = [
    entry(dir, 'com.apple.launchd.x', 30),
    entry(dir, 'heddlefoo', 30),
    entry(dir, 'my-notes', 30, { file: true }),
    entry(dir, 'hd5-live-notes', 30), // no -live-profile
    entry(dir, 'chrome-profile', 30), // no hyphen before chrome-profile
    entry(dir, '.com.apple.x', 30, { file: true }),
  ]
  const r = sweep({ dir, now: NOW, commands: '' })
  assert.deepEqual(r.removed, {
    'heddle-*': 1,
    'hd-*-browser-*': 1,
    'hd*-live-profile*': 2,
    '*-chrome-profile*': 1,
    'scoped_dir*': 1,
    'com.google.Chrome*': 1,
    '.com.google.Chrome*': 1,
  })
  for (const p of gone) assert.equal(existsSync(p), false, p)
  for (const p of kept) assert.equal(existsSync(p), true, p)
})

test('a young or live tester profile stays: age and the process list judge every kind', (t) => {
  const dir = folder(t)
  const young = entry(dir, 'hd5-live-profile-young', 1)
  const live = entry(dir, 'hd5-live-profile-live', 5)
  const r = sweep({ dir, now: NOW, commands: `/Applications/Chrome --user-data-dir=${live} --headless\n` })
  assert.deepEqual(r.removed, {})
  assert.equal(r.tooNew, 1)
  assert.equal(r.inUse, 1)
  assert.equal(existsSync(young), true)
  assert.equal(existsSync(live), true)
})

test('after the sweep it prints the folder\'s total, entry count and five largest entries, files and folders alike', (t) => {
  const dir = folder(t)
  const big = (name, mib) => {
    mkdirSync(join(dir, name))
    writeFileSync(join(dir, name, 'blob'), Buffer.alloc(mib * 1024 * 1024))
  }
  big('a-folder', 4)
  writeFileSync(join(dir, 'b-file'), Buffer.alloc(3 * 1024 * 1024)) // a top-level file: du -d 1 lists none
  big('c-folder', 2)
  writeFileSync(join(dir, '.d-hidden'), Buffer.alloc(1024 * 1024))
  for (const name of ['e', 'f', 'g']) writeFileSync(join(dir, name), 'x')
  const r = spawnSync(SCRIPT, ['--dry-run', '--dir', dir, '--no-caches'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const line = r.stdout.split('\n').find((l) => l.includes(' holds '))
  assert.match(line, /^tmp-sweep: .+ holds 10 MiB in 7 entries; largest: 4 MiB a-folder, 3 MiB b-file, 2 MiB c-folder, 1 MiB \.d-hidden, \d+ KiB e$/)
  assert.equal(spawnSync(SCRIPT, ['--dir', join(dir, 'missing'), '--no-caches'], { encoding: 'utf8' }).stdout.includes('sizes unknown (du failed)'), true)
})

test('an entry younger than the age stays, including a folder with a fresh file inside', (t) => {
  const dir = folder(t)
  const young = entry(dir, 'heddle-young', 1)
  const busy = entry(dir, 'heddle-busy', 5)
  writeFileSync(join(busy, 'just-written'), 'x') // a child written now: still in use
  utimesSync(join(busy, 'just-written'), hoursAgo(0.1), hoursAgo(0.1))
  utimesSync(busy, hoursAgo(5), hoursAgo(5))
  const r = sweep({ dir, now: NOW, commands: '' })
  assert.equal(r.tooNew, 2)
  assert.equal(existsSync(young), true)
  assert.equal(existsSync(busy), true)
  assert.equal(sweep({ dir, now: NOW, ageMinutes: 30, commands: '' }).removed['heddle-*'], 1, 'a shorter age takes the young one')
})

test('an entry a running process names (a live browser profile) stays', (t) => {
  const dir = folder(t)
  const profile = entry(dir, 'hd-developer-two-browser-live', 5)
  const r = sweep({ dir, now: NOW, commands: `/Applications/Chrome --user-data-dir=${profile} --headless\n` })
  assert.equal(r.inUse, 1)
  assert.equal(existsSync(profile), true)
})

test('--dry-run lists and removes nothing; the command reports by kind', (t) => {
  const dir = folder(t)
  const p = entry(dir, 'heddle-check-browser-q', 30 * 24) // a month old: well past any age
  const dry = spawnSync(SCRIPT, ['--dry-run', '--dir', dir, '--no-caches'], { encoding: 'utf8' })
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(
    dry.stdout,
    /would remove 1 \(heddle-\* 1, hd-\*-browser-\* 0, hd\*-live-profile\* 0, \*-chrome-profile\* 0, scoped_dir\* 0, com\.google\.Chrome\* 0, \.com\.google\.Chrome\* 0\)/,
  )
  assert.equal(existsSync(p), true)
  const real = spawnSync(SCRIPT, ['--dir', dir, '--no-caches'], { encoding: 'utf8' })
  assert.equal(real.status, 0, real.stderr)
  assert.match(real.stdout, /removed 1 \(heddle-\* 1/)
  assert.equal(existsSync(p), false)
  assert.equal(spawnSync(SCRIPT, ['--age-minutes', 'soon'], { encoding: 'utf8' }).status, 64)
})

test('it reports the npm and uv cache sizes from the settings npm and uv read, and removes nothing there', (t) => {
  const dir = folder(t)
  const npm = join(dir, 'npm-cache')
  const xdg = join(dir, 'xdg')
  mkdirSync(join(npm, '_cacache'), { recursive: true })
  writeFileSync(join(npm, '_cacache', 'blob'), Buffer.alloc(3 * 1024 * 1024))
  utimesSync(join(npm, '_cacache', 'blob'), hoursAgo(30 * 24), hoursAgo(30 * 24)) // a month old: stays anyway
  const env = { PATH: process.env.PATH, HOME: dir, npm_config_cache: npm, XDG_CACHE_HOME: xdg }
  const r = spawnSync(SCRIPT, ['--dir', folder(t)], { encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stderr)
  const line = r.stdout.split('\n').find((l) => l.includes('caches'))
  assert.equal(line, `tmp-sweep: caches, sizes only, never removed: npm cache 3 MiB (${npm}), uv cache absent (${join(xdg, 'uv')})`)
  assert.equal(existsSync(join(npm, '_cacache', 'blob')), true)

  mkdirSync(join(dir, 'uv-explicit'))
  const uv = spawnSync(SCRIPT, ['--dir', folder(t)], { encoding: 'utf8', env: { ...env, UV_CACHE_DIR: join(dir, 'uv-explicit') } })
  assert.match(uv.stdout, new RegExp(`uv cache 0 KiB \\(${join(dir, 'uv-explicit')}\\)`), 'UV_CACHE_DIR wins over XDG_CACHE_HOME')
  const plain = spawnSync(SCRIPT, ['--dir', folder(t), '--no-caches'], { encoding: 'utf8', env })
  assert.equal(plain.status, 0)
  assert.doesNotMatch(plain.stdout, /caches/)
  const home = spawnSync(SCRIPT, ['--dir', folder(t)], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } })
  assert.match(home.stdout, new RegExp(`npm cache absent \\(${join(dir, '.npm')}\\), uv cache absent \\(${join(dir, '.cache', 'uv')}\\)`))
})

// --worktrees: a scratch repository stands in for ~/heddle, and a scratch folder for /private/tmp.
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
for (const k of Object.keys(GIT_ENV)) if (k.startsWith('GIT_') && !k.startsWith('GIT_AUTHOR') && !k.startsWith('GIT_COMMITTER')) delete GIT_ENV[k]
const git = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const NO_HOLDS = { commands: '', paths: [] }

/** Ages a worktree: its folder, its git admin folder and their direct children, `h` hours back from the real clock. */
function ageWorktree(wt, h) {
  const at = new Date(Date.now() - h * 3_600_000)
  const admin = readFileSync(join(wt, '.git'), 'utf8').match(/^gitdir: (.+)$/m)[1].trim()
  for (const d of [wt, admin]) {
    for (const child of readdirSync(d)) utimesSync(join(d, child), at, at)
    utimesSync(d, at, at)
  }
}

/** A repository `heddle` with one pushed commit (origin/pushed) and one local commit on `local`, plus a tmp root. */
function scratchRepo(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tmp-sweep-wt-test-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'heddle')
  mkdirSync(repo)
  git(repo, 'init', '-q', '--initial-branch=main')
  writeFileSync(join(repo, 'f.txt'), 'one\n')
  writeFileSync(join(repo, '.gitignore'), 'target/\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'one')
  const pushed = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'update-ref', 'refs/remotes/origin/pushed', pushed)
  git(repo, 'checkout', '-q', '-b', 'local')
  writeFileSync(join(repo, 'f.txt'), 'two\n')
  git(repo, 'commit', '-q', '-am', 'two, never pushed')
  git(repo, 'checkout', '-q', 'main')
  const tmp = join(root, 'tmp')
  mkdirSync(tmp)
  // add(path): detached at the pushed commit; add(path, 'local'): the unpushed branch; add(path, 'new:<b>'): a new branch <b>.
  const add = (path, ref) => {
    if (!ref) git(repo, 'worktree', 'add', '-q', '--detach', path, pushed)
    else if (ref.startsWith('new:')) git(repo, 'worktree', 'add', '-q', '-b', ref.slice(4), path, pushed)
    else git(repo, 'worktree', 'add', '-q', path, ref)
    return path
  }
  return { root, repo, tmp, pushed, add }
}

test('--worktrees removes an old, clean, unused scratch worktree whose HEAD is pushed, and keeps every other kind', (t) => {
  const { root, repo, tmp, add } = scratchRepo(t)
  const oldPushed = add(join(tmp, 'old-pushed'))
  mkdirSync(join(oldPushed, 'target', 'debug'), { recursive: true })
  writeFileSync(join(oldPushed, 'target', 'debug', 'bin'), 'ignored build output') // ignored: no obstacle
  const sibling = add(join(root, 'heddle--developer-x-extra'), 'new:hd/developer-x-extra')
  const young = add(join(tmp, 'young'))
  const dirty = add(join(tmp, 'dirty'))
  writeFileSync(join(dirty, 'f.txt'), 'edited by hand\n')
  const untracked = add(join(tmp, 'untracked'))
  writeFileSync(join(untracked, 'notes.md'), 'a new file\n')
  const unpushed = add(join(tmp, 'unpushed'), 'local')
  const open = add(join(tmp, 'open'))
  const named = add(join(tmp, 'named'))
  const locked = add(join(tmp, 'locked'))
  git(repo, 'worktree', 'lock', locked)
  const outer = add(join(tmp, 'outer'))
  const inner = add(join(outer, 'inner'))
  const seat = add(join(root, 'heddle--developer-x')) // a seat's own worktree: never a candidate
  const elsewhere = add(join(root, 'elsewhere')) // neither under the tmp root nor a sibling
  const gone = add(join(tmp, 'gone'))
  for (const wt of [oldPushed, sibling, dirty, untracked, unpushed, open, named, locked, outer, seat, elsewhere]) ageWorktree(wt, 5)
  rmSync(gone, { recursive: true, force: true }) // removed by hand: only its entry is left, for prune
  const switched = add(join(tmp, 'switched')) // an old folder, but git wrote its admin folder just now (a checkout)
  ageWorktree(switched, 5)
  const admin = readFileSync(join(switched, '.git'), 'utf8').match(/^gitdir: (.+)$/m)[1].trim()
  utimesSync(join(admin, 'HEAD'), new Date(), new Date())
  const holds = {
    paths: [join(open, 'src', 'main.rs'), `${oldPushed}-other/file`],
    commands: `node ${named}/server.mjs\nvim ${oldPushed}2/x\n`, // old-pushed2 is not old-pushed
  }
  const r = sweepWorktrees({ repo, tmpRoot: tmp, holds })
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.removed.map((w) => w.path).sort(), [oldPushed, sibling].sort())
  assert.equal(r.removed.find((w) => w.path === sibling).branch, 'hd/developer-x-extra')
  assert.equal(r.removed.find((w) => w.path === oldPushed).remote, 'origin/pushed')
  assert.deepEqual(Object.fromEntries(r.kept.map((k) => [k.path, k.reason])), {
    [dirty]: 'uncommitted changes',
    [untracked]: 'uncommitted changes',
    [unpushed]: 'HEAD not on a remote branch',
    [open]: 'in use (open file)',
    [named]: 'in use (command line)',
    [locked]: 'locked',
    [outer]: 'holds another worktree',
  })
  assert.equal(r.young, 3, 'young, inner, and switched by its admin folder')
  assert.equal(r.pruned, 1, 'the entry of the folder removed by hand')
  for (const p of [oldPushed, sibling]) assert.equal(existsSync(p), false, p)
  for (const p of [young, dirty, untracked, unpushed, open, named, locked, outer, inner, seat, elsewhere, switched]) assert.equal(existsSync(p), true, p)
  const listed = git(repo, 'worktree', 'list', '--porcelain')
  for (const p of [oldPushed, sibling, gone]) assert.equal(listed.includes(`worktree ${p}\n`), false, p)
  assert.equal(git(repo, 'branch', '--list', 'hd/developer-x-extra'), 'hd/developer-x-extra', 'the branch outlives its worktree')
  assert.equal(readFileSync(join(dirty, 'f.txt'), 'utf8'), 'edited by hand\n')
})

test('--worktrees with --dry-run removes and prunes nothing; without a process list it removes nothing', (t) => {
  const { repo, tmp, add } = scratchRepo(t)
  const old = add(join(tmp, 'old'))
  const gone = add(join(tmp, 'gone'))
  ageWorktree(old, 5)
  rmSync(gone, { recursive: true, force: true })
  const dry = sweepWorktrees({ repo, tmpRoot: tmp, holds: NO_HOLDS, dryRun: true })
  assert.deepEqual(dry.removed.map((w) => w.path), [old])
  assert.equal(dry.pruned, 1)
  assert.equal(existsSync(old), true)
  assert.match(git(repo, 'worktree', 'list'), /gone/, 'a dry run prunes nothing')
  const blind = sweepWorktrees({ repo, tmpRoot: tmp, holds: null })
  assert.deepEqual(blind.removed, [])
  assert.match(blind.errors[0], /process list .* could not be read/)
  assert.equal(existsSync(old), true)
  assert.equal(sweepWorktrees({ repo, tmpRoot: tmp, holds: NO_HOLDS, ageMinutes: 600 }).young, 1, 'a longer age keeps it')
  assert.equal(existsSync(old), true)
})

test('scratch worktrees are the tmp root\'s and the heddle--developer-*-* siblings, never the main or a seat\'s own', () => {
  const main = '/Users/u/heddle'
  assert.equal(isScratchWorktree('/private/tmp/hd12-img', main, '/private/tmp'), true)
  assert.equal(isScratchWorktree('/Users/u/heddle--developer-eight-b10', main, '/private/tmp'), true)
  assert.equal(isScratchWorktree('/Users/u/heddle--developer-eight', main, '/private/tmp'), false)
  assert.equal(isScratchWorktree('/Users/u/heddle--integrator-one', main, '/private/tmp'), false)
  assert.equal(isScratchWorktree('/Users/u/heddle--developer-twelve/.worktrees/a-b', main, '/private/tmp'), false)
  assert.equal(isScratchWorktree('/private/tmpx/a', main, '/private/tmp'), false)
  assert.equal(isScratchWorktree(main, main, '/private/tmp'), false)
})

test('a holder must name the whole path: an open file inside, or a command line naming it, not a longer name', (t) => {
  const dir = realpathSync(folder(t))
  const wt = join(dir, 'd1-80s1')
  mkdirSync(wt)
  assert.equal(heldBy(wt, { paths: [join(dir, 'd1-80s16', 'x')], commands: `cd ${dir}/d1-80s16 && make` }), null)
  assert.equal(heldBy(wt, { paths: [wt], commands: '' }), 'open file', 'its working folder')
  assert.equal(heldBy(wt, { paths: [join(wt, 'a', 'b')], commands: '' }), 'open file')
  assert.equal(heldBy(wt, { paths: [], commands: `chrome --user-data-dir=${wt}/profile` }), 'command line')
  assert.equal(heldBy(wt, { paths: [], commands: `cargo test '${wt}'` }), 'command line')
})

test('the command line sweeps worktrees with --worktrees and the real process list, and reports each one', (t) => {
  const { root, repo, add } = scratchRepo(t)
  const sibling = add(join(root, 'heddle--developer-x-old'))
  const dirty = add(join(root, 'heddle--developer-x-dirty'))
  writeFileSync(join(dirty, 'f.txt'), 'edited\n')
  ageWorktree(sibling, 3)
  ageWorktree(dirty, 3)
  const r = spawnSync(SCRIPT, ['--worktrees', '--repo', repo, '--dir', folder(t), '--no-caches'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, new RegExp(`worktrees of ${repo}: removed 1; kept 0 younger than the age, 1 uncommitted changes; pruned 0 stale entries; disk [\\d.]+ GiB free before, [\\d.]+ after`))
  assert.match(r.stdout, new RegExp(`  removed ${sibling} \\(detached, idle 3h0\\d, HEAD on origin/pushed\\)`))
  assert.match(r.stdout, new RegExp(`  kept ${dirty} \\(detached\\): uncommitted changes`))
  assert.equal(existsSync(sibling), false)
  assert.equal(spawnSync(SCRIPT, ['--dir', folder(t), '--no-caches'], { encoding: 'utf8' }).stdout.includes('worktrees of'), false, 'only with --worktrees')
  assert.equal(spawnSync(SCRIPT, ['--worktrees', '--repo'], { encoding: 'utf8' }).status, 64)
})
