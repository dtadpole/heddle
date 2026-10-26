/**
 * The judgments of one live-health pass, as pure functions.
 *
 * They live apart from `probe.mjs` for one reason: **a judgment that can be wrong needs a test that
 * can fail**, and a test cannot import a script whose top level starts a browser. Everything here
 * takes numbers or strings and returns a verdict; `probe.mjs` reads the page, this file decides what
 * the reading means. [`_tests_/pass-rules/`](_tests_/pass-rules/unit.test.mjs) judges each rule.
 */

/** Arguments are `--name=value`, or a bare `--flag`. No parser dependency, no second vocabulary. */
export function parseArguments(argv) {
  const named = {}
  for (const argument of argv) {
    if (!argument.startsWith('--')) continue
    const equals = argument.indexOf('=')
    if (equals === -1) named[argument.slice(2)] = true
    else named[argument.slice(2, equals)] = argument.slice(equals + 1)
  }
  return named
}

/**
 * The deployment's current launch URL: the last `heddle web: http://…` line in the log.
 *
 * A launch token is per process, so an older line's token is stale by design and the last line is
 * the one the running server printed. The gate reads the log the same way, and the pass must judge
 * the same credential the owner's URL is served with.
 */
export function launchUrlFromLog(text) {
  const matches = [...String(text).matchAll(/heddle web: (http:\/\/\S+)/g)]
  return matches.length > 0 ? matches[matches.length - 1][1] : null
}

/**
 * A path as the pinned record states it: under the home directory, so a public record never carries
 * the owner's absolute home path. The pass still *uses* the absolute path; only the record is relative.
 */
