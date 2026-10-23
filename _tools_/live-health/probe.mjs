#!/usr/bin/env node
/**
 * One live-health pass over the team's live address, `http://127.0.0.1:8082/`.
 *
 * ## What is actually behind that address, measured 2026-10-22
 *
 * `8082` is the **heddle Web Gate** (`~/nexus/_projects_/dsh-web-ops/_tools_/heddle-web-gate/`), a
 * loopback-only proxy that reads the deployment's current launch token from `~/.heddle/web.log`,
 * exchanges it for heddle's own authority-bound cookie, and forwards the call to the deployed server
 * on `127.0.0.1:3082`. The owner's URL therefore carries no token, and the token claim belongs to the
 * deployed server's own door. This pass judges both, because the two break differently:
 *
 * - **gate** — `8082/` answers the app shell. When the deployment is down the gate answers `502` and
 *   says so (`heddle-proxy: the upstream did not answer …`), which is the page the owner would see;
 *   the probe keeps that sentence as evidence instead of reporting a bare status.
 * - **door** — the deployed server on its own origin refuses a bare request with `401` and the token
 *   form, and its current launch URL (`~/.heddle/web.log`, the same source the gate reads) exchanges
 *   for an `HttpOnly`, `SameSite=Strict` cookie on a `303`. That is load-with-token; the browser then
 *   loads the app **through the gate**, which is how the owner's address really gets in.
 * - **marker** — the served document carries `meta[name=heddle-page]`, the first twelve hex of the
 *   sha256 of the built `dist/server/page.html` (`markedPage` in `src/server/web.ts`). The expected
 *   value is computed from the **deployment checkout's own file**, so a match proves the served page
 *   is this checkout's build. A mismatch is the stale-build failure that looks like a missing feature.
 *   The checkout's HEAD against `origin/main`'s tip is recorded beside it as staleness, not as failure.
 * - **turn** — one short prompt typed with trusted input on the loaded page; the pass records the user
 *   row, the assistant text lengths as they grew (the deltas), and the time to first delta and settle.
 * - **console** — error-level messages fail; warnings are recorded. Read on load and again after the
 *   turn, so a load error and a turn error are not confused.
 * - **DSH** — the reference at `127.0.0.1:8080/`: title, `window.__DSH_BOOT__` keys, a composer, and
 *   its console errors. Numbers only: a screenshot carries the owner's workspaces and session names,
 *   and this repository is public.
 *
 * **Read-only on everything it judges.** It reads `~/heddle-live` with `git` and `sha256` and
 * `~/.heddle/web.log` (mode 600, the token source the gate itself uses), and writes nothing into
 * either. Its only write is the pinned JSONL under `_context_/rust-port/`, in this seat's worktree.
 *
 * **The browser is browser-use, in this seat's own session.** `--session=hd-live-monitor` gives the
 * pass its own browser, profile and tabs, headless, so it shares neither a page nor a cookie jar with
 * another seat's browser.
 *
 * Usage:
 *   _tools_/live-health/probe.mjs                     # one pass, summary, exit 0/1/3
 *   _tools_/live-health/probe.mjs --json --pin        # append the pass to the pinned JSONL
 *   _tools_/live-health/probe.mjs --no-turn           # judge the page, do not spend a turn
 *   _tools_/live-health/probe.mjs --log=~/.heddle/web.log --deploy=~/heddle-live
 *
 * Exit: 0 when every judged check passes, 1 when one fails, 3 when the address answers nothing and the
 * pass cannot be judged (the project's verifier contract: unjudged is never passing).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const JSONL = join(REPO, '_context_', 'rust-port', 'live-health.jsonl')

/** Arguments are `--name=value`, or a bare `--flag`. No parser dependency, no second vocabulary. */
function parseArguments(argv) {
  const named = {}
  for (const argument of argv) {
    if (!argument.startsWith('--')) continue
    const equals = argument.indexOf('=')
    if (equals === -1) named[argument.slice(2)] = true
    else named[argument.slice(2, equals)] = argument.slice(equals + 1)
  }
  return named
}

const options = parseArguments(process.argv.slice(2))
/** Expand a leading `~`, because the paths this team agrees on are written that way. */
const expand = (path) => (path.startsWith('~') ? join(homedir(), path.slice(1)) : path)
const say = (line) => process.stdout.write(`${line}\n`)

const URL_GATE = options.url ?? 'http://127.0.0.1:8082/'
const URL_DSH = options.dsh ?? 'http://127.0.0.1:8080/'
const DEPLOY_ROOT = expand(options.deploy ?? '~/heddle-live')
const LOG_FILE = expand(options.log ?? '~/.heddle/web.log')
const SESSION = options.session ?? 'hd-live-monitor'
const SEND_TURN = options['no-turn'] !== true

