import type { SessionEvent, SessionHandle, SessionStore } from '../session/store.ts'

/**
 * The clock reading DSH's `dsh-time-context` gives the model, ported for R-developer-nine-7.
 *
 * A reminder is only as good as the model's sense of *now*: `schedule_create` takes an absolute `at`, a local
 * `daily` time or a cron rule, and a model that does not know the current time and zone cannot fill them in. DSH
 * answers that with one durable user-role reading per eligible step, source `{kind 'time-context', form 'snapshot'}`,
 * at most once per refresh interval (ten minutes by default). This module is that reading: a fold over the session
 * log that recovers DSH's three baselines, the decision whether this step gets a reading, and its exact text. The
 * turn loop calls {@link recordTimeContext} once per step, beside the runtime-context snapshot.
 *
 * heddle's log differs from DSH's in two ways, both mapped here. There is no `turn/start` event, so the turn number
 * is one more than the turns already ended (`turn/completed`, `turn/failed`), and the per-turn baseline resets at a
 * turn's end (nothing writes a reading between turns, so this is the same reset). And a reading is a `context/note`
 * event, like the runtime-context snapshot, rather than a `user/message`; it still counts as a model-visible message.
 *
 * Cited as `TC:n`: `dsh-time-context/lib/index.js` of DSH 0.2.1-rc.2.
 */

/** The reading's source kind and its section name (TC:102, 236-243). */
export const TIME_CONTEXT_KIND = 'time-context'

/** DSH's default refresh interval, ten minutes (TC:162). */
export const DEFAULT_REFRESH_INTERVAL_MS = 600_000

/** The three baselines DSH keeps in its `timeContext` projection (TC:103-110). */
export interface TimeContextState {
  /** Time of the latest model-visible event (a user, assistant or tool message, or a model-visible note). */
  readonly lastMessageTime: number | null
  /** Time of the latest reading. */
  readonly lastInjectionTime: number | null
  /** Time of the latest reading in the open turn; null before the turn has one. */
  readonly lastTurnInjectionTime: number | null
}

/** A turn ends with one of these; heddle writes no turn-start event. */
const TURN_ENDS = new Set(['turn/completed', 'turn/failed'])

interface NoteLike {
  readonly role?: string
  readonly source?: { readonly kind?: string; readonly clientTimeZone?: unknown; readonly rpcId?: unknown }
}

const messageOf = (event: SessionEvent): NoteLike | undefined => (event as { message?: NoteLike }).message
const timeOf = (event: SessionEvent): number => Date.parse(event.at)

/** Whether an event is a reading this module wrote. */
export function isTimeContextReading(event: SessionEvent): boolean {
  return event.type === 'context/note' && messageOf(event)?.source?.kind === TIME_CONTEXT_KIND
}

/**
 * Fold a session log into DSH's three baselines (TC:190-213).
 *
 * A turn's end clears the per-turn baseline. Every model-visible message moves `lastMessageTime`: user, assistant and
 * tool messages, a model-visible user-role note (the runtime-context snapshot, a reading) and a tool result. A
 * reading also moves both injection baselines.
 */
export function foldTimeContext(events: readonly SessionEvent[]): TimeContextState {
  let lastMessageTime: number | null = null
  let lastInjectionTime: number | null = null
  let lastTurnInjectionTime: number | null = null
  for (const event of events) {
    if (TURN_ENDS.has(event.type)) {
      lastTurnInjectionTime = null
      continue
    }
    const visible = event.type === 'message' || event.type === 'tool/result' || (event.type === 'context/note' && messageOf(event)?.role === 'user')
    if (!visible) continue
    const time = timeOf(event)
    if (Number.isNaN(time)) continue
    lastMessageTime = time
    if (isTimeContextReading(event)) {
      lastInjectionTime = time
      lastTurnInjectionTime = time
    }
  }
  return { lastMessageTime, lastInjectionTime, lastTurnInjectionTime }
}

/** DSH's compact duration: `Nd Nh Nm Ns`, zero days, hours and minutes left out, seconds always, floored (TC:119-133). */
export function formatDuration(elapsedMs: number): string {
  let seconds = Math.floor(Math.max(0, elapsedMs) / 1000)
  const days = Math.floor(seconds / 86_400)
  seconds %= 86_400
  const hours = Math.floor(seconds / 3600)
  seconds %= 3600
  const minutes = Math.floor(seconds / 60)
  seconds %= 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join(' ')
}