export function tildePath(path, home) {
  if (typeof path !== 'string' || path.length === 0) return path
  if (typeof home !== 'string' || home.length === 0) return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/**
 * A text with every occurrence of the home directory replaced by `~`.
 *
 * A command line carries paths in the middle (`node /home/me/checkout/dist/cli.js`), so the prefix rule
 * above is not enough: a pinned command must not publish the owner's absolute home path anywhere in it.
 */
export function tildeText(text, home) {
  if (typeof text !== 'string' || typeof home !== 'string' || home.length === 0) return text
  return text.split(home).join('~')
}

/**
 * The server's own door, both halves.
 *
 * A bare request must be refused with `401` and the token form (and never served the app), and the
 * current launch URL must exchange for a `303` carrying an `HttpOnly`, `SameSite=Strict` cookie. One
 * without the other is a failure: a wall with no way in, or a way in with no wall. There is no
 * "partial" verdict, because a partial door is not a pass and a reader must not be able to mistake it
 * for one.
 */
export function doorVerdict({ reachable, bareStatus, form, app, exchangeStatus, cookie }) {
  if (reachable === false) return { verdict: 'unjudged', detail: 'not reachable' }
  const wall = bareStatus === 401 && form === true && app !== true
  const admitted = exchangeStatus === 303 && cookie !== null && cookie !== undefined && cookie.httpOnly === true && cookie.sameSite === true
  if (wall && admitted) return { verdict: 'pass', detail: '401 without a credential, 303 with the current token, HttpOnly SameSite=Strict cookie' }
  if (!wall) return { verdict: 'fail', detail: `the deployed server answered ${bareStatus} without a credential${app === true ? ' with the app shell' : ''}` }
  return { verdict: 'fail', detail: `the current launch URL did not exchange for a valid cookie (${exchangeStatus})` }
}

/**
 * Whether an answer is the gate's own "upstream is gone" sentence.
 *
 * The app shell itself contains the word `heddle-proxy` once (a comment about the gate), so matching
 * the word on any status pinned a healthy pass as a proxy error with `firstLine: "<!doctype html>"`.
 * The gate's error is a plain-text `5xx` whose body starts with its own prefix; only that counts.
 */
export function looksLikeProxyError(status, body) {
  return (status === 502 || status === 503 || status === 504) && /^heddle-proxy\b/m.test(String(body))
}

/** The gate's answer: the app shell, or its own sentence saying the upstream is gone. */
export function gateVerdict({ status, app, proxyError, firstLine }) {
  if (status === 200 && app === true) return { verdict: 'pass', detail: 'the gate served the app shell' }
  if (proxyError === true) return { verdict: 'fail', detail: `the gate could not reach the deployment: ${firstLine ?? 'no detail'}` }
  return { verdict: 'fail', detail: `the gate answered ${status} without the app shell${firstLine ? `: ${firstLine}` : ''}` }
}

/**
 * The app shell.
 *
 * `exchangeStatus` is the direct door's `303` when the pass opened the server's own launch URL; it is
 * `null` when the shell was served through the gate, which does the exchange itself — passing `200`
 * here would pretend the gate answered a token exchange it does not have.
 */
export function shellVerdict({ exchangeStatus = null, loaded, log, composer, send, tokenForm }) {
  if (exchangeStatus !== null && exchangeStatus !== 303) return { verdict: 'fail', detail: `the launch URL did not exchange a token (${exchangeStatus})` }
  if (loaded === true && log === true && composer === true && send === true) return { verdict: 'pass', detail: 'the app shell loaded with a token' }
  if (loaded === true && log === true) return { verdict: 'fail', detail: 'the log loaded but the composer or its send control is missing' }
  if (tokenForm === true) return { verdict: 'fail', detail: 'a token form instead of the app: the launch token is stale' }
  return { verdict: 'fail', detail: 'the app shell did not load' }
}

/**
 * The build marker.
 *
 * The served `meta[name=heddle-page]` must equal the first twelve hex of the sha256 of the
 * deployment checkout's own `dist/server/page.html` (`markedPage` in `src/server/web.ts`). A matching
 * marker proves the served page is that checkout's build; a page that did not load has no served
 * marker, so the claim is unjudged rather than failed. HEAD against main's tip is staleness and is
 * deliberately not part of this verdict.
 */
export function markerVerdict({ served, expected, loaded }) {
  if (loaded !== true) return { verdict: 'unjudged', detail: 'the page did not load, so no served marker exists to compare' }
  if (expected === null || expected === undefined) return { verdict: 'unjudged', detail: 'no built page to compare against' }
  if (served === null || served === undefined) return { verdict: 'fail', detail: 'the served page carries no heddle-page marker' }
  return served === expected
    ? { verdict: 'pass', detail: `the served page is the deployment build (${served})` }
    : { verdict: 'fail', detail: `the served page is not this build: served ${served}, this checkout builds ${expected}` }
}

/**
 * The document the server must serve: the built page with its marker substituted.
 *
 * `markedPage` in `src/server/web.ts` replaces the `<meta name="heddle-page" content="unbuilt">`
 * placeholder with the first twelve hex of the file's own sha256. Comparing the whole served body to
 * this string is the strongest form of the marker claim — a matching marker alone proves only that
 * some page carries the hash, not that the served document is the build (`96-deployment` makes the
 * same comparison byte for byte).
 */
export function expectedPage(built, marker) {
  return String(built).replace(/<meta name="heddle-page"[^>]*>/, `<meta name="heddle-page" content="${marker}">`)
}

/** The console: error-level messages fail, warnings and verbose messages are evidence. */
export function consoleVerdict(messages) {
  const list = Array.isArray(messages) ? messages : []
  const errors = list.filter((message) => message.type === 'error')
  const warnings = list.filter((message) => message.type === 'warning')
  return {
    total: list.length,
    errors: errors.length,
    warnings: warnings.length,
    sample: errors.slice(0, 3).map((message) => String(message.text ?? '').slice(0, 240)),
    verdict: errors.length === 0 ? 'pass' : 'fail',
    detail: errors.length === 0 ? `no console errors (${list.length} message(s), ${warnings.length} warning(s))` : `${errors.length} console error(s)`,
  }
}

/**
 * One streamed turn.
 *
 * The page must draw the user row and the answer, the answer must have arrived as a **stream** (two
 * or more chunks in the deployment's record, or two lengths seen growing in the page — a scripted
 * answer can land between two 200 ms polls, so the deployment's own chunk count is the mechanism's
 * record), the turn must settle, and no notice may say it was refused.
 */
export function turnVerdict({ userAppeared, assistantAppeared, chunks, samples, settledMs, notices }) {
  const sampleCount = Array.isArray(samples) ? samples.length : 0
  const noticeCount = Array.isArray(notices) ? notices.length : 0
  const streamed = (chunks ?? 0) >= 2 || sampleCount >= 2
  const passed = userAppeared === true && assistantAppeared === true && streamed && settledMs !== null && noticeCount === 0
  return {
    streamed,
    verdict: passed ? 'pass' : 'fail',
    detail: passed
      ? `answer streamed: ${chunks ?? '?'} chunk(s) recorded by the deployment, ${sampleCount} sample(s) seen in the page, settled at ${settledMs}ms`
      : noticeCount > 0
        ? `the turn was refused: ${notices.join(' / ').slice(0, 200)}`
        : userAppeared !== true
          ? 'the submitted prompt never appeared as a turn'
          : assistantAppeared !== true
            ? 'the answer never appeared'
            : settledMs === null
              ? 'the answer never settled within the wait'
              : 'the answer arrived whole, not as a stream',
  }
}

/**
 * Which checkout is serving the port.
 *
 * The build marker binds the **page bytes** to a checkout; it cannot tell whether the process behind
 * the port runs that checkout — a repointed or half-reloaded service can serve an old build whose
 * `page.html` is byte-identical to the new one. This reads the listener's own command line, which is
 * the fact `96-deployment` judges from the installed agent. A process that runs a `heddle` binary
 * instead of the checkout's `dist/cli.js` is unjudged here (the binary's own identity is the Rust
 * port's concern), not failed.
 */
export function processVerdict({ command, deployRoot, home }) {
  if (typeof command !== 'string' || command.length === 0) return { verdict: 'unjudged', detail: 'no process owns the deployed port, so the checkout it runs cannot be named' }
  const shown = tildeText(command, home)
  const expected = `${deployRoot}/dist/cli.js`
  if (command.includes(expected)) return { verdict: 'pass', detail: `the process answering the port runs this checkout's cli (${tildePath(expected, home)})` }
  if (/\bheddle\b/.test(shown) && !shown.includes('/dist/cli.js')) {
    return { verdict: 'unjudged', detail: `the port is served by a heddle binary rather than the checkout's dist/cli.js: ${shown}` }
  }
  return { verdict: 'fail', detail: `the port is served by another checkout or command, not ${tildePath(expected, home)}: ${shown}` }
}

/**
 * Whether the reads say the deployment is **down**, which is the only state in which the delegated
 * kickstart may run. Two readings count: the gate saying its upstream is gone (`502`, its own
 * `heddle-proxy` sentence, or no answer at all), and the server's port not answering. A gate that
 * answers a different error, or a server that answers and refuses, is unhealthy but not down — a
 * restart is not the fix for it, so it must not be taken.
 */
export function deploymentDown({ gate, door }) {
  const gateDown = gate?.verdict === 'fail' && (gate.proxyError === true || gate.status === null || gate.status === undefined)
  const doorDown = door?.verdict === 'fail' && /does not answer/.test(String(door.detail ?? ''))
  return gateDown === true || doorDown === true
}

/**
 * A record safe to publish: home paths under `~`, and a launch token redacted wherever it appears.
 *
 * A runtime error message can carry `~/.heddle/...` or an absolute home path, and the answer head is
 * model output. The record is pinned in a public repository, so both are redacted at the boundary
 * rather than trusted to stay clean.
 */
export function redactRecord(value, home) {
  if (typeof value === 'string') return tildeText(value, home).replace(/token=[A-Za-z0-9_-]+/g, 'token=<redacted>')
  if (Array.isArray(value)) return value.map((entry) => redactRecord(entry, home))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) out[key] = redactRecord(entry, home)
    return out
  }
  return value
}

