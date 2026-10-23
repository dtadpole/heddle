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
 * The bare URL's door.
 *
 * `401` with the token form and no app shell is the passed state; an app served without a credential
 * is a failure (a page that lost its data looks like this); any other status is a failure too. A
 * deployment that does not answer is unjudged, never passing.
 */
export function doorVerdict({ reachable, status, form, app }) {
  if (reachable === false) return { verdict: 'unjudged', detail: 'not reachable' }
  if (status === 401 && form === true && app !== true) return { verdict: 'pass', detail: 'refused with the token form' }
  if (status === 401) return { verdict: 'partial', detail: 'refused without the token form' }
  return { verdict: 'fail', detail: `answered ${status} without a credential` }
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
export function shellVerdict({ exchangeStatus = null, loaded, log, composer, tokenForm }) {
  if (exchangeStatus !== null && exchangeStatus !== 303) return { verdict: 'fail', detail: `the launch URL did not exchange a token (${exchangeStatus})` }
  if (loaded === true && log === true && composer === true) return { verdict: 'pass', detail: 'the app shell loaded with a token' }
  if (loaded === true && log === true && composer === true) return { verdict: 'pass', detail: 'the app shell loaded with a token' }
  if (loaded === true && log === true) return { verdict: 'fail', detail: 'the log loaded but the composer is missing' }
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

/** The pass: any failure fails it, any unjudged check leaves it unjudged, only all-pass passes. */
export function passVerdict(checks) {
  const verdicts = Object.values(checks).map((check) => check.verdict)
  if (verdicts.includes('fail')) return 'fail'
  if (verdicts.includes('unjudged')) return 'unjudged'
  return 'pass'
}
