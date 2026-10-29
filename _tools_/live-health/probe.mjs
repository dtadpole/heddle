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
 *   _tools_/live-health/probe.mjs --no-deployment-turn   # 8082's turn alone paused; the preview's still goes
 *   _tools_/live-health/probe.mjs --deployment-conversation   # 8082 also gets a follow-up, same page
 *   _tools_/live-health/probe.mjs --real-model=deepseek-official/deepseek-flash   # the real turn's model (D-052 default)
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
  acrossMove,
  classifyOutage,
  consoleVerdict,
  deploymentMove,
  deploymentDown,
  doorVerdict,
  expectedPage,
  gateVerdict,
  launchUrlFromLog,
  looksLikeProxyError,
  markerVerdict,
  outageHop,
  parseArguments,
  expectedSeatLabel,
  fixtureOnly,
  healthSessionExpired,
  modelLabel,
  REAL_MODEL,
  realModelChoice,
  previewTurnVerdict,
  previewVerdict,
  sharedSessions,
  passVerdict,
  processVerdict,
  redactRecord,
  shellVerdict,
  tildePath,
  tildeText,
  turnLanding,
  conversationVerdict,
  deploymentTurnWithConversation,
  sameHealthSession,
  turnVerdict,
} from './rules.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const JSONL = join(REPO, '_context_', 'rust-port', 'live-health.jsonl')

const options = parseArguments(process.argv.slice(2))
/** Expand a leading `~`, because the paths this team agrees on are written that way. */
const expand = (path) => (path.startsWith('~') ? join(homedir(), path.slice(1)) : path)
const say = (line) => process.stdout.write(`${redactRecord(String(line), homedir())}\n`)

// The document the gate served this pass, kept for the marker check; never pinned verbatim.
let servedGateBody = null

const URL_GATE = options.url ?? 'http://127.0.0.1:8082/'
const URL_DSH = options.dsh ?? 'http://127.0.0.1:8080/'
const DEPLOY_ROOT = expand(options.deploy ?? '~/heddle-live')
const LOG_FILE = expand(options.log ?? '~/.heddle/web.log')
const SESSION = options.session ?? 'hd-live-monitor'
const SEND_TURN = options['no-turn'] !== true
/**
 * The preview's turn alone can be paused: live-deploy asked for it on 2026-10-22 (23:24) while the
 * preview wrote into the deployment's session store. A paused turn is unjudged, never a pass.
 */
const PREVIEW_TURN = options['no-preview-turn'] !== true
/**
 * The deployment's turn alone can be paused too: a turn that landed in a session the monitor does not
 * own pauses that turn until the coordinator answers (2026-10-29 11:35Z, a new-session draft on 8082
 * turned out to be someone's existing empty session). A paused turn is unjudged, never a pass.
 */
const DEPLOYMENT_TURN = options['no-deployment-turn'] !== true
/**
 * The deployment's two-message check, on demand: the coordinator asked (review 255, 2026-10-25) for a
 * two-message conversation on 8082 as well as 3097 once the page patch is deployed. The follow-up goes
 * on the same page load, the window the page's settle-and-render race lives in. Off by default, so a
 * scheduled pass still spends one deployment turn.
 */
const DEPLOYMENT_CONVERSATION = options['deployment-conversation'] === true
/**
 * The model a real-model turn names (D-052): `--real-model=<endpoint>/<model>` overrides the decided
 * `deepseek-official/deepseek-flash`. A target that configures only the offline fixture still gets the
 * fixture turn; any other gets one minimal turn on this model at its lowest effort, never another model.
 */
const WANT_MODEL = (() => {
  const named = typeof options['real-model'] === 'string' ? options['real-model'].split('/') : null
  return named !== null && named.length === 2 && named[0] && named[1] ? { endpoint: named[0], model: named[1] } : REAL_MODEL
})()

/** The browser is a child of this pass, but its session outlives it: that is the tool's design. */
process.env.HEDDLE_BROWSER_SESSION = SESSION
const browser = await import(join(REPO, '_tools_', 'browser-use', 'client.mjs'))
const callTool = (tool, args = {}, timeoutMs = 45_000) => browser.callTool(tool, args, { headless: true, timeoutMs })
const stopBrowser = () => browser.stopHost()