/** The browser is a child of this pass, but its session outlives it: that is the tool's design. */
process.env.HEDDLE_BROWSER_SESSION = SESSION
const browser = await import(join(REPO, '_tools_', 'browser-use', 'client.mjs'))
const callTool = (tool, args = {}, timeoutMs = 45_000) => browser.callTool(tool, args, { headless: true, timeoutMs })

/** A git answer from a checkout, or null when it is not one. Never throws into the pass. */
function gitAt(root, ...args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/**
 * The deployment's current launch URL, from the log the gate itself reads.
 *
 * The last `heddle web: http://…?token=…` line is the live process's; an older line's token is stale
 * by design (a launch token is per process), so reading the log the way the gate does is what makes
 * the pass judge the same credential the owner's URL is served with.
 */
function readLaunchUrl() {
  if (typeof options.token === 'string' && options.token.length > 0) return options.token
  if (!existsSync(LOG_FILE)) return null
  const matches = [...readFileSync(LOG_FILE, 'utf8').matchAll(/heddle web: (http:\/\/\S+)/g)]
  return matches.length > 0 ? matches[matches.length - 1][1] : null
}

const launchUrl = readLaunchUrl()
/** The deployed server's own origin (`http://127.0.0.1:3082`), where the token door lives. */
const serverOrigin = launchUrl === null ? null : (() => {
  try {
    return new URL(launchUrl).origin
  } catch {
    return null
  }
})()

const deployment = (() => {
  const head = gitAt(DEPLOY_ROOT, 'rev-parse', 'HEAD')
  const branch = gitAt(DEPLOY_ROOT, 'rev-parse', '--abbrev-ref', 'HEAD')
  const dirty = gitAt(DEPLOY_ROOT, 'status', '--porcelain')
  const mainTip = gitAt(REPO, 'rev-parse', 'origin/main')
  const behind = head !== null && mainTip !== null ? Number(gitAt(DEPLOY_ROOT, 'rev-list', '--count', `${head}..${mainTip}`) ?? 0) : null
  const pagePath = join(DEPLOY_ROOT, 'dist', 'server', 'page.html')
  const built = existsSync(pagePath) ? readFileSync(pagePath) : null
  return {
    root: DEPLOY_ROOT,
    head,
    headShort: head?.slice(0, 12) ?? null,
    branch,
    dirty: dirty === null ? null : dirty === '' ? 0 : dirty.split('\n').length,
    mainTip,
    mainTipShort: mainTip?.slice(0, 12) ?? null,
    behind,
    pagePath,
    /** The marker the served document must carry, computed from this checkout's built page. */
    expectedMarker: built === null ? null : createHash('sha256').update(built).digest('hex').slice(0, 12),
  }
})()

/** Everything the pass reads off one page, in one evaluation. */
const PAGE_FACTS = `() => ({
  title: document.title,
  url: location.href,
  log: document.querySelector('#log') !== null,
  composer: document.querySelector('#prompt textarea') !== null,
  send: document.querySelector('#send') !== null,
  marker: document.querySelector('meta[name="heddle-page"]')?.getAttribute('content') ?? null,
  shell: document.body.innerHTML.length,
  tokenForm: /launch token is required|not the current one/i.test(document.body.innerText),
  userTurns: document.querySelectorAll('#log .turn.user').length,
  assistantTurns: document.querySelectorAll('#log .turn.assistant').length,
  notices: [...document.querySelectorAll('#log .turn-notice, #log [role="alert"]')].map((node) => node.innerText.trim()).slice(0, 3),
  assistantLengths: [...document.querySelectorAll('#log .turn.assistant')].map((node) => (node.textContent ?? '').length),
  assistantRunning: [...document.querySelectorAll('#log .turn.assistant')].some((node) => node.dataset.state === 'running'),
})`

/** The page's facts, or null when the page cannot be read (mid-navigation, closed). */
async function factsOf(pageId) {
  try {
    return (await callTool('evaluate_script', { pageId, function: PAGE_FACTS }, 15_000))?.value ?? null
  } catch {
    return null
  }
}

/** Wait until a selector exists on the page. Returns true when it appeared. */
async function waitFor(pageId, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const answer = await callTool('evaluate_script', { pageId, function: `() => document.querySelector(${JSON.stringify(selector)}) !== null` }, 15_000)
      if (answer?.value === true) return true
    } catch {
      // A page mid-start has no execution context yet; the next poll is the honest retry.
    }
    await new Promise((done) => setTimeout(done, 200))
  }
  return false
}

