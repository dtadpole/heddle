#!/usr/bin/env node
/**
 * One live-health pass over the team's live address, `http://127.0.0.1:8082/`.
 *
 * ## What is actually behind that address, measured 2026-10-22
 *
 * `8082` is the **heddle Web Gate**, an operator tool outside this repository (dsh-web-ops): a
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
 * Exit: 0 when every judged check passes, 1 when one fails or the address does not answer (a live
 * deployment that stops answering is a failure), 3 when a check cannot be decided although the
 * deployment answered (the project's verifier contract: unjudged is never passing).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

import {
  consoleVerdict,
  doorVerdict,
  gateVerdict,
  launchUrlFromLog,
  markerVerdict,
  parseArguments,
  processVerdict,
  tildeText,
  passVerdict,
  shellVerdict,
  tildePath,
  turnVerdict,
} from './rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const JSONL = join(REPO, '_context_', 'rust-port', 'live-health.jsonl')

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
const stopBrowser = () => browser.stopHost()

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
  return launchUrlFromLog(readFileSync(LOG_FILE, 'utf8'))
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

/** The port the deployment listens on, from the launch URL the server itself printed. */
const serverPort = serverOrigin === null ? '3082' : new URL(serverOrigin).port || '80'

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

/** The deployment facts as the pinned record states them: paths under ~, never the absolute home. */
const deploymentRecord = {
  ...deployment,
  root: tildePath(deployment.root, homedir()),
  pagePath: tildePath(deployment.pagePath, homedir()),
}

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
  answerHead: (() => { const rows = [...document.querySelectorAll('#log .turn.assistant')]; const last = rows[rows.length - 1]; return last === undefined ? null : (last.textContent ?? '').trim().slice(0, 120) })(),
})`

/**
 * The DOM-derived inventory the parity audit prescribes: every interactive element, with the
 * properties that have been missed before — cursor, hit-test and clipping. It is run on both pages
 * and reduced to counts, because a live pass compares anatomy and behaviour, not pixels.
 */
const INVENTORY = `() => {
  const interactive = [...document.querySelectorAll('button, a[href], summary, input, textarea, select, [role="button"], [role="tab"], [role="menuitem"], [role="treeitem"], [tabindex]:not([tabindex="-1"])')]
  const clips = (element) => {
    const rect = element.getBoundingClientRect()
    let clipped = false
    let current = element.parentElement
    while (current !== null) {
      const style = getComputedStyle(current)
      if (/auto|scroll|hidden|clip/.test(style.overflowX + style.overflowY)) {
        const outer = current.getBoundingClientRect()
        if (rect.left < outer.left - 1 || rect.right > outer.right + 1 || rect.top < outer.top - 1 || rect.bottom > outer.bottom + 1) clipped = true
      }
      current = current.parentElement
    }
    return clipped
  }
  const rows = interactive.map((element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    const centre = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return {
      role: element.getAttribute('role') ?? element.tagName.toLowerCase(),
      name: (element.getAttribute('aria-label') ?? (element.textContent || '').trim()).slice(0, 28),
      cursor: style.cursor,
      disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
      hitTest: centre === null ? null : centre === element || element.contains(centre),
      clipped: clips(element),
      visible: rect.width > 0 && rect.height > 0,
    }
  })
  const visible = rows.filter((row) => row.visible)
  const enabled = visible.filter((row) => !row.disabled)
  return {
    interactive: rows.length,
    visible: visible.length,
    enabled: enabled.length,
    /** A control that shows no affordance: a default/auto cursor is the platform arrow, the miss the audit names. Resize separators legitimately show col-resize. */
    nonPointerCursors: enabled.filter((row) => (row.cursor === 'default' || row.cursor === 'auto') && row.role !== 'textarea' && row.role !== 'input').length,
    nonPointer: enabled.filter((row) => (row.cursor === 'default' || row.cursor === 'auto') && row.role !== 'textarea' && row.role !== 'input').map((row) => row.role + ':' + row.name).slice(0, 8),
    hitTestMisses: enabled.filter((row) => row.hitTest === false).length,
    clipped: visible.filter((row) => row.clipped).length,
    hidden: rows.length - visible.length,
  }
}`

/** The inventory digest of one page, or null when the page cannot be read. */
async function inventoryOf(pageId) {
  try {
    return (await callTool('evaluate_script', { pageId, function: INVENTORY }, 20_000))?.value ?? null
  } catch {
    return null
  }
}

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

/**
 * The deployment's own trace for a turn that produced nothing.
 *
 * A failed model call is not always visible in the page: a ModelError ends the stream after the user
 * row, and the client has no row to draw. The server records the code in the session log
 * (compaction/recovery for a request error, with retry and its reason), so the pass reads the newest
 * session log and keeps codes and shapes only: the log carries the owner's conversation and this
 * repository is public.
 */
/**
 * Decompress a session log's frames.
 *
 * The store appends one zstd **frame per event**, and both `zlib.zstdDecompressSync` and its stream
 * stop after the first frame — measured: a 4,490-byte log of six frames decoded to one line. The
 * frames start with the zstd magic, so the magic is where a frame is split; a slice that does not
 * decode (a frame still being written) is skipped rather than losing the rest of the log.
 */
function decompressFrames(buffer) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  let at = buffer.indexOf(MAGIC)
  while (at !== -1) {
    offsets.push(at)
    at = buffer.indexOf(MAGIC, at + MAGIC.length)
  }
  const parts = []
  for (let index = 0; index < offsets.length; index += 1) {
    const slice = buffer.subarray(offsets[index], index + 1 < offsets.length ? offsets[index + 1] : buffer.length)
    try {
      parts.push(zstdDecompressSync(slice).toString('utf8'))
    } catch {
      // A frame that is still being appended is not an error in the deployment.
    }
  }
  return parts.join('')
}

/** The deployment's session logs, newest first. */
function sessionFiles() {
  const root = join(process.env.HEDDLE_HOME ?? join(homedir(), '.heddle'), 'sessions')
  if (!existsSync(root)) return []
  const files = []
  for (const folder of readdirSync(root)) {
    const dir = join(root, folder)
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) if (entry.endsWith('.v2.jsonl.zstd')) files.push(join(dir, entry))
  }
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return files
}

/**
 * What the deployment recorded for one turn: how many assistant chunks it emitted, and whether the
 * turn completed. The page renders those chunks, and the session log is the only place the count
 * survives a fast answer that lands between two DOM polls.
 */
async function streamTrace(prompt) {
  try {
    for (const file of sessionFiles().slice(0, 6)) {
      let events
      try {
        events = decompressFrames(readFileSync(file))
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line))
      } catch {
        continue
      }
      const mine = events.findLastIndex((event) => event.type === 'message' && event.message?.role === 'user' && String(event.message?.content?.[0]?.text ?? '').startsWith(prompt))
      if (mine === -1) continue
      const after = events.slice(mine + 1)
      return {
        chunks: after.filter((event) => event.type === 'assistant/chunk').length,
        completed: after.some((event) => event.type === 'assistant/completed'),
        turnCompleted: after.some((event) => event.type === 'turn/completed'),
      }
    }
    return null
  } catch (error) {
    return { error: String(error.message).slice(0, 120) }
  }
}

async function serverTrace() {
  try {
    const files = sessionFiles()
    if (files.length === 0) return null
    const text = decompressFrames(readFileSync(files[0]))
    const events = []
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type === 'compaction/recovery' || event.type === 'agent/request-error' || event.type === 'error') {
        events.push({ type: event.type, code: event.code ?? null, retry: event.retry ?? null, reason: event.reason ?? null })
      }
    }
    // No session id in the record: a session id is a private identifier the public repository must not carry.
    return { events: events.slice(-4) }
  } catch (error) {
    return { error: String(error.message).slice(0, 120) }
  }
}

const pass = {
  at: new Date().toISOString(),
  session: SESSION,
  ...(typeof options.note === 'string' && options.note.length > 0 ? { note: options.note } : {}),
  gate: URL_GATE,
  serverOrigin,
  deployment: deploymentRecord,
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
    const judged = gateVerdict({ status: response.status, app, proxyError, firstLine })
    return {
      status: response.status,
      app,
      proxyError,
      firstLine: proxyError ? firstLine : undefined,
      verdict: judged.verdict,
      detail: judged.detail,
    }
  } catch (error) {
    return { status: null, verdict: 'fail', detail: `the gate does not answer: ${error.message}` }
  }
}

/**
 * 2. Which checkout answers the port.
 *
 * The marker binds the page to a build; only the listener's own command line binds the **process** to
 * the checkout. Read with `lsof` + `ps`, the same facts `96-deployment` reads from the installed
 * agent, so a half-reloaded or repointed service is caught between two 20-minute passes.
 */
function judgeProcess() {
  try {
    const pids = execFileSync('lsof', ['-nP', `-iTCP:${serverPort}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n').filter((line) => line.length > 0)
    const pid = pids[0]
    if (pid === undefined) {
      const judged = processVerdict({ command: null, deployRoot: DEPLOY_ROOT, home: homedir() })
      return { port: Number(serverPort), verdict: judged.verdict, detail: judged.detail }
    }
    const command = execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' }).trim()
    const judged = processVerdict({ command, deployRoot: DEPLOY_ROOT, home: homedir() })
    return { port: Number(serverPort), command: tildeText(command, homedir()), verdict: judged.verdict, detail: judged.detail }
  } catch (error) {
    return { port: Number(serverPort), verdict: 'unjudged', detail: `the listener on port ${serverPort} could not be read: ${error.message}` }
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
    const judged = shellVerdict({ exchangeStatus: null, loaded: up, log: facts.log, composer: facts.composer, tokenForm: facts.tokenForm })
    return {
      pageId,
      page: facts,
      inventory: await inventoryOf(pageId),
      verdict: judged.verdict,
      detail: judged.detail,
    }
  } catch (error) {
    return { verdict: 'fail', detail: `load failed: ${error.message}` }
  }
}