/**
 * Which hop of the owner's address failed.
 *
 * `8082` is the gate (its own launchd agent), `3082` the server behind it. They fail differently and
 * are restored by different owners, so an alert must say which:
 *
 * - `gate`   - the gate refuses connections (no status at all) while the server answers: the gate
 *   process is gone, and on this Mac launchd does not restart it (live-deploy, 2026-10-22);
 * - `server` - the server does not answer; the gate's own 502 is the same fact seen from 8082;
 * - `both`   - neither answers;
 * - `none`   - both answer.
 */
export function outageHop({ gateStatus, serverAnswers }) {
  const gateRefused = gateStatus === null || gateStatus === undefined
  if (!gateRefused && serverAnswers === true) return 'none'
  if (gateRefused && serverAnswers === true) return 'gate'
  if (gateRefused && serverAnswers !== true) return 'both'
  return 'server'
}

/**
 * What a "down" reading was, once the pass has watched it.
 *
 * With a supervisor in the agent, a killed server is back in about a second, and the lane gate's
 * `95-web-daemon` check kills the port's owner by design - so a single 502 instant is usually a
 * restart, not an outage (live-deploy, 2026-10-22). The pass re-probes for a window before pinning:
 *
 * - `healthy` - the first reading was not down;
 * - `restart` - it was down and answered again within the window: recorded, not a failure;
 * - `outage`  - it stayed down through the window: a failure, and the restore rule decides the rest.
 */