/** Console messages as the tool reports them. */
async function consoleMessages(pageId) {
  const answer = await callTool('list_console_messages', { pageId, includePreservedMessages: true }, 20_000)
  return Array.isArray(answer?.messages) ? answer.messages : []
}

const pass = {
  at: new Date().toISOString(),
  session: SESSION,
  ...(typeof options.note === 'string' && options.note.length > 0 ? { note: options.note } : {}),
  gate: URL_GATE,
  serverOrigin,
  deployment,
  checks: {},
  dsh: null,
}

/** 1. The gate serves the app. A 502 is the gate saying its upstream is gone, and its sentence is kept. */
async function judgeGate() {
  try {
    const response = await fetch(URL_GATE, { redirect: 'manual', signal: AbortSignal.timeout(8_000) })
    const body = await response.text()
    const firstLine = body.split('\n').find((line) => line.trim().length > 0)?.trim().slice(0, 200) ?? ''
    const app = /id="log"/.test(body)
    const proxyError = /heddle-proxy/i.test(body)
    const verdict = response.status === 200 && app ? 'pass' : 'fail'
    return {
      status: response.status,
      app,
      proxyError,
      firstLine: proxyError ? firstLine : undefined,
      verdict,
      detail:
        verdict === 'pass'
          ? 'the gate served the app shell'
          : proxyError
            ? `the gate could not reach the deployment: ${firstLine}`
            : `the gate answered ${response.status} without the app shell${firstLine ? `: ${firstLine}` : ''}`,
    }
  } catch (error) {
    return { status: null, verdict: 'fail', detail: `the gate does not answer: ${error.message}` }
  }
}

/** 2. The deployed server's own door: 401 without a credential, a 303 exchange with the current token. */
async function judgeDoor() {
  if (serverOrigin === null) {
    return { verdict: 'unjudged', detail: `no launch URL in ${LOG_FILE}, so the deployed server's own token door cannot be judged` }
  }
  try {
    const bare = await fetch(`${serverOrigin}/`, { redirect: 'manual', signal: AbortSignal.timeout(8_000) })
    const bareBody = await bare.text()
    const form = /<form[^>]*action="\/"/.test(bareBody)
    const app = /id="log"/.test(bareBody)
    const exchange = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(8_000) })
    const cookie = exchange.headers.get('set-cookie')
    const wall = bare.status === 401 && form && !app
    const admitted = exchange.status === 303 && cookie !== null && /HttpOnly/i.test(cookie) && /SameSite=Strict/i.test(cookie)
    return {
      origin: serverOrigin,
      bare: { status: bare.status, form, app },
      exchange: { status: exchange.status, cookie: cookie === null ? null : { httpOnly: /HttpOnly/i.test(cookie), sameSite: /SameSite=Strict/i.test(cookie) } },
      verdict: wall && admitted ? 'pass' : 'fail',
      detail:
        !wall
          ? `the deployed server answered ${bare.status} without a credential${app ? ' with the app shell' : ''}`
          : !admitted
            ? `the current launch URL did not exchange for a cookie (${exchange.status})`
            : '401 without a credential, 303 with the current token, HttpOnly SameSite=Strict cookie',
    }
  } catch (error) {
    return { verdict: 'fail', detail: `the deployed server on ${serverOrigin} does not answer: ${error.message}` }
  }
}

/** 3. The app loads through the gate, in a browser, with the token the gate supplied. */
async function judgeLoad() {
  try {
    const opened = await callTool('new_page', { url: URL_GATE }, 45_000)
    const pageId = opened?.pageId
    const up = await waitFor(pageId, '#log', 25_000)
    const facts = (await factsOf(pageId)) ?? {}
    return {
      pageId,
      page: facts,
      verdict: up && facts.log === true && facts.composer === true ? 'pass' : 'fail',
      detail:
        up && facts.composer
          ? 'the app shell loaded through the gate'
          : facts.tokenForm
            ? 'the gate served the token form instead of the app'
            : 'the app shell did not load within 25s',
    }
  } catch (error) {
    return { verdict: 'fail', detail: `load failed: ${error.message}` }
  }
}

/** 4. The served marker is this checkout's built page, and the checkout is not stale. */
function judgeMarker(load) {
  const served = load.page?.marker ?? null
  const expected = deployment.expectedMarker
  if (load.page === undefined) return { served: null, expected, verdict: 'unjudged', detail: 'the page did not load, so no served marker exists to compare' }
  if (expected === null) return { served, expected, verdict: 'unjudged', detail: `no built page at ${deployment.pagePath}` }
  if (served === null) return { served, expected, verdict: 'fail', detail: 'the served page carries no heddle-page marker' }
  const match = served === expected
  return {
    served,
    expected,
    match,
    deploymentHead: deployment.head,
    mainTip: deployment.mainTip,
    behind: deployment.behind,
    verdict: match ? 'pass' : 'fail',
    detail: match
      ? `the served page is the deployment build (${served})`
      : `the served page is not this build: served ${served}, this checkout builds ${expected}`,
  }
}