/** 4. The served marker is this checkout's built page, and the checkout is not stale. */
function judgeMarker(load) {
  const served = load.page?.marker ?? null
  const expected = deployment.expectedMarker
  const judged = markerVerdict({ served, expected, loaded: load.page !== undefined })
  return {
    served,
    expected,
    match: served !== null && served === expected,
    deploymentHead: deployment.head,
    mainTip: deployment.mainTip,
    behind: deployment.behind,
    verdict: judged.verdict,
    detail: judged.detail,
  }
}

/** 5. One short turn goes through the live page and its answer arrives in deltas. */
async function judgeTurn(pageId, beforeSession) {
  if (!SEND_TURN) return { verdict: 'unjudged', detail: '--no-turn' }
  if (pageId === undefined) return { verdict: 'unjudged', detail: 'the page is not open, so a turn cannot be sent' }
  try {
    if (!(await waitFor(pageId, '#prompt textarea', 15_000))) return { verdict: 'fail', detail: 'the composer never appeared' }
    /**
     * Reuse one health session.
     *
     * A turn creates a session in the deployment's store, so a pass every 20 minutes would fill the
     * owner's session list with monitor rows. The pass continues the newest session whose title starts
     * with the monitor's own prefix: by clicking its tree row when one is drawn (a person's gesture),
     * and by the page's own selection function when the tree does not draw it. Only a deployment with
     * no health session yet gets a new one.
     */
    const healthSession = (await callTool(
      'evaluate_script',
      {
        pageId,
        function: `(async () => {
          const list = await (await fetch('/api/sessions')).json()
          const hit = (Array.isArray(list) ? list : []).find((item) => String(item.title ?? '').startsWith('live health check')) ?? null
          if (hit === null) return null
          const rows = [...document.querySelectorAll('#tree li[data-kind="session"]')]
          const row = rows.find((item) => (item.querySelector('.label')?.textContent ?? '') === hit.title) ?? null
          if (row === null) return { id: hit.id, title: hit.title, row: null }
          const rect = row.getBoundingClientRect()
          return { id: hit.id, title: hit.title, row: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } }
        })`,
      },
      20_000,
    ))?.value ?? null
    let reused = 'new'
    if (healthSession?.row !== null && healthSession?.row !== undefined) {
      await callTool('click_at', { pageId, x: Math.round(healthSession.row.x), y: Math.round(healthSession.row.y) }, 15_000)
      reused = 'tree'
    } else if (healthSession?.id !== undefined) {
      const select = `() => { if (typeof showSession === 'function') showSession(${JSON.stringify(healthSession.id)}); return true }`
      await callTool('evaluate_script', { pageId, function: select }, 15_000)
      reused = 'selection'
    }
    if (reused !== 'new') await new Promise((done) => setTimeout(done, 400))
    // Re-read the page after selecting, so the turn's before-count is the selected session's own.
    const before = (await factsOf(pageId)) ?? beforeSession
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
    /**
     * A turn that produced no answer is a failure of the deployment, not of the pass; the server's own
     * trace is what turns "nothing appeared" into a code someone can act on.
     */
    const trace = assistantAppeared ? null : await serverTrace()
    const code = trace?.events?.find((event) => event.code !== null)?.code ?? null
    /**
     * A scripted answer can land between two 200ms DOM polls, so "it grew while we watched" is not
     * the only evidence of a stream: the deployment's own chunk count is the mechanism's record.
     */
    const stream = assistantAppeared ? await streamTrace(prompt) : null
    const judged = turnVerdict({ userAppeared, assistantAppeared, chunks: stream?.chunks ?? null, samples, settledMs, notices })
    return {
      prompt,
      session: { reused: reused !== 'new', via: reused, title: healthSession?.title ?? null },
      userAppeared,
      assistantAppeared,
      samples,
      grew: samples.length >= 2,
      firstDeltaMs,
      settledMs,
      settled: settledMs !== null,
      stream,
      streamed: judged.streamed,
      notices,
      serverTrace: trace,
      silent: notices.length === 0 && !assistantAppeared,
      answerHead: facts.answerHead ?? null,
      verdict: judged.verdict,
      detail:
        code === null
          ? judged.detail
          : `${judged.detail}; the deployment recorded ${code}${trace?.events?.find((event) => event.code === code)?.reason ? ` (${trace.events.find((event) => event.code === code).reason})` : ''}${notices.length === 0 ? '; the page showed no error' : ''}`,
    }
  } catch (error) {
    return { verdict: 'fail', detail: `the turn failed: ${error.message}` }
  }
}