export function classifyOutage({ down, recoveredAfterMs, windowMs }) {
  if (down !== true) return 'healthy'
  if (typeof recoveredAfterMs === 'number' && recoveredAfterMs <= windowMs) return 'restart'
  return 'outage'
}

/**
 * One pinned pass as a table row, so the human view is derived from the record rather than kept by
 * hand. The record is the JSONL; a table written in prose falls behind the first pass after it.
 */
export function summaryRow(entry) {
  const checks = entry?.checks ?? {}
  const mark = (check) => (check === undefined ? '-' : check.verdict === 'pass' ? 'pass' : check.verdict === 'fail' ? 'FAIL' : '----')
  const outage = entry?.outage === undefined ? '' : entry.outage.kind === 'restart' ? `restart ${entry.outage.recoveredAfterMs}ms` : 'OUTAGE'
  const deployment = entry?.deployment ?? {}
  const stale = typeof deployment.behind === 'number' && deployment.behind > 0 ? ` (behind ${deployment.behind})` : ''
  return [
    String(entry?.at ?? '?').replace('T', ' ').slice(0, 19) + 'Z',
    `${String(deployment.headShort ?? '?').slice(0, 7)}${stale}`,
    mark(checks.gate),
    mark(checks.process),
    mark(checks.door),
    mark(checks.load),
    mark(checks.marker),
    mark(checks.turn),
    mark(checks.console),
    outage,
    String(entry?.verdict ?? '?').toUpperCase(),
    mark(entry?.preview),
  ]
}

/** The pass: any failure fails it, any unjudged check leaves it unjudged, only all-pass passes. */
export function passVerdict(checks) {
  const verdicts = Object.values(checks).map((check) => check.verdict)
  // Anything that is not a pass or an explicit unjudged is a failure: an unknown verdict must never
  // be read as healthy, which is how a 'partial' door would have slipped through.
  if (verdicts.some((verdict) => verdict !== 'pass' && verdict !== 'unjudged')) return 'fail'
  if (verdicts.includes('unjudged')) return 'unjudged'
  return 'pass'
}

/** The first words of the offline fixture's answer, which no real model writes. */
export const FIXTURE_PREFIX = 'scripted endpoint: offline fixture reply'

/**
 * Whether every configured endpoint is the offline fixture, read from `/api/endpoints`.
 *
 * Decided before a turn is sent, so the pass never spends a real model call: an empty list or any
 * other kind is "no", and the turn is not sent.
 */
export function fixtureOnly(endpoints) {
  return Array.isArray(endpoints) && endpoints.length > 0 && endpoints.every((endpoint) => endpoint?.kind === 'scripted')
}

/**
 * How many session ids two servers both list. The preview must keep its own store: any overlap means
 * its writes can land in the deployment's sessions (live-deploy, 2026-10-22). Null when either list
 * could not be read.
 */
export function sharedSessions(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return null
  const ids = new Set(left.map((item) => item?.id).filter((id) => id !== undefined && id !== null))
  return right.filter((item) => ids.has(item?.id)).length
}

/**
 * Where a turn landed, from the session lists read before and after it (id and `updated` of each).
 *
 * The monitor may write only into a session it owns: the reused health session or one it has just
 * started. `own` - the target changed; `other` - the target did not change but another session did,
 * so the turn went into someone else's session (the preview's 06:48 and 07:08 turns of 2026-10-23
 * did exactly that); `unknown` - nothing changed, or a list could not be read. Another session that
 * changed beside the target is counted, not blamed: a person may be working at the same time.
 */
export function turnLanding({ target, before, after }) {
  if (typeof target !== 'string' || !Array.isArray(before) || !Array.isArray(after)) return { landed: 'unknown', othersChanged: null }
  const was = new Map(before.map((item) => [item?.id, item?.updated ?? null]))
  const changed = after.filter((item) => !was.has(item?.id) || was.get(item?.id) !== (item?.updated ?? null)).map((item) => item?.id)
  const othersChanged = changed.filter((id) => id !== target).length
  if (changed.includes(target)) return { landed: 'own', othersChanged }
  return { landed: othersChanged > 0 ? 'other' : 'unknown', othersChanged }
}

/**
 * A two-message conversation in one session on the preview: both turns completed with the fixture
 * answer, both landed in the monitor's own session, and the second followed the first in the same
 * session. The coordinator asked for it once the follow-up-turn fix (4da44cf) is served; before that
 * it is `pending` and is not part of the preview's verdict.
 */