/** 5. One short turn goes through the live page and its answer arrives in deltas. */
async function judgeTurn(pageId, before) {
  if (!SEND_TURN) return { verdict: 'unjudged', detail: '--no-turn' }
  if (pageId === undefined) return { verdict: 'unjudged', detail: 'the page is not open, so a turn cannot be sent' }
  try {
    if (!(await waitFor(pageId, '#prompt textarea', 15_000))) return { verdict: 'fail', detail: 'the composer never appeared' }
    const box = (await callTool(
      'evaluate_script',
      { pageId, function: `() => { const r = document.querySelector('#prompt textarea').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }` },
      15_000,
    ))?.value
    await callTool('click_at', { pageId, x: Math.round(box.x), y: Math.round(box.y) }, 15_000)
    const prompt = `live health check ${new Date().toISOString()}`
    await callTool('type_text', { pageId, text: prompt, submitKey: 'Enter' }, 20_000)

    const startedAt = Date.now()
    const samples = []
    let firstDeltaMs = null
    let settledMs = null
    const deadline = Date.now() + 45_000
    let facts = before
    while (Date.now() < deadline) {
      facts = (await factsOf(pageId)) ?? facts
      const assistant = facts.assistantLengths ?? []
      const last = assistant.length > 0 ? assistant[assistant.length - 1] : 0
      if (last > 0 && (samples.length === 0 || samples[samples.length - 1] !== last)) {
        samples.push(last)
        if (firstDeltaMs === null) firstDeltaMs = Date.now() - startedAt
      }
      const userAppeared = (facts.userTurns ?? 0) > (before.userTurns ?? 0)
      if (userAppeared && assistant.length > 0 && facts.assistantRunning === false && last > 0) {
        settledMs = Date.now() - startedAt
        break
      }
      await new Promise((done) => setTimeout(done, 200))
    }
    const userAppeared = (facts.userTurns ?? 0) > (before.userTurns ?? 0)
    const assistantAppeared = (facts.assistantTurns ?? 0) > (before.assistantTurns ?? 0) || (facts.assistantLengths ?? []).some((length) => length > 0)
    const notices = facts.notices ?? []
    return {
      prompt,
      userAppeared,
      assistantAppeared,
      samples,
      grew: samples.length >= 2,
      firstDeltaMs,
      settledMs,
      settled: settledMs !== null,
      notices,
      verdict: userAppeared && assistantAppeared && samples.length > 0 && settledMs !== null && notices.length === 0 ? 'pass' : 'fail',
      detail:
        notices.length > 0
          ? `the turn was refused: ${notices.join(' / ').slice(0, 200)}`
          : !userAppeared
            ? 'the submitted prompt never appeared as a turn'
            : !assistantAppeared
              ? 'the answer never appeared'
              : settledMs === null
                ? 'the answer never settled within 45s'
                : `answer streamed in ${samples.length} delta(s), first at ${firstDeltaMs}ms, settled at ${settledMs}ms`,
    }
  } catch (error) {
    return { verdict: 'fail', detail: `the turn failed: ${error.message}` }
  }
}

/** 6. The console over one page. */
async function judgeConsole(pageId, phase) {
  try {
    const messages = await consoleMessages(pageId)
    const errors = messages.filter((message) => message.type === 'error')
    const warnings = messages.filter((message) => message.type === 'warning')
    return {
      phase,
      total: messages.length,
      errors: errors.length,
      warnings: warnings.length,
      sample: errors.slice(0, 3).map((message) => String(message.text ?? '').slice(0, 240)),
      verdict: errors.length === 0 ? 'pass' : 'fail',
      detail: errors.length === 0 ? `no console errors (${messages.length} message(s), ${warnings.length} warning(s))` : `${errors.length} console error(s)`,
    }
  } catch (error) {
    return { phase, verdict: 'unjudged', detail: `console unreadable: ${error.message}` }
  }
}