/** DSH's timestamp: local fields, the long numeric offset, and the zone in brackets (TC:68-92). */
export function formatTimestamp(now: number, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  })
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]))
  const offset = String(parts['timeZoneName']).replace(/^GMT$/, 'GMT+00:00').slice(3)
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}:${parts['second']}${offset}[${timeZone}]`
}

/** The browser zone facts for one open turn: one zone, several, or none (TC:30-45). */
export type BrowserTimeZoneContext =
  | { readonly kind: 'resolved'; readonly timeZone: string }
  | { readonly kind: 'mixed'; readonly timeZones: readonly string[] }
  | { readonly kind: 'missing' }

const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/

/**
 * The zones the open turn's person-entered messages carry (TC:10-45).
 *
 * DSH reads `clientTimeZone` from user-rpc sources. A heddle message carries one only if the page sent it, so a turn
 * without one is `missing`, and the reading says so and falls back to the configured or process zone. Unlike DSH,
 * an invalid zone is ignored rather than thrown, because it would come from a stored log, not a live request.
 */
export function deriveBrowserTimeZone(events: readonly SessionEvent[]): BrowserTimeZoneContext {
  let start = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (TURN_ENDS.has(events[index]?.type ?? '')) {
      start = index + 1
      break
    }
  }
  const zones = new Set<string>()
  for (const event of events.slice(start)) {
    if (event.type !== 'message') continue
    const source = messageOf(event)?.source
    const zone = source?.kind === 'user' && typeof source.rpcId === 'string' && typeof source.clientTimeZone === 'string' ? source.clientTimeZone : undefined
    if (zone === undefined || (zone !== 'UTC' && !IANA_TIME_ZONE.test(zone))) continue
    try {
      if (new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone === zone) zones.add(zone)
    } catch {
      // An unsupported zone is not a fact about the request.
    }
  }
  const sorted = [...zones].sort()
  const [timeZone, ...rest] = sorted
  if (timeZone === undefined) return { kind: 'missing' }
  return rest.length === 0 ? { kind: 'resolved', timeZone } : { kind: 'mixed', timeZones: sorted }
}

/** The policy line for the browser zone (TC:51-59). */
export function renderBrowserTimeZone(context: BrowserTimeZoneContext): string {
  switch (context.kind) {
    case 'resolved':
      return `Browser time zone for this request: ${context.timeZone}. Interpret otherwise-unqualified dates and times in this zone.`
    case 'mixed':
      return `Browser time zone for this request: mixed ${JSON.stringify(context.timeZones)}. Ask the user to clarify otherwise-unqualified dates and times.`
    case 'missing':
      return 'Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.'
  }
}

/** What a step needs to decide on a reading. */
export interface TimeContextOptions {
  /** The step's number within its turn, from 1. */
  readonly step: number
  /** Now, in epoch milliseconds. */
  readonly now: number
  /** The interval between readings; 0 gives one on every step. DSH's default when absent. */
  readonly refreshIntervalMs?: number
  /** The zone when the turn carries no browser zone: configured, or the process's own. */
  readonly fallbackTimeZone?: string
}

/**
 * The reading this step should carry, or `undefined` when the last one is recent enough (TC:215-228).
 *
 * The decision is DSH's: skip when a reading exists, is not in the future, and is younger than the interval. The
 * elapsed line counts from the latest model-visible message on a turn's first step, and from the turn's latest
 * reading on later steps.
 */
export function timeContextReading(events: readonly SessionEvent[], options: TimeContextOptions): string | undefined {
  const refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
  if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs < 0) {
    throw new TypeError(`time-context: refreshIntervalMs must be a non-negative safe integer, got ${String(refreshIntervalMs)}`)
  }
  const state = foldTimeContext(events)
  const last = state.lastInjectionTime
  if (refreshIntervalMs > 0 && last !== null && options.now >= last && options.now - last < refreshIntervalMs) return undefined
  const previous = options.step === 1 ? state.lastMessageTime : state.lastTurnInjectionTime
  const turn = 1 + events.filter((event) => TURN_ENDS.has(event.type)).length
  const browser = deriveBrowserTimeZone(events)
  const zone = browser.kind === 'resolved' ? browser.timeZone : (options.fallbackTimeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone)
  const elapsed = previous === null ? 'unavailable' : formatDuration(options.now - previous)
  const baseline = options.step === 1 ? 'model-visible message' : 'step context'
  return `Time sampled while preparing turn ${turn}, step ${options.step}: ${formatTimestamp(options.now, zone)}\n${renderBrowserTimeZone(browser)}\nElapsed since the preceding ${baseline}: ${elapsed}.`
}

/**
 * Append this step's reading to the session when it is due, and say whether one was written.
 *
 * The loop calls it once per step, right after the runtime-context snapshot and before it reads "what did the person
 * say", so the reading is never mistaken for steered input. The note is model-visible and attributed to the harness,
 * as DSH's user-role message is.
 */
export function recordTimeContext(store: SessionStore, handle: SessionHandle, options: Omit<TimeContextOptions, 'now'> & { readonly now?: number }): boolean {
  const text = timeContextReading(store.read(handle), { ...options, now: options.now ?? Date.now() })
  if (text === undefined) return false
  store.append(
    handle,
    {
      type: 'context/note',
      message: { role: 'user', content: [{ type: 'text', text }], source: { kind: TIME_CONTEXT_KIND, form: 'snapshot', sections: [{ name: TIME_CONTEXT_KIND, text }] } },
      origin: TIME_CONTEXT_KIND,
    },
    { surfaceOp: 'append' },
  )
  return true
}