export function conversationVerdict({ gate, first, second, sameSession }) {
  if (gate?.open !== true) return { verdict: 'pending', detail: gate?.reason ?? 'the preview does not serve the fix yet' }
  if (first?.verdict !== 'pass') return { verdict: first?.verdict === 'unjudged' ? 'unjudged' : 'fail', detail: `the first message: ${first?.detail ?? 'not sent'}` }
  if (second?.verdict !== 'pass') return { verdict: second?.verdict === 'unjudged' ? 'unjudged' : 'fail', detail: `the follow-up message: ${second?.detail ?? 'not sent'}` }
  if (sameSession !== true) return { verdict: 'fail', detail: 'the follow-up did not stay in the same session' }
  return { verdict: 'pass', detail: 'a two-message conversation completed in one session' }
}

/**
 * Whether a follow-up stayed in the monitor's own health session. It must have landed `own`; when the
 * first turn named its session the follow-up must name the same one, and when the first turn had to
 * start a session (no title yet) the follow-up must have continued an existing one, which is then the
 * session the first turn just started, the newest with the monitor's prefix.
 */
export function sameHealthSession(first, followUp) {
  if (followUp?.landing?.landed !== 'own') return false
  const title = first?.session?.title ?? null
  return title === null ? followUp?.session?.reused === true : followUp?.session?.title === title
}

/**
 * The deployment's two-message check (opt-in, `--deployment-conversation`): a follow-up on the same
 * page load. With the flag the turn check claims both messages, so a follow-up that failed or could
 * not be judged decides the turn's verdict; a first message that failed keeps its own story. The
 * conversation is kept beside the turn in every case.
 */
export function deploymentTurnWithConversation(first, conversation) {
  if (conversation === null || conversation === undefined) return first
  if (conversation.verdict === 'pass' || first?.verdict !== 'pass') return { ...first, conversation }
  return { ...first, verdict: conversation.verdict, detail: `${first.detail}; ${conversation.detail}`, conversation }
}

/** A fixture turn on the Rust preview completed: the prompt and an answer appeared, it settled, and it is the fixture's. */
export function previewTurnVerdict({ userAppeared, assistantAppeared, settled, answerHead }) {
  if (userAppeared !== true) return { verdict: 'fail', detail: 'the prompt never appeared in the log' }
  if (assistantAppeared !== true) return { verdict: 'fail', detail: 'no answer appeared' }
  if (settled !== true) return { verdict: 'fail', detail: 'the answer never settled' }
  if (!String(answerHead ?? '').startsWith(FIXTURE_PREFIX)) return { verdict: 'fail', detail: "the answer is not the fixture's" }
  return { verdict: 'pass', detail: 'a fixture turn completed' }
}

/**
 * The Rust preview on 3097, a second read-only target: the token link answers 303, `/api/endpoints`
 * and `/api/tree` answer 200, and a fixture turn completes. It never changes the deployment's verdict.
 */
export function previewVerdict({ tokenStatus, endpointsStatus, treeStatus, turn, shared, conversation }) {
  const checks = {
    // Counted only once its gate is open; a pending conversation is recorded, never judged.
    ...(conversation !== undefined && conversation.verdict !== 'pending' ? { conversation: ['pass', 'fail'].includes(conversation.verdict) ? conversation.verdict : 'unjudged' } : {}),
    store: shared === 0 ? 'pass' : typeof shared === 'number' ? 'fail' : 'unjudged',
    token: tokenStatus === 303 ? 'pass' : 'fail',
    endpoints: endpointsStatus === 200 ? 'pass' : 'fail',
    tree: treeStatus === 200 ? 'pass' : 'fail',
    turn: turn?.verdict === 'pass' || turn?.verdict === 'fail' ? turn.verdict : 'unjudged',
  }
  const failing = Object.entries(checks).filter(([, verdict]) => verdict === 'fail').map(([name]) => name)
  const unjudged = Object.entries(checks).filter(([, verdict]) => verdict === 'unjudged').map(([name]) => name)
  const verdict = failing.length > 0 ? 'fail' : unjudged.length > 0 ? 'unjudged' : 'pass'
  const detail =
    verdict === 'pass'
      ? 'own session store, token link 303, /api/endpoints 200, /api/tree 200, a fixture turn completed'
      : [failing.length > 0 ? `failing: ${failing.join(', ')}` : null, unjudged.length > 0 ? `unjudged: ${unjudged.join(', ')}` : null].filter(Boolean).join('; ')
  return { verdict, checks, detail }
}