/** A git answer from a checkout, or null when it is not one. Never throws into the pass. */
function gitAt(root, ...args) {
  try {
    return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
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

let launchUrl = readLaunchUrl()
/** The deployed server's own origin (`http://127.0.0.1:3082`), where the token door lives. */
let serverOrigin = originOf(launchUrl)
/** The port the deployment listens on, from the launch URL the server itself printed. */
let serverPort = portOf(serverOrigin)

/** The origin of a launch URL, or null when it is not one. */
function originOf(url) {
  if (url === null) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** The port of an origin, or the deployment's default when no origin is readable. */
function portOf(origin) {
  return origin === null ? '3082' : new URL(origin).port || '80'
}

/**
 * Re-read the deployment's launch target.
 *
 * A restarted server mints a **new** per-process launch token; the one the pass read before the
 * restart is stale the moment the process comes back. Measured 2026-10-22: a restart
 * took 507 ms, the gate recovered, and the door check failed `401` because it still held the old
 * token. The target is therefore re-read after every restart the pass observes.
 */
function refreshDeploymentTarget() {
  launchUrl = readLaunchUrl()
  serverOrigin = originOf(launchUrl)
  serverPort = portOf(serverOrigin)
}

/**
 * The main tip is fetched before it is compared.
 *
 * A pass runs on the schedule, between rounds, so the worktree's `origin/main` may be hours old; a
 * staleness reading against a stale ref is worse than none. The fetch is best-effort and recorded:
 * `mainTipFresh` says whether the tip was refreshed, so a reader knows what the comparison measured.
 */
function refreshMainTip() {
  try {
    execFileSync('git', ['--no-optional-locks', '-C', REPO, 'fetch', 'origin', '--quiet'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

const mainTipFresh = refreshMainTip()

const deployment = (() => {
  const head = gitAt(DEPLOY_ROOT, 'rev-parse', 'HEAD')
  const branch = gitAt(DEPLOY_ROOT, 'rev-parse', '--abbrev-ref', 'HEAD')
  const dirty = gitAt(DEPLOY_ROOT, 'status', '--porcelain')
  const mainTip = gitAt(REPO, 'rev-parse', 'origin/main')
  const behind = head !== null && mainTip !== null ? Number(gitAt(DEPLOY_ROOT, 'rev-list', '--count', `${head}..${mainTip}`) ?? 0) : null
  const ahead = head !== null && mainTip !== null ? Number(gitAt(DEPLOY_ROOT, 'rev-list', '--count', `${mainTip}..${head}`) ?? 0) : null
  const pagePath = join(DEPLOY_ROOT, 'dist', 'server', 'page.html')
  const builtBuffer = existsSync(pagePath) ? readFileSync(pagePath) : null
  const built = builtBuffer
  return {
    root: DEPLOY_ROOT,
    head,
    headShort: head?.slice(0, 12) ?? null,
    branch,
    dirty: dirty === null ? null : dirty === '' ? 0 : dirty.split('\n').length,
    mainTip,
    mainTipShort: mainTip?.slice(0, 12) ?? null,
    mainTipFresh,
    behind,
    ahead,
    pagePath,
    /** The marker the served document must carry, computed from this checkout's built page. */
    expectedMarker: built === null ? null : createHash('sha256').update(built).digest('hex').slice(0, 12),
    /** The built document itself, kept in memory for the byte comparison and never pinned. */
    builtText: builtBuffer === null ? null : builtBuffer.toString('utf8'),
  }
})()

/** The deployment facts as the pinned record states them: paths under ~, never the absolute home. */
const { builtText: _builtText, ...deploymentSummary } = deployment
const deploymentRecord = {
  ...deploymentSummary,
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
  assistantHeads: [...document.querySelectorAll('#log .turn.assistant')].map((node) => (node.textContent ?? '').trim().slice(0, 120)),
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

/**
 * The deployment's own trace for a turn that produced nothing.
 *
 * A failed model call is not always visible in the page: a ModelError ends the stream after the user
 * row, and the client has no row to draw. The server records the code in the session log
 * (compaction/recovery for a request error, with retry and its reason), so the pass reads the newest
 * session log and keeps codes and shapes only: the log carries the owner's conversation and this
 * repository is public.
 */
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
    servedGateBody = body
    const app = /id="log"/.test(body)
    /**
     * The app shell contains the word `heddle-proxy` once (a note about the gate), so matching the
     * word on a healthy `200` pinned every pass as a proxy error with firstLine "<!doctype html>".
     * Only the gate's own plain-text 5xx counts, and only there is its sentence kept.
     */
    const proxyError = looksLikeProxyError(response.status, body)
    const firstLine = proxyError ? (body.split('\n').find((line) => line.trim().length > 0) ?? '').trim().slice(0, 200) : undefined
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
    const flags = cookie === null ? null : { httpOnly: /HttpOnly/i.test(cookie), sameSite: /SameSite=Strict/i.test(cookie) }
    const judged = doorVerdict({ reachable: true, bareStatus: bare.status, form, app, exchangeStatus: exchange.status, cookie: flags })
    return {
      origin: serverOrigin,
      bare: { status: bare.status, form, app },
      exchange: { status: exchange.status, cookie: flags },
      verdict: judged.verdict,
      detail: judged.detail,
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
    const judged = shellVerdict({ exchangeStatus: null, loaded: up, log: facts.log, composer: facts.composer, send: facts.send, tokenForm: facts.tokenForm })
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
  /**
   * The strongest form of the claim: the served document is the built page with its marker
   * substituted, byte for byte. A marker alone proves only that some page carries the hash.
   */
  const expectedBody = deployment.builtText === null || expected === null ? null : expectedPage(deployment.builtText, expected)
  const pageMatch = expectedBody === null || servedGateBody === null ? null : servedGateBody === expectedBody
  const markerPassed = judged.verdict === 'pass'
  return {
    served,
    expected,
    match: served !== null && served === expected,
    pageMatch,
    servedBytes: servedGateBody === null ? null : Buffer.byteLength(servedGateBody, 'utf8'),
    expectedBytes: expectedBody === null ? null : Buffer.byteLength(expectedBody, 'utf8'),
    deploymentHead: deployment.head,
    mainTip: deployment.mainTip,
    behind: deployment.behind,
    verdict: markerPassed && pageMatch === false ? 'fail' : judged.verdict,
    detail:
      markerPassed && pageMatch === false
        ? `the marker matches but the served page is not the build byte for byte (${Buffer.byteLength(servedGateBody, 'utf8')} vs ${Buffer.byteLength(expectedBody, 'utf8')} bytes)`
        : judged.detail,
  }
}

/** 5. One short turn goes through the live page and its answer arrives in deltas. */
/**
 * `deploymentTrace` reads the deployment's own session store for the stream's chunk count and a
 * failed turn's code. The Rust preview is judged on the page alone, so its turn passes `false` and
 * never reads the deployment's store.
 */
async function judgeTurn(pageId, beforeSession, { deploymentTrace = true } = {}) {
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
    /**
     * Which turn this target gets (the coordinator's D-052 decision, 2026-10-29), read before the
     * session is chosen because a real-model pass rolls its session daily. With only the offline
     * fixture configured, the fixture turn as before; otherwise one minimal real turn on WANT_MODEL at
     * its lowest effort, and a model that cannot be had fails the turn - no other model is ever tried.
     * Endpoints are read by kind only (public-hygiene).
     */
    const catalogue = (await callTool(
      'evaluate_script',
      { pageId, function: `(async () => { try { return await (await fetch('/api/endpoints')).json() } catch { return null } })` },
      15_000,
    ))?.value ?? null
    const kinds = Array.isArray(catalogue?.endpoints) ? catalogue.endpoints.map((item) => ({ kind: item?.kind ?? null })) : null
    const mode = fixtureOnly(kinds) ? 'fixture' : 'real'
    const choice = mode === 'real' ? realModelChoice(catalogue, WANT_MODEL) : null
    if (choice !== null && choice.ok !== true) {
      return { mode, selection: choice, session: { reused: false, via: 'none', title: null }, verdict: 'fail', detail: `no real turn was sent: ${choice.reason}` }
    }
    const found = (await callTool(
      'evaluate_script',
      {
        pageId,
        function: `(async () => {
          const list = await (await fetch('/api/sessions')).json()
          const hit = (Array.isArray(list) ? list : [])
            .filter((item) => String(item.title ?? '').startsWith('live health check'))
            .sort((left, right) => String(right.created ?? '').localeCompare(String(left.created ?? '')))[0] ?? null
          if (hit === null) return null
          const rows = [...document.querySelectorAll('#tree li[data-kind="session"]')]
          const row = rows.find((item) => (item.querySelector('.label')?.textContent ?? '') === hit.title) ?? null
          if (row === null) return { id: hit.id, title: hit.title, created: hit.created ?? null, row: null }
          const rect = row.getBoundingClientRect()
          return { id: hit.id, title: hit.title, created: hit.created ?? null, row: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } }
        })`,
      },
      20_000,
    ))?.value ?? null
    /**
     * A real model is sent the whole session as context, so a real-model pass retires a health session
     * from an earlier UTC day and starts a new one (`healthSessionExpired`): the old one is left as it
     * is, never written into again by a real turn.
     */
    const retired = mode === 'real' && found !== null && healthSessionExpired(found.created) ? found.title : null
    const healthSession = retired === null ? found : null
    /** The session list as the page's server holds it: id and `updated` only, never titles of others. */
    const sessionsNow = async () =>
      (await callTool(
        'evaluate_script',
        { pageId, function: `(async () => { const list = await (await fetch('/api/sessions')).json(); return Array.isArray(list) ? list.map((item) => ({ id: item.id, updated: item.updated ?? null })) : null })` },
        15_000,
      ))?.value ?? null
    const listed = await sessionsNow()
    let target = healthSession?.id ?? null
    let reused = 'new'
    if (healthSession === null || healthSession === undefined) {
      /**
       * No health session yet: start one explicitly with the page's own New session control, and wait
       * for an id that did not exist before. Typing into whatever the page had selected is how the
       * preview's turns of 2026-10-23 06:48 and 07:08 landed in someone else's sessions.
       */
      const button = (await callTool(
        'evaluate_script',
        { pageId, function: `() => { const b = document.getElementById('new-session'); if (b === null) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }` },
        15_000,
      ))?.value ?? null
      if (button === null || !Array.isArray(listed)) {
        return { verdict: 'unjudged', detail: 'no session of the monitor\'s own could be started, so no turn was sent', session: { reused: false, via: 'none', title: null } }
      }
      await callTool('click_at', { pageId, x: Math.round(button.x), y: Math.round(button.y) }, 15_000)
      const known = new Set(listed.map((item) => item.id))
      const waitUntil = Date.now() + 6_000
      while (target === null && Date.now() < waitUntil) {
        await new Promise((done) => setTimeout(done, 300))
        target = ((await sessionsNow()) ?? []).find((item) => !known.has(item.id))?.id ?? null
      }
      if (target === null) {
        /**
         * No new id: send nothing. An empty log cannot tell a page-side draft from an existing empty
         * session someone else created - on 2026-10-29 at 11:35Z 8082's New session opened such a
         * session and a turn written there landed `other`. Only a session the server newly lists is
         * the monitor's own.
         */
        return { mode, verdict: 'unjudged', detail: 'New session started nothing the server lists, so no turn was sent', session: { reused: false, via: 'none', title: null, ...(retired !== null ? { retired } : {}) } }
      }
      reused = 'started'
    }
    if (healthSession?.row !== null && healthSession?.row !== undefined) {
      await callTool('click_at', { pageId, x: Math.round(healthSession.row.x), y: Math.round(healthSession.row.y) }, 15_000)
      reused = 'tree'
    } else if (healthSession?.id !== undefined) {
      const select = `() => { if (typeof showSession === 'function') showSession(${JSON.stringify(healthSession.id)}); return true }`
      await callTool('evaluate_script', { pageId, function: select }, 15_000)
      reused = 'selection'
    }
    if (reused !== 'new') await new Promise((done) => setTimeout(done, 400))
    const sessionNote = { reused: reused === 'tree' || reused === 'selection', via: reused, title: healthSession?.title ?? null, ...(retired !== null ? { retired } : {}) }
    let selection = null
    if (mode === 'real') {
      /**
       * The page's script is a module, so its selection functions are not reachable from outside: the
       * choice is made the way a person makes it, through the model seat's own menu (Model row, the
       * model under its endpoint's heading, then the Effort row and the level). Each choice is recorded
       * on the session by the page itself. The seat's accessible name afterwards is the proof.
       */
      const want = { endpoint: choice.endpoint, model: choice.model, modelTitle: choice.modelTitle, effortName: choice.effortName }
      const driven = (await callTool(
        'evaluate_script',
        {
          pageId,
          function: `(async () => {
            const want = ${JSON.stringify(want)}
            const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
            const trigger = document.getElementById('model-trigger')
            const menu = document.getElementById('model-menu')
            if (trigger === null || menu === null) return { ok: false, reason: 'the page has no model seat' }
            const idle = async () => { for (let i = 0; i < 80; i += 1) { if (trigger.getAttribute('aria-busy') !== 'true') return true; await sleep(100) } return false }
            const open = async () => { if (menu.hidden) { trigger.click(); await sleep(200) } }
            const close = async () => { if (!menu.hidden) { trigger.click(); await sleep(150) } }
            const cell = (label) => [...menu.querySelectorAll('.model-cell')].find((node) => node.querySelector('.cell-label')?.textContent === label) ?? null
            await open()
            const modelRow = cell('Model')
            if (modelRow !== null) { modelRow.click(); await sleep(200) }
            const groups = menu.querySelector('.model-groups')
            if (groups === null) { await close(); return { ok: false, reason: 'the model list did not open' } }
            let inGroup = false
            let option = null
            for (const node of groups.children) {
              if (node.classList.contains('model-group-heading')) { inGroup = node.textContent === want.endpoint; continue }
              if (inGroup && node.classList.contains('model-option') && node.title === want.modelTitle) { option = node; break }
            }
            if (option === null) { await close(); return { ok: false, reason: want.endpoint + '/' + want.model + ' is not offered in the model menu' } }
            if (option.getAttribute('aria-checked') === 'true') await close()
            else { option.click(); await sleep(200); await idle(); await close() }
            if (want.effortName !== null) {
              await open()
              const effortRow = cell('Effort')
              if (effortRow === null) { await close(); return { ok: false, reason: 'the model menu offers no effort row for ' + want.endpoint + '/' + want.model } }
              effortRow.click()
              await sleep(200)
              const level = [...menu.querySelectorAll('.model-option')].find((node) => node.title === want.effortName) ?? null
              if (level === null) { await close(); return { ok: false, reason: 'effort ' + want.effortName + ' is not offered' } }
              if (level.getAttribute('aria-checked') === 'true') await close()
              else { level.click(); await sleep(200); await idle(); await close() }
            }
            return { ok: true, seat: trigger.getAttribute('aria-label') }
          })`,
        },
        30_000,
      ))?.value ?? null
      const expected = expectedSeatLabel(choice)
      const held = driven?.ok === true && driven.seat === expected
      selection = held
        ? choice
        : { ...choice, ok: false, reason: driven?.ok === true ? `the model seat reads '${driven.seat}', not '${expected}'` : (driven?.reason ?? `the session could not be switched onto ${modelLabel(choice)}`) }
      if (!held) return { mode, selection, session: sessionNote, verdict: 'fail', detail: `no real turn was sent: ${selection.reason}` }
      await new Promise((done) => setTimeout(done, 300))
    }
    // Re-read the page after selecting, so the turn's baseline is the selected session's own.
    const before = (await factsOf(pageId)) ?? beforeSession
    if (before === null || typeof before.assistantTurns !== 'number' || typeof before.userTurns !== 'number') {
      return { verdict: 'unjudged', detail: 'the log could not be read before the turn, so this turn has no baseline' }
    }
    /**
     * The reused session already holds earlier answers, so "there is an assistant row" would describe
     * the previous turn - and could pass a turn the page never rendered. Everything below is measured
     * against this baseline: a new user row, a new assistant row, samples that grow past the old last
     * length, and only the notices that appeared since.
     */
    const listedBeforeTurn = await sessionsNow()
    const baseUser = before.userTurns
    const baseTurns = before.assistantTurns
    const baseNotices = (before.notices ?? []).length
    const box = (await callTool(
      'evaluate_script',
      { pageId, function: `() => { const r = document.querySelector('#prompt textarea').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }` },
      15_000,
    ))?.value
    await callTool('click_at', { pageId, x: Math.round(box.x), y: Math.round(box.y) }, 15_000)
    // One line either way; a real model is asked for the shortest answer so a pass costs next to nothing.
    const prompt = mode === 'real' ? `live health check ${new Date().toISOString()}: reply with one word` : `live health check ${new Date().toISOString()}`
    await callTool('type_text', { pageId, text: prompt, submitKey: 'Enter' }, 20_000)

    const startedAt = Date.now()
    const samples = []
    let firstDeltaMs = null
    let settledMs = null
    const deadline = Date.now() + 45_000
    let facts = before
    while (Date.now() < deadline) {
      facts = (await factsOf(pageId)) ?? facts
      const rows = (facts.assistantLengths ?? []).slice(baseTurns)
      const last = rows.length > 0 ? rows[rows.length - 1] : 0
      if (rows.length > 0 && last > 0 && (samples.length === 0 || samples[samples.length - 1] !== last)) {
        samples.push(last)
        if (firstDeltaMs === null) firstDeltaMs = Date.now() - startedAt
      }
      const userAppeared = (facts.userTurns ?? 0) > baseUser
      if (userAppeared && rows.length > 0 && facts.assistantRunning === false && last > 0) {
        settledMs = Date.now() - startedAt
        break
      }
      await new Promise((done) => setTimeout(done, 200))
    }
    /**
     * Where the turn landed, read from the server: it counts only if the monitor's own session changed.
     * The server records the turn a moment after the page settles, so the list is re-read for up to 3 s.
     */
    const beforeTurn = listedBeforeTurn
    let landing = { landed: 'unknown', othersChanged: null }
    const landBy = Date.now() + 3_000
    do {
      landing = turnLanding({ target, before: beforeTurn, after: await sessionsNow() })
      if (landing.landed !== 'unknown') break
      await new Promise((done) => setTimeout(done, 300))
    } while (Date.now() < landBy)
    const userAppeared = (facts.userTurns ?? 0) > baseUser
    const assistantAppeared = (facts.assistantTurns ?? 0) > baseTurns
    const notices = (facts.notices ?? []).slice(baseNotices)
    const answerHead = assistantAppeared ? ((facts.assistantHeads ?? [])[baseTurns] ?? null) : null
    /**
     * A turn that produced no answer is a failure of the deployment, not of the pass; the server's own
     * trace is what turns "nothing appeared" into a code someone can act on.
     */
    const trace = assistantAppeared || !deploymentTrace ? null : await serverTrace()
    const code = trace?.events?.find((event) => event.code !== null)?.code ?? null
    /**
     * A scripted answer can land between two 200ms DOM polls, so "it grew while we watched" is not
     * the only evidence of a stream: the deployment's own chunk count is the mechanism's record.
     */
    const stream = assistantAppeared && deploymentTrace ? await streamTrace(prompt) : null
    const streamed = turnVerdict({ userAppeared, assistantAppeared, chunks: stream?.chunks ?? null, samples, settledMs, notices })
    const judged =
      landing.landed === 'other'
        ? { ...streamed, verdict: 'fail', detail: `the turn landed in a session the monitor does not own (${landing.othersChanged} other session(s) changed, its own did not)` }
        : landing.landed === 'unknown' && streamed.verdict === 'pass'
          ? { ...streamed, verdict: 'unjudged', detail: `${streamed.detail}; but the server's session list did not show where it landed` }
          : streamed
    return {
      mode,
      selection,
      prompt,
      session: sessionNote,
      landing,
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
      answerHead,
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

// ---- what the pass may observe about the agent -------------------------------------------------

/**
 * The deployment's launchd label. The monitor **reads** the agent's state and never acts on it:
 * D-045 (2026-10-22) gives the live page one restore chain - the supervisor inside the agent, then
 * live-deploy's job-aware guard - after three outages that night came from extra restorers, two of
 * them this seat's own kickstarts. There is no restart, kickstart or kill anywhere in this file.
 */
/**
 * The Rust preview on 3097: a second, read-only target (the coordinator's review of 2026-10-22, 23:14).
 * Its launch link is read from its own log, for the preview only - never as the deployment's token.
 */
const PREVIEW_LOG = expand(options['preview-log'] ?? '~/.heddle-rust-preview/web.log')
const PREVIEW_LABEL = 'com.dtadpole.heddle-web-rust-preview'

/** One read-only request to the preview: status, type and size are kept; the body is used, never pinned. */
async function previewFetch(url, cookie) {
  try {
    const response = await fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(8_000) })
    const body = await response.text()
    return { status: response.status, type: response.headers.get('content-type'), bytes: Buffer.byteLength(body), setCookie: response.headers.get('set-cookie'), body }
  } catch (error) {
    return { status: null, error: error.message }
  }
}

/** A fixture turn on the preview, judged in the browser alone. */
/**
 * The fix the preview's two-message conversation waits for (the coordinator's review 57): a follow-up
 * turn on an existing session answered 400. The gate opens when the commit the preview was built from
 * (its `built-from-main` file) contains this commit - read, never assumed.
 */
const CONVERSATION_FIX = '4da44cf'
function conversationGate() {
  let built = null
  try {
    built = (readFileSync(expand('~/.heddle-rust-preview/built-from-main'), 'utf8').match(/[0-9a-f]{7,40}/) ?? [null])[0]
  } catch {}
  if (built === null) return { open: false, built: null, reason: 'the preview names no build commit' }
  try {
    execFileSync('git', ['--no-optional-locks', '-C', REPO, 'merge-base', '--is-ancestor', CONVERSATION_FIX, built], { stdio: 'ignore', timeout: 10_000 })
    return { open: true, built: built.slice(0, 7) }
  } catch {
    return { open: false, built: built.slice(0, 7), reason: `the preview is built from ${built.slice(0, 7)}, which does not contain ${CONVERSATION_FIX}` }
  }
}

/** A preview turn passes only when it landed in the monitor's own session; elsewhere fails it. */
function judgedPreviewTurn(turn) {
  const landed = turn.landing?.landed
  return turn.landing === undefined
    ? { verdict: turn.verdict, detail: turn.detail }
    : landed === 'own'
      ? previewTurnVerdict(turn)
      : landed === 'other'
        ? { verdict: 'fail', detail: turn.detail }
        : { verdict: 'unjudged', detail: turn.detail }
}

async function previewTurn(launch, gate) {
  let pageId
  try {
    pageId = (await callTool('new_page', { url: launch }, 45_000))?.pageId
    if (!(await waitFor(pageId, '#log', 25_000))) return { verdict: 'fail', detail: "the preview's page never drew its log" }
    const turn = await judgeTurn(pageId, (await factsOf(pageId)) ?? null, { deploymentTrace: false })
    const judged = judgedPreviewTurn(turn)
    /**
     * The two-message conversation: once the fix is served, a follow-up goes into the same session on
     * the same page, judged like the first. Before that it is pending and nothing more is sent.
     */
    let conversation = conversationVerdict({ gate, first: judged })
    if (turn.mode === 'real') {
      // One real turn per target per pass (D-052): the follow-up would be a second paid call.
      conversation = { verdict: 'not-sent', detail: 'one real turn per pass (D-052), so no follow-up is sent' }
    } else if (gate?.open === true && judged.verdict === 'pass') {
      const followUp = await judgeTurn(pageId, (await factsOf(pageId)) ?? null, { deploymentTrace: false })
      const second = judgedPreviewTurn(followUp)
      const sameSession = followUp.session?.title !== null && followUp.session?.title === turn.session?.title && followUp.landing?.landed === 'own'
      conversation = { ...conversationVerdict({ gate, first: judged, second, sameSession }), followUp: { landing: followUp.landing ?? null, answerHead: followUp.answerHead ?? null } }
    }
    return {
      mode: turn.mode ?? null,
      selection: turn.selection ?? null,
      conversation: { built: gate?.built ?? null, ...conversation },
      session: turn.session ?? null,
      landing: turn.landing ?? null,
      userAppeared: turn.userAppeared ?? null,
      assistantAppeared: turn.assistantAppeared ?? null,
      firstDeltaMs: turn.firstDeltaMs ?? null,
      settledMs: turn.settledMs ?? null,
      answerHead: turn.answerHead ?? null,
      verdict: judged.verdict,
      detail: judged.detail,
    }
  } catch (error) {
    return { verdict: 'fail', detail: `the preview turn failed: ${error.message}` }
  } finally {
    if (pageId !== undefined) await callTool('close_page', { pageId }, 15_000).catch(() => {})
  }
}

/** 8. The Rust preview: token link 303, /api/endpoints and /api/tree 200, a fixture turn completes. */
async function judgePreview() {
  if (options['no-preview'] === true) return { verdict: 'unjudged', detail: '--no-preview' }
  const agent = agentRunning(PREVIEW_LABEL)
  const launch = existsSync(PREVIEW_LOG) ? launchUrlFromLog(readFileSync(PREVIEW_LOG, 'utf8')) : null
  if (launch === null) return { agentRunning: agent, verdict: 'fail', detail: 'the preview log carries no launch link' }
  const origin = originOf(launch)
  const token = await previewFetch(launch, null)
  const cookie = (token.setCookie ?? '').split(';')[0] || null
  const endpoints = await previewFetch(`${origin}/api/endpoints`, cookie)
  const tree = await previewFetch(`${origin}/api/tree`, cookie)
  const page = await previewFetch(`${origin}/`, cookie)
  // Endpoints are recorded by kind only: a machine's endpoint names can carry private literals, and
  // the pinned JSONL is published through main (public-hygiene gate, 2026-10-29).
  let kinds = null
  try {
    kinds = (JSON.parse(endpoints.body ?? '').endpoints ?? []).map((item) => ({ kind: item.kind ?? null }))
  } catch {}
  let roots = null
  try {
    roots = (JSON.parse(tree.body ?? '').children ?? []).length
  } catch {}
  /**
   * The preview must keep its own session store. Both lists are read with each server's own cookie and
   * compared by id; only the counts are pinned. While they overlap, no preview turn is sent, so a Rust
   * write can never land in the deployment's sessions again.
   */
  const previewSessions = await previewFetch(`${origin}/api/sessions`, cookie)
  let deploymentList = null
  if (launchUrl !== null && serverOrigin !== null) {
    const exchange = await previewFetch(launchUrl, null)
    const deploymentCookie = (exchange.setCookie ?? '').split(';')[0] || null
    const listed = await previewFetch(`${serverOrigin}/api/sessions`, deploymentCookie)
    try {
      deploymentList = JSON.parse(listed.body ?? '')
    } catch {}
  }
  let previewList = null
  try {
    previewList = JSON.parse(previewSessions.body ?? '')
  } catch {}
  const shared = sharedSessions(deploymentList, previewList)
  let command = null
  try {
    const pid = execFileSync('lsof', ['-nP', `-iTCP:${portOf(origin)}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0]
    if (pid) command = execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' }).trim()
  } catch {}
  const turn = !SEND_TURN
    ? { verdict: 'unjudged', detail: '--no-turn' }
    : !PREVIEW_TURN
      ? { verdict: 'unjudged', detail: 'the preview turn is paused (--no-preview-turn) until its session store is separated from the deployment' }
      : shared !== 0
        ? { verdict: 'unjudged', detail: `the preview's sessions are not separate from the deployment's (${shared ?? 'unreadable'} shared), so no turn was sent` }
        : // The turn reads the preview's own catalogue: a fixture turn, or one real turn (D-052).
          await previewTurn(launch, conversationGate())
  const judged = previewVerdict({ tokenStatus: token.status, endpointsStatus: endpoints.status, treeStatus: tree.status, turn, shared, conversation: turn.conversation })
  return {
    origin,
    agentRunning: agent,
    command: command === null ? null : tildeText(command, homedir()),
    token: { status: token.status, httpOnly: /HttpOnly/i.test(token.setCookie ?? ''), sameSiteStrict: /SameSite=Strict/i.test(token.setCookie ?? ''), error: token.error ?? null },
    endpoints: { status: endpoints.status, type: endpoints.type ?? null, bytes: endpoints.bytes ?? null, kinds },
    tree: { status: tree.status, type: tree.type ?? null, bytes: tree.bytes ?? null, roots },
    store: { previewSessions: Array.isArray(previewList) ? previewList.length : null, deploymentSessions: Array.isArray(deploymentList) ? deploymentList.length : null, shared },
    marker: /<meta name="heddle-page" content="([0-9a-f]+)"/.exec(page.body ?? '')?.[1] ?? null,
    turn,
    ...judged,
  }
}

const DEPLOY_LABEL = 'com.dtadpole.heddle-web'
/** The gate on 8082 is its own launchd agent (dsh-web-ops'), restored by nobody on this Mac if it dies. */
const GATE_LABEL = 'ai.reflection.heddle-web-gate'

/** Whether launchd reports an agent as running. Read-only; defaults to the deployment's own agent. */
function agentRunning(label = DEPLOY_LABEL) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501
  try {
    const text = execFileSync('launchctl', ['print', `gui/${uid}/${label}`], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] })
    // The job's own state is the first `state =` line; nested sections carry their own.
    const match = /^\s*state = (\S+)/m.exec(text)
    return match !== null && match[1] === 'running'
  } catch {
    // Not loaded at all: an alert for live-deploy, whose guard owns the restore.
    return false
  }
}

/** Does the gate answer the owner's address with a page right now? A refused connection is null. */
async function gateStatusNow() {
  try {
    const response = await fetch(URL_GATE, { redirect: 'manual', signal: AbortSignal.timeout(3_000) })
    await response.arrayBuffer()
    return response.status
  } catch {
    return null
  }
}

/** Does the deployed server answer its health route right now? */
async function portAnswers() {
  const target = serverOrigin === null ? 'http://127.0.0.1:3082/healthz' : `${serverOrigin}/healthz`
  try {
    const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(3_000) })
    return response.status === 200
  } catch {
    return false
  }
}

/** How long a down reading is watched before it counts as an outage rather than a restart. */
const RESTART_WINDOW_MS = 20_000

/**
 * Poll until the owner's address works again - the server's health route AND the gate's page - or the
 * window closes. Read-only. Watching the server alone called a dead gate a 0 ms "restart".
 */
async function watchForRecovery(windowMs) {
  const started = Date.now()
  while (Date.now() - started <= windowMs) {
    if ((await portAnswers()) && (await gateStatusNow()) === 200) return Date.now() - started
    await new Promise((done) => setTimeout(done, 500))
  }
  return null
}

// ---- the pass ---------------------------------------------------------------------------------

try {
pass.checks.gate = await judgeGate()
pass.checks.process = judgeProcess()
pass.checks.door = await judgeDoor()
/**
 * A down reading is watched before it is pinned. A supervisor restart (or the lane gate's 95 kill
 * test) clears in about a second and is recorded as a restart, not a failure; only a reading that
 * stays down through the window is an outage, which is alerted (with the agent's state) and never
 * acted on: the restore chain belongs to the supervisor and live-deploy's guard (D-045).
 */
if (deploymentDown(pass.checks)) {
  const firstReading = { gate: { status: pass.checks.gate.status ?? null, detail: pass.checks.gate.detail }, door: { detail: pass.checks.door.detail } }
  // Which hop failed, read at the moment of the first reading: the alert must name its owner.
  const hop = outageHop({ gateStatus: pass.checks.gate.status ?? null, serverAnswers: await portAnswers() })
  const recoveredAfterMs = await watchForRecovery(RESTART_WINDOW_MS)
  const kind = classifyOutage({ down: true, recoveredAfterMs, windowMs: RESTART_WINDOW_MS })
  pass.outage = {
    kind,
    hop,
    recoveredAfterMs,
    windowMs: RESTART_WINDOW_MS,
    agentRunning: agentRunning(DEPLOY_LABEL),
    gateAgentRunning: agentRunning(GATE_LABEL),
    firstReading,
  }
  if (kind === 'restart') {
    // A restarted server minted a new launch token: judge the door with the current one.
    refreshDeploymentTarget()
    pass.checks.gate = { ...(await judgeGate()), afterRestart: true }
    pass.checks.process = { ...judgeProcess(), afterRestart: true }
    pass.checks.door = { ...(await judgeDoor()), afterRestart: true }
  }
}
pass.checks.load = pass.checks.gate.verdict === 'pass' ? await judgeLoad() : { verdict: 'unjudged', detail: 'the gate did not serve the app, so the page was not loaded' }
pass.checks.marker = judgeMarker(pass.checks.load)

if (pass.checks.load.verdict === 'pass') {
  const pageId = pass.checks.load.pageId
  pass.checks.consoleOnLoad = await judgeConsole(pageId, 'load')
  pass.checks.turn = DEPLOYMENT_TURN
    ? await judgeTurn(pageId, pass.checks.load.page)
    : { verdict: 'unjudged', detail: 'the deployment turn is paused (--no-deployment-turn)' }
  if (DEPLOYMENT_CONVERSATION) {
    const first = pass.checks.turn
    let conversation = { verdict: 'unjudged', detail: 'the first message did not pass, so no follow-up was sent' }
    if (first.verdict === 'pass') {
      const followUp = await judgeTurn(pageId, (await factsOf(pageId)) ?? null)
      conversation = {
        ...conversationVerdict({ gate: { open: true }, first, second: followUp, sameSession: sameHealthSession(first, followUp) }),
        followUp: { landing: followUp.landing ?? null, answerHead: followUp.answerHead ?? null, settledMs: followUp.settledMs ?? null },
      }
    }
    pass.checks.turn = deploymentTurnWithConversation(first, conversation)
  }
  const after = await judgeConsole(pageId, 'after the turn')
  /**
   * One clean console is the claim. An error at either reading fails it; a reading that could not be
   * taken leaves the claim unjudged - it must never be read as clean. Both readings are kept.
   */
  const consoleVerdicts = [after.verdict, pass.checks.consoleOnLoad.verdict]
  pass.checks.console = {
    ...after,
    verdict: consoleVerdicts.includes('fail') ? 'fail' : consoleVerdicts.includes('unjudged') ? 'unjudged' : 'pass',
    detail: `${after.detail}; on load: ${pass.checks.consoleOnLoad.detail}`,
  }
  await callTool('close_page', { pageId }, 15_000).catch(() => {})
} else {
  for (const name of ['turn', 'console']) pass.checks[name] = { verdict: 'unjudged', detail: 'the page did not load, so it was not judged' }
}

pass.dsh = await judgeDsh()
pass.preview = await judgePreview()
pass.compare = {
  /** The same DOM inventory on both pages; the full parity ledger is the ui lane's, this is the live cross-check. */
  heddle: pass.checks.load.inventory ?? null,
  dsh: pass.dsh.inventory ?? null,
  note: 'counts only; they move with content (session rows in the tree, turns in the log), so compare them at equal content and name a move at equal content as a regression for the ui lane',
}

/**
 * A redeploy can land inside a pass (2026-10-29 11:08Z). The checkout is read again here: when its
 * head or built page moved since the start, a failure measured against the start's build is unjudged
 * and the move is recorded; the next pass judges the new build.
 */
const endBuilt = existsSync(deployment.pagePath) ? readFileSync(deployment.pagePath) : null
const move = deploymentMove(
  { head: deployment.head, marker: deployment.expectedMarker },
  { head: gitAt(DEPLOY_ROOT, 'rev-parse', 'HEAD'), marker: endBuilt === null ? null : createHash('sha256').update(endBuilt).digest('hex').slice(0, 12) },
)
if (move !== null) {
  pass.deploymentMoved = move
  for (const name of Object.keys(pass.checks)) pass.checks[name] = acrossMove(pass.checks[name], move)
}

pass.verdict = passVerdict(pass.checks)

/** The pinned and printed record is redacted at the boundary: home paths under ~, tokens gone. */
const record = redactRecord(pass, homedir())
if (options.pin === true) {
  mkdirSync(dirname(JSONL), { recursive: true })
  appendFileSync(JSONL, `${JSON.stringify(record)}\n`)
}

if (options.json === true) {
  say(JSON.stringify(record, null, 2))
} else {
  const mark = (verdict) => (verdict === 'pass' ? 'pass' : verdict === 'fail' ? 'FAIL' : '----')
  say(`live-health ${pass.at}`)
  say(`deployment  ${deploymentRecord.root} @ ${deployment.headShort ?? 'not a checkout'} (${deployment.branch ?? '?'}), main ${deployment.mainTipShort ?? '?'}${deployment.mainTipFresh ? '' : ' (ref not refreshed)'}, behind ${deployment.behind ?? '?'}, ahead ${deployment.ahead ?? '?'}${deployment.dirty ? `, ${deployment.dirty} uncommitted` : ''}`)
  if (pass.deploymentMoved !== undefined) {
    const moved = pass.deploymentMoved
    say(`moved       the deployment moved during the pass: ${moved.fromHead} -> ${moved.toHead} (page ${moved.fromMarker} -> ${moved.toMarker}); failures are unjudged`)
  }
  say(`gate        ${mark(pass.checks.gate.verdict)}  ${pass.checks.gate.detail}`)
  if (pass.outage !== undefined) {
    say(
      pass.outage.kind === 'restart'
        ? `outage      restart  ${pass.outage.hop} down at first reading, answered again after ${pass.outage.recoveredAfterMs}ms (server agent ${pass.outage.agentRunning ? 'running' : 'not running'}, gate agent ${pass.outage.gateAgentRunning ? 'running' : 'not running'})`
        : `outage      OUTAGE  ${pass.outage.hop} still down after ${pass.outage.windowMs}ms (server agent ${pass.outage.agentRunning ? 'running' : 'not running'}, gate agent ${pass.outage.gateAgentRunning ? 'running' : 'not running'})`,
    )
  }
  say(`process     ${mark(pass.checks.process.verdict)}  ${pass.checks.process.detail}`)
  say(`door        ${mark(pass.checks.door.verdict)}  ${pass.checks.door.detail}`)
  say(`load        ${mark(pass.checks.load.verdict)}  ${pass.checks.load.detail}`)
  say(`marker      ${mark(pass.checks.marker.verdict)}  ${pass.checks.marker.detail}`)
  say(`turn        ${mark(pass.checks.turn.verdict)}  ${pass.checks.turn.detail}`)
  if (pass.checks.turn.conversation) say(`            conversation ${pass.checks.turn.conversation.verdict}: ${pass.checks.turn.conversation.detail}`)
  say(`console     ${mark(pass.checks.console.verdict)}  ${pass.checks.console.detail}`)
  say(`dsh         ${mark(pass.dsh.verdict)}  ${pass.dsh.detail}`)
  say(`preview     ${mark(pass.preview.verdict)}  ${pass.preview.detail}${pass.preview.marker ? ` (marker ${pass.preview.marker})` : ''}`)
  const talk = pass.preview.turn?.conversation
  if (talk !== undefined && talk !== null) say(`            conversation ${talk.verdict}: ${talk.detail}`)
  const digest = (row) => (row === null ? 'not measured' : `${row.interactive} interactive, ${row.enabled} enabled, ${row.nonPointerCursors} non-pointer cursor(s), ${row.hitTestMisses} hit-test miss(es), ${row.clipped} clipped${row.nonPointer?.length > 0 ? ` [${row.nonPointer.join(', ')}]` : ''}`)
  say(`compare     heddle ${digest(pass.compare.heddle)}`)
  say(`            dsh    ${digest(pass.compare.dsh)}`)
  say(`verdict     ${pass.verdict.toUpperCase()}${options.pin === true ? `  pinned to ${JSONL}` : ''}`)
}

} finally {
  /**
   * The browser is closed at the end of every pass, even a pass that threw: this Mac runs twelve seats
   * on 16 GB, and the coordinator measured swap at 79% with a browser left open. `--keep-browser` is
   * for a debugging session, not for the schedule.
   */
  if (options['keep-browser'] !== true) await stopBrowser().catch(() => {})
}

process.exit(pass.verdict === 'pass' ? 0 : pass.verdict === 'fail' ? 1 : 3)