/** 7. The DSH reference, for the same numbers the baseline pins. */
async function judgeDsh() {
  let pageId
  try {
    const opened = await callTool('new_page', { url: URL_DSH }, 45_000)
    pageId = opened?.pageId
    let facts = null
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      facts = (await callTool(
        'evaluate_script',
        {
          pageId,
          function: `() => ({ title: document.title, boot: window.__DSH_BOOT__ !== undefined ? Object.keys(window.__DSH_BOOT__) : null, composers: document.querySelectorAll('textarea, [contenteditable="true"]').length, body: document.body.innerHTML.length })`,
        },
        15_000,
      ))?.value
      if (facts?.boot !== null && facts?.boot !== undefined) break
      await new Promise((done) => setTimeout(done, 200))
    }
    const reached = facts !== null && typeof facts?.title === 'string'
    const messages = await consoleMessages(pageId)
    const errors = messages.filter((message) => message.type === 'error')
    return {
      reached,
      ...(facts ?? {}),
      consoleErrors: errors.length,
      verdict: reached && facts?.title === 'DeepSeek Harness' ? (errors.length === 0 ? 'pass' : 'attention') : 'unjudged',
      detail: reached ? `title ${JSON.stringify(facts?.title ?? null)}, boot ${JSON.stringify(facts?.boot ?? null)}, ${errors.length} console error(s)` : 'DSH does not answer',
    }
  } catch (error) {
    return { reached: false, verdict: 'unjudged', detail: `DSH unreadable: ${error.message}` }
  } finally {
    if (pageId !== undefined) await callTool('close_page', { pageId }, 15_000).catch(() => {})
  }
}

// ---- the pass ---------------------------------------------------------------------------------

pass.checks.gate = await judgeGate()
pass.checks.door = await judgeDoor()
pass.checks.load = pass.checks.gate.verdict === 'pass' ? await judgeLoad() : { verdict: 'unjudged', detail: 'the gate did not serve the app, so the page was not loaded' }
pass.checks.marker = judgeMarker(pass.checks.load)

if (pass.checks.load.verdict === 'pass') {
  const pageId = pass.checks.load.pageId
  pass.checks.consoleOnLoad = await judgeConsole(pageId, 'load')
  pass.checks.turn = await judgeTurn(pageId, pass.checks.load.page)
  const after = await judgeConsole(pageId, 'after the turn')
  pass.checks.console = {
    ...after,
    // One clean console is the claim: an error at either reading fails it, and both readings are kept.
    verdict: after.verdict === 'fail' || pass.checks.consoleOnLoad.verdict === 'fail' ? 'fail' : 'pass',
    detail: `${after.detail}; on load: ${pass.checks.consoleOnLoad.detail}`,
  }
  await callTool('close_page', { pageId }, 15_000).catch(() => {})
} else {
  for (const name of ['turn', 'console']) pass.checks[name] = { verdict: 'unjudged', detail: 'the page did not load, so it was not judged' }
}

pass.dsh = await judgeDsh()

const verdicts = Object.values(pass.checks).map((check) => check.verdict)
pass.verdict = verdicts.includes('fail') ? 'fail' : verdicts.includes('unjudged') ? 'unjudged' : 'pass'

if (options.pin === true) {
  mkdirSync(dirname(JSONL), { recursive: true })
  appendFileSync(JSONL, `${JSON.stringify(pass)}\n`)
}

if (options.json === true) {
  say(JSON.stringify(pass, null, 2))
} else {
  const mark = (verdict) => (verdict === 'pass' ? 'pass' : verdict === 'fail' ? 'FAIL' : '----')
  say(`live-health ${pass.at}`)
  say(`deployment  ${deployment.root} @ ${deployment.headShort ?? 'not a checkout'} (${deployment.branch ?? '?'}), main ${deployment.mainTipShort ?? '?'}, behind ${deployment.behind ?? '?'}${deployment.dirty ? `, ${deployment.dirty} uncommitted` : ''}`)
  say(`gate        ${mark(pass.checks.gate.verdict)}  ${pass.checks.gate.detail}`)
  say(`door        ${mark(pass.checks.door.verdict)}  ${pass.checks.door.detail}`)
  say(`load        ${mark(pass.checks.load.verdict)}  ${pass.checks.load.detail}`)
  say(`marker      ${mark(pass.checks.marker.verdict)}  ${pass.checks.marker.detail}`)
  say(`turn        ${mark(pass.checks.turn.verdict)}  ${pass.checks.turn.detail}`)
  say(`console     ${mark(pass.checks.console.verdict)}  ${pass.checks.console.detail}`)
  say(`dsh         ${mark(pass.dsh.verdict)}  ${pass.dsh.detail}`)
  say(`verdict     ${pass.verdict.toUpperCase()}${options.pin === true ? `  pinned to ${JSONL}` : ''}`)
}

process.exit(pass.verdict === 'pass' ? 0 : pass.verdict === 'fail' ? 1 : 3)