/** 6. The console over one page. */
async function judgeConsole(pageId, phase) {
  try {
    const judged = consoleVerdict(await consoleMessages(pageId))
    return { phase, ...judged }
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
      inventory: await inventoryOf(pageId),
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
pass.checks.process = judgeProcess()
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
pass.compare = {
  /** The same DOM inventory on both pages; the full parity ledger is the ui lane's, this is the live cross-check. */
  heddle: pass.checks.load.inventory ?? null,
  dsh: pass.dsh.inventory ?? null,
  note: 'counts only; they move with content (session rows in the tree, turns in the log), so compare them at equal content and name a move at equal content as a regression for the ui lane',
}

pass.verdict = passVerdict(pass.checks)

if (options.pin === true) {
  mkdirSync(dirname(JSONL), { recursive: true })
  appendFileSync(JSONL, `${JSON.stringify(pass)}\n`)
}

if (options.json === true) {
  say(JSON.stringify(pass, null, 2))
} else {
  const mark = (verdict) => (verdict === 'pass' ? 'pass' : verdict === 'fail' ? 'FAIL' : '----')
  say(`live-health ${pass.at}`)
  say(`deployment  ${deploymentRecord.root} @ ${deployment.headShort ?? 'not a checkout'} (${deployment.branch ?? '?'}), main ${deployment.mainTipShort ?? '?'}, behind ${deployment.behind ?? '?'}${deployment.dirty ? `, ${deployment.dirty} uncommitted` : ''}`)
  say(`gate        ${mark(pass.checks.gate.verdict)}  ${pass.checks.gate.detail}`)
  say(`process     ${mark(pass.checks.process.verdict)}  ${pass.checks.process.detail}`)
  say(`door        ${mark(pass.checks.door.verdict)}  ${pass.checks.door.detail}`)
  say(`load        ${mark(pass.checks.load.verdict)}  ${pass.checks.load.detail}`)
  say(`marker      ${mark(pass.checks.marker.verdict)}  ${pass.checks.marker.detail}`)
  say(`turn        ${mark(pass.checks.turn.verdict)}  ${pass.checks.turn.detail}`)
  say(`console     ${mark(pass.checks.console.verdict)}  ${pass.checks.console.detail}`)
  say(`dsh         ${mark(pass.dsh.verdict)}  ${pass.dsh.detail}`)
  const digest = (row) => (row === null ? 'not measured' : `${row.interactive} interactive, ${row.enabled} enabled, ${row.nonPointerCursors} non-pointer cursor(s), ${row.hitTestMisses} hit-test miss(es), ${row.clipped} clipped${row.nonPointer?.length > 0 ? ` [${row.nonPointer.join(', ')}]` : ''}`)
  say(`compare     heddle ${digest(pass.compare.heddle)}`)
  say(`            dsh    ${digest(pass.compare.dsh)}`)
  say(`verdict     ${pass.verdict.toUpperCase()}${options.pin === true ? `  pinned to ${JSONL}` : ''}`)
}

/**
 * The browser is closed at the end of every pass: this Mac runs twelve seats on 16 GB, and the
 * coordinator measured swap at 79% with a browser left open. `--keep-browser` is for a debugging
 * session, not for the schedule.
 */
if (options['keep-browser'] !== true) await stopBrowser().catch(() => {})

process.exit(pass.verdict === 'pass' ? 0 : pass.verdict === 'fail' ? 1 : 3)
