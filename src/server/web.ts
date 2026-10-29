import { contextWindowFromModelList } from '../llm/model-info.ts'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import { runTurn } from '../agent/loop.ts'
import { describeContent, reasoningLevelFor } from '../llm/types.ts'
import { AttachmentInputError, readAttachments } from './attachments.ts'
import { logFileName } from './log-download.ts'
import { MAX_UPLOAD_BYTES, saveUpload, UPLOAD_NOT_REFERENCED, uploadDirectory, uploadReferencedBy } from './uploads.ts'
import { renderSource } from './code.ts'
import { pickFolder } from './picker.ts'
import { createDirectory, DirectoryError, listDirectory } from './directories.ts'
import { contextBreakdownWithFallback, projectLedger, projectRows, projectSessionStats, projectTimeline } from './ledger.ts'
import { catalogOf } from './tool-catalog.ts'
import { inspectTool } from './tool-inspector.ts'
import { PREVIEW_CSP, rewriteResources } from './html.ts'
import { renderMarkdown } from './markdown.ts'
import { expandHome } from '../config/schema.ts'
import { describeEndpoints, selectionProblem } from '../endpoints.ts'
import { canonicalPath, isUnder } from '../paths.ts'
import { readSessionDefinition, updateSessionDefinition } from '../session/definition.ts'
import { permissionTransition } from '../sandbox/service.ts'
import { readFileText, tree } from '../session/tree.ts'
import type { SessionEvent, SessionHandle, SessionMeta } from '../session/store.ts'
import { SessionFlagError } from '../session/store.ts'
import { handleScheduleRoute } from '../schedule/http.ts'
import {
  COOKIE_MAX_AGE,
  cookieHeader,
  cookieName,
  createLaunchToken,
  mintCookie,
  readCookie,
  readOrCreateSecret,
  safeEqual,
  TOKEN_QUERY,
  authorize,
} from './token.ts'
import { EventLog, heartbeatFrame, heartbeatInterval, newClientId, readyFrame, resetFrame, StallWatch, STREAM_OPEN, withoutSettledApprovals } from './stream.ts'

/**
 * The Web UI.
 *
 * Modelled on DSH's, with one deliberate difference and the reasons stated:
 *
 * - **`node:http`, no framework.** DSH uses raw `createServer` with a small routing
 *   table and so does this. A UI that serves one page and four endpoints does not
 *   need a router library, and a dependency here would be the largest thing in the
 *   package.
 * - **Loopback only, and it says so.** DSH refuses `0.0.0.0` because a harness that
 *   runs tools over a network is a remote code execution service. This binds
 *   `127.0.0.1` and refuses any other host with an error rather than a warning.
 * - **`?token=` on the root, then a cookie.** DSH's handshake: the printed URL carries
 *   a per-process token, the root exchange sets an HttpOnly cookie, and everything
 *   after that is the cookie. The launch token is never stored.
 * - **SSE rather than a WebSocket mux.** DSH multiplexes a full RPC client over a
 *   socket; this UI only **streams**, and a browser cannot set a header on a WebSocket
 *   handshake, so a stream that a cookie alone authenticates is the smaller mechanism.
 * - **A Host and Origin fence before authentication.** DSH's `requestRejection` runs
 *   first, and the ordering matters: a request from a page that is not this page is
 *   refused before any secret is compared.
 */

/**
 * The default port.
 *
 * **3082**, because on this machine 3080 is `dsh web` and 3081 is a Python relay that also
 * serves a DeepSeek Harness page. Measured, not assumed: 3081 was the number asked for, and
 * `lsof` showed it already held, which would have made `heddle web` fail to bind on the very
 * machine it is developed on. 3082 is the next free port in the same range and keeps the three
 * services one number apart, which is easier to remember than an arbitrary free one.
 */
export const DEFAULT_PORT = 3082
/** The default host. Anything else is refused. */
export const DEFAULT_HOST = '127.0.0.1'

/**
 * **No round cap for an interactive turn** — DSH's own rule, measured rather than chosen.
 *
 * The reference's agent loop has no step limit at all: a step runs the model, and the loop continues while the
 * answer keeps asking for tools, ending on a normal finish, `max-tokens`, or the person's stop; long contexts are
 * handled by compaction, not by cutting the turn. Its own session logs show how far that goes — across 266 sessions
 * and 1,617 turns, the largest turn took **436 steps**, 283 turns exceeded 32 and 59 exceeded 100, with 333
 * `compaction/prune` events doing the bounding. The owner's "backend stopped to respond" was this server applying
 * the loop's one-shot default of eight to an interactive turn.
 *
 * A cap is therefore **operator-only**: `heddle web --max-rounds N` slows the loop down on purpose, and the loop
 * reports it as a stop. The one-shot CLI default of eight stays, because cutting an unattended turn is a different
 * decision from cutting one a person is watching.
 */
export const DEFAULT_WEB_MAX_ROUNDS = Number.POSITIVE_INFINITY

export interface WebServerOptions {
  readonly host?: string
  readonly port?: number
  /** Rounds one interactive turn may take; unbounded when absent, which is the reference's rule. */
  readonly maxRounds?: number
  /** Where the cookie-signing secret lives. */
  readonly secretPath?: string
  /** The launch token; generated when absent, which is the normal case. */
  readonly token?: string
  /** Whether to print the URL line. Off in checks, on for a person. */
  readonly quiet?: boolean
  /**
   * The endpoint a turn uses when the request does not name one.
   *
   * Without this the API fell back to the first configured endpoint, so `heddle web --endpoint
   * double` started a server that answered from `scripted` — measured, and it made a check fail
   * with "the script for 'scripted' could not be read" while the server's own output said
   * `double` was configured.
   */
  readonly defaultEndpoint?: string
}

export interface WebServer {
  readonly url: string
  readonly token: string
  readonly port: number
  readonly host: string
  close(): Promise<void>
}

/** What the caller learns when the server is up, before it starts serving. */
export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1'
}

/**
 * Start the server.
 *
 * Returns once it is listening, so a caller can print the URL and open a browser
 * without racing the socket.
 */
export async function startWebServer(ctx: Context, options: WebServerOptions = {}): Promise<WebServer> {
  const host = options.host ?? DEFAULT_HOST
  if (!isLoopback(host)) {
    throw new Error(
      `refusing to bind ${host}: the Web UI runs tools, so exposing it is remote code execution behind a token. Use ${DEFAULT_HOST}.`,
    )
  }
  const port = options.port ?? DEFAULT_PORT
  const token = options.token ?? createLaunchToken()
  const secret = readOrCreateSecret(options.secretPath)

  const clients = new Set<ServerResponse>()
  const subscribers = new Set<ServerResponse>()
  /** Sessions with a turn in flight, which is what the steer route asks about before it accepts one. */
  const running = new Map<string, number>()
  /** The handles a stop aborts, per session. */
  const controllers = new Map<string, Set<AbortController>>()
  /** When each running session's turn began; one clock per server, read by the sessions route. */
  const runningSince = new Map<string, number>()
  /**
   * When each session's last turn **completed**.
   *
   * `running` says a turn is going; this says one recently stopped and when. A page that missed the end — a reload,
   * a dropped stream — can decide against a completion instead of guessing from its own event history, and the
   * running row is not drawn for a session whose last turn completed after it started.
   */
  const completedAt = new Map<string, number>()
  // Tracked so shutdown can reach a connection whose handler is still awaiting a turn.
  const sockets = new Set<import('node:net').Socket>()

  /**
   * The stream's log: every frame pushed to `/api/events` gets an id from it and is kept for a while, so a client
   * that reconnects is given what it missed (the follow cursor, `stream.ts`). The heartbeat interval is fixed here
   * too, because `ready` tells the page what silence means.
   */
  const log = new EventLog()
  const heartbeatMs = heartbeatInterval()

  // Every append is pushed to whoever is listening, from the one write path.
  ctx.on('session/event', (payload) => {
    const line = log.record('session', JSON.stringify(payload))
    for (const client of subscribers) {
      client.write(line)
    }
  })

  // A committed reminder write, so the page's reminder views refresh (DSH's `schedule/changed`).
  ctx.on('schedule/changed', () => {
    // Through the stream's log, so the frame is numbered and replayed to a page that reconnects, as the Rust hub's
    // publish already does for the same event (phase B item 3).
    const line = log.record('schedule', '{}')
    for (const client of subscribers) client.write(line)
  })

  /**
   * A running turn's **next** model call is answered by the session's current record.
   *
   * This is DSH's running-turn rule, measured on 2026-10-17: its seat stays enabled while a turn streams and
   * a switch lands on a later step rather than on the next turn. Heddle's loop builds a request per round
   * with the selection the turn started with, so without this seam a switch made mid-turn would be visible in
   * the seat and ignored by the turn that was already running.
   *
   * The `model/request` waterfall is the project's existing version of that seam (`ModelService` documents it
   * as "how a model-selection policy works"), and the loop carries the session id in every request, so the
   * rule is one listener rather than a second loop.
   *
   * The record is authoritative only where it can be enforced: an endpoint the run still has, and a level the
   * model still declares. A record that cannot be applied leaves the request untouched rather than half-rewriting
   * it, because a request addressed to no endpoint is not a better answer than the one the turn asked for.
   */
  ctx.on('model/request', (request, next) => {
    const resolved = next()
    const id = resolved.sessionId
    if (id === undefined) return resolved
    const meta = ctx.session.list().find((entry) => entry.id === id)
    const selection = sessionRequestSelection(meta)
    if (selection.endpoint === undefined || !ctx.model.names().includes(selection.endpoint)) return resolved
    const configured = ctx.model.endpoint(selection.endpoint)
    const enforceable =
      configured !== undefined &&
      selection.reasoningEffort !== undefined &&
      reasoningLevelFor(configured, selection.model, selection.reasoningEffort) !== undefined
    const { model: _previousModel, reasoningEffort: _previousEffort, ...rest } = resolved
    return {
      ...rest,
      endpoint: selection.endpoint,
      ...(selection.model !== undefined ? { model: selection.model } : {}),
      ...(enforceable && selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
    }
  })

  /**
   * The Web UI is the surface that answers approval questions.
   *
   * Attaching is what changes an `ask` policy from "nobody can answer, so deny" into a card a person can answer:
   * while this server is up, a tool's escalation ask is emitted, pushed down the same event stream the session
   * uses, and settled by the `POST /api/approvals/<id>` route. A CLI run attaches nothing and gets the
   * `unanswered` answer immediately, which is how a headless turn avoids waiting for a card nobody can see.
   */
  const approvals = ctx.get('approvals') as
    | {
        attachAnswerer?: () => () => void
        pendingRequests?: () => readonly unknown[]
        answer?: (id: string, outcome: 'allowed-once' | 'rejected' | 'cancelled') => boolean
      }
    | undefined
  const detachApprovals = approvals?.attachAnswerer?.()
  ctx.on('approval/request', (request) => {
    const line = log.record('approval', JSON.stringify(request))
    for (const client of subscribers) {
      client.write(line)
    }
  })

  const server: Server = createServer((request, response) => {
    /**
     * A request handler that throws must not take the server with it.
     *
     * `void` on a promise discards its rejection, so an error anywhere in a route became an
     * unhandled rejection and killed the process — which then made the *next* check fail with
     * "fetch failed", a message about the wrong thing entirely.
     */
    void handle(ctx, request, response, {
      token,
      secret,
      host,
      port,
      clients,
      subscribers,
      log,
      heartbeatMs,
      running,
      controllers,
      runningSince,
      completedAt,
      maxRounds: options.maxRounds ?? DEFAULT_WEB_MAX_ROUNDS,
      ...(options.quiet !== undefined ? { quiet: options.quiet } : {}),
      ...(options.defaultEndpoint !== undefined ? { defaultEndpoint: options.defaultEndpoint } : {}),
    }).catch((error: unknown) => {
      if (!response.writableEnded && !response.destroyed) {
        try {
          response.writeHead(500, { 'content-type': 'text/plain' })
          response.end(`internal error: ${(error as Error).message}\n`)
        } catch {
          // the socket is already gone
        }
      }
    })
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  /**
   * The heartbeat: every interval each stream gets a `heartbeat` frame, and every connection that took no bytes for
   * two intervals while it still had some to send is destroyed (DSH's dead-peer rule, see `stream.ts`). One timer
   * for the server, unref'd so it never keeps a process alive on its own.
   */
  const stalls = new StallWatch(heartbeatMs)
  const heartbeat = setInterval(() => {
    const frame = heartbeatFrame()
    for (const client of subscribers) {
      try {
        client.write(frame)
      } catch {
        // a client that is already gone leaves through its close listener
      }
    }
    stalls.sweep(sockets, Date.now())
  }, heartbeatMs)
  heartbeat.unref()

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolvePromise())
  })

  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port
  const url = `http://${host}:${boundPort}/?${TOKEN_QUERY}=${token}`

  return {
    url,
    token,
    host,
    port: boundPort,
    /**
     * Stop the server, streams and all.
     *
     * `server.close()` only stops accepting and then waits for every open connection, and an
     * event stream is open by design — so the close callback never fired while a client was
     * subscribed. Measured: that is what made the Web UI verifier run for minutes and then
     * leave `node --test` reporting "the event loop has already resolved" with a pending
     * promise. Ending the subscribers first, then destroying whatever sockets remain, is the
     * difference between closing and stopping.
     */
    close: () =>
      new Promise<void>((resolvePromise) => {
        clearInterval(heartbeat)
        detachApprovals?.()
        for (const client of subscribers) {
          try {
            client.end()
          } catch {
            // the client is already gone
          }
        }
        subscribers.clear()
        server.close(() => resolvePromise())
        server.closeAllConnections?.()
        for (const socket of sockets) socket.destroy()
      }),
  }
}

interface RequestState {
  readonly token: string
  readonly secret: string
  readonly host: string
  readonly port: number
  readonly clients: Set<ServerResponse>
  readonly subscribers: Set<ServerResponse>
  /** The stream's log: ids for every pushed frame, and the frames a reconnecting client missed. */
  readonly log: EventLog
  /** The heartbeat interval, which `ready` tells the page. */
  readonly heartbeatMs: number
  /**
   * How many turns are running per session.
   *
   * A count rather than a flag because two turns on one session are possible, and a set would then clear the
   * mark for a session that is still running. It is what the steer route asks before it accepts a message:
   * DSH refuses a steer whose turn has ended, and this is the same question about the same fact.
   */
  readonly running: Map<string, number>
  /**
   * When each running session's turn began, in epoch milliseconds.
   *
   * The running count says **whether** a turn is going; the running row's clock needs **since when**, and that must
   * be the server's fact rather than the page's first sighting of an event. A page that reloads mid-turn, or opens on
   * a turn another window started, otherwise restarts the clock at 1s (measured: the owner saw exactly that, and
   * navigating away and back reset it before this existed).
   */
  readonly runningSince: Map<string, number>
  /** When each session's last turn completed, in epoch milliseconds. */
  readonly completedAt: Map<string, number>
  /**
   * The abort handle of each running turn, per session.
   *
   * A stop and a steer ask about the same fact — is there a turn to act on — but a stop needs the handle
   * itself: the provider request is where a turn spends its time, and DSH's stop button ends the answer
   * rather than waiting for it. `runTurn` has taken a signal since it was written; nothing passed one until
   * the composer grew a Stop.
   */
  readonly controllers: Map<string, Set<AbortController>>
  /**
   * Rounds an interactive turn may take before the loop stops it — `Infinity` by default, so the loop ends the way
   * DSH's does (the model stops calling tools), and only an explicit `--max-rounds` turns this into a limit.
   */
  readonly maxRounds: number
  readonly quiet?: boolean
  readonly defaultEndpoint?: string
}

/** One request, routed and fenced. */
async function handle(ctx: Context, request: IncomingMessage, response: ServerResponse, state: RequestState): Promise<void> {
  const authority = request.headers.host ?? `${state.host}:${state.port}`
  const url = new URL(request.url ?? '/', `http://${authority}`)

  /**
   * The fence, before any secret is compared.
   *
   * A page on another origin can make a browser send a request here; the browser
   * attaches the cookie, and without this check the response would be readable to
   * that page. `Sec-Fetch-Site` is the modern signal and `Origin` the older one, so
   * both are read and either is enough to refuse.
   */
  const fence = rejectUntrusted(request, authority)
  if (fence !== null) {
    respond(response, 403, 'text/plain', `${fence}\n`)
    return
  }

  /**
   * A liveness answer that carries no data.
   *
   * Before the handshake and before authentication, and empty of anything private: a supervisor, a
   * monitor or a person needs to know that **this** service owns the port, and two facts answer that —
   * the service's name and that nothing sensitive came back. It is what the daemon definition's liveness
   * probe asks (see `_tools_/web-daemon/`), so the definition and the server agree on one endpoint rather
   * than on parsing a banner.
   *
   * It is also the one route reachable without a token, which is why it says nothing: no sessions, no
   * counts, no version.
   */
  /**
   * The tab's icon, served from the project's own asset.
   *
   * One source of truth: the route reads `heddle.svg` where the repository keeps it rather than a second copy
   * beside the page. It is also reachable **without a token**, like `/healthz`, and for the same kind of reason —
   * the browser asks for a favicon as a request of its own, before anyone has authenticated, and the picture says
   * nothing about this machine's work. A copy installed without the asset answers `404` and the page keeps its
   * default tab.
   */
  if ((url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico') && request.method === 'GET') {
    try {
      const icon = readFileSync(join(import.meta.dirname, '..', '..', 'heddle.svg'))
      response.writeHead(200, { 'content-type': 'image/svg+xml', 'content-length': String(icon.length), 'cache-control': 'no-store' })
      response.end(icon)
    } catch {
      respond(response, 404, 'text/plain', 'no icon beside this installation\n')
    }
    return
  }

  if (url.pathname === '/healthz' && request.method === 'GET') {
    respond(response, 200, 'application/json', `${JSON.stringify({ ok: true, service: 'heddle-web', port: state.port })}\n`)
    return
  }

  // The handshake: a valid launch token in the query becomes a cookie.
  if (url.pathname === '/' && url.searchParams.has(TOKEN_QUERY)) {
    const presented = url.searchParams.get(TOKEN_QUERY) ?? ''
    if (!safeEqual(presented, state.token)) {
      /**
       * A token that does not match gets the **page**, not a sentence.
       *
       * Measured, and it is a bug rather than a nicety: a daemon mints a fresh launch token on every
       * start, so the URL in a browser's history, in a bookmark, or in a scrollback is stale by the next
       * restart. The old answer was `401 text/plain` reading "reopen the URL printed by `heddle web`" —
       * a dead end with no form to paste the current token into and no way forward except finding the
       * log. A refusal a person cannot recover from turns a restart into an outage.
       */
      respond(response, 401, 'text/html; charset=utf-8', tokenFormPage({ stale: true }))
      return
    }
    response.writeHead(303, {
      location: '/',
      'set-cookie': cookieHeader(authority, mintCookie(state.secret, authority)),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    response.end()
    return
  }

  const credentials = {
    cookie: readCookie(request.headers.cookie, cookieName(authority)),
    query: url.searchParams.get(TOKEN_QUERY),
  }
  const decision = authorize(credentials, { launchToken: state.token, secret: state.secret, authority })
  /** What the request actually offered, so a refusal can say which it was. */
  const offered = { cookie: credentials.cookie !== null, token: credentials.query !== null }

  /**
   * A cross-site request is refused **when it would change state and is not authenticated**.
   *
   * Both halves matter. Refusing every cross-site write broke a sandboxed viewer, whose requests are all
   * marked cross-site — measured, and it made the page's own composer answer `403`. Allowing every one would
   * drop the fence's only remaining job. Keying on the credential keeps the protection and removes the
   * breakage, because the credential cannot travel cross-site: the cookie is `SameSite=Strict`, so a browser
   * never attaches it to an attacker's request, and `decision.ok` is false exactly when it did not.
   */
  const method = String(request.method ?? 'GET').toUpperCase()
  const changesState = method !== 'GET' && method !== 'HEAD'
  if (changesState && offered.cookie && !decision.ok) {
    respond(
      response,
      403,
      'text/plain',
      'refused: a cross-site request that changes state and carries no valid session; a cross-site request may read, but writing requires the cookie this page was opened with\n',
    )
    return
  }

  /**
   * The page is served to a **session**, and refused with an explanation otherwise.
   *
   * The first version served the app shell to anyone who asked for `/`, on the reasoning that the page
   * carries no data and has a token form in it. Measured, that failed open in a way a person notices:
   * `http://127.0.0.1:3082/` with no cookie answered `200` with the whole UI — session list, prompt box and
   * an empty log — so it looked like a working page that had lost its data, rather than like a page that had
   * not been opened with a token. DSH refuses the bare URL with `401`, and this now does too.
   *
   * The cookie is the same credential the launch token mints, so a browser that has been through the printed
   * URL keeps working: the bare URL is served whenever the cookie matches, and refused when it does not.
   */
  if (url.pathname === '/' && request.method === 'GET') {
    const access = pageAccess(decision, offered)
    if (access.status === 200) {
      respond(response, 200, 'text/html; charset=utf-8', page())
      return
    }
    respond(response, access.status, 'text/html; charset=utf-8', tokenFormPage({ stale: access.stale }))
    return
  }

  if (!decision.ok) {
    respond(
      response,
      401,
      url.pathname.startsWith('/api') ? 'text/plain' : 'text/html; charset=utf-8',
      url.pathname.startsWith('/api') ? 'unauthorized\n' : tokenFormPage(),
    )
    return
  }

  /**
   * A file's **bytes**, so a document's embedded images and other subresources can load.
   *
   * Measured, and it is the owner's report: markdown rendered `<img src="heddle.svg">` correctly and the browser
   * then asked this server for `/heddle.svg`, which answered `404` — the renderer was never the missing piece, a
   * **file was simply not served**. A document with an image in it showed alt text and a broken-image marker.
   *
   * Two rules, and both are the ones `/api/file` already applies: the path must be inside a workspace root, and the
   * caller must have the session cookie the page was opened with. What is new is only that the body is bytes rather
   * than JSON.
   *
   * The `content-type` is chosen from a small map and **defaults to a download**, never to something a browser will
   * run: a workspace can contain an `.html` file or a `.js` one, and a route that served those inline with the
   * session cookie attached would be a same-origin script the harness runs by being viewed. Only the types a
   * document embeds are served inline.
   */
  if (url.pathname === '/api/raw' && request.method === 'GET') {
    const workspaces = ctx.workspace
    const wanted = url.searchParams.get('path')
    if (wanted === null || wanted.length === 0) {
      respond(response, 400, 'text/plain', 'a path is required\n', FILE_ANSWER_HEADERS)
      return
    }
    if (workspaces === undefined || workspaces.owner(wanted) === undefined) {
      respond(response, 404, 'text/plain', 'no such asset\n', FILE_ANSWER_HEADERS)
      return
    }
    try {
      const stats = statSync(wanted)
      if (!stats.isFile()) {
        respond(response, 404, 'text/plain', 'no such asset\n', FILE_ANSWER_HEADERS)
        return
      }
      const contentType = inlineContentType(wanted)
      response.writeHead(200, {
        'content-type': contentType ?? 'application/octet-stream',
        'content-length': String(stats.size),
        /** `inline` only for a type a document embeds; anything else is offered as a download. */
        'content-disposition': contentType === null ? `attachment; filename="${basename(wanted).replace(/"/g, '')}"` : 'inline',
        'cache-control': 'no-store',
        ...FILE_ANSWER_HEADERS,
      })
      response.end(readFileSync(wanted))
    } catch {
      respond(response, 404, 'text/plain', 'no such asset\n', FILE_ANSWER_HEADERS)
    }
    return
  }

  /**
   * An uploaded file's bytes, so a transcript card can show the image it names.
   *
   * The containment rule is the upload directory's, not a workspace's: the bytes were stored there by the
   * upload route, are read-only to the conversation, and may sit outside every registered workspace. The leaf
   * is a single path segment (`..`, separators and empty names are refused) and the resolved path is checked
   * again against the canonical directory, so a hand-made request cannot walk out of it. As with `/api/raw`,
   * only types a document embeds are served inline; anything else is a download.
   */
  if (url.pathname.startsWith('/api/uploads/') && request.method === 'GET') {
    const leaf = decodeURIComponent(url.pathname.slice('/api/uploads/'.length))
    if (leaf.length === 0 || leaf.includes('/') || leaf.includes('\\') || leaf === '..' || leaf === '.') {
      respond(response, 404, 'text/plain', 'no such asset\n', FILE_ANSWER_HEADERS)
      return
    }
    /**
     * An upload is served only to the session whose log references it, as DSH's `session/attachment` authorizes a
     * read against that session's events. A request that names no session, an unknown one, or one whose log does not
     * carry this leaf is answered the same `404`, so the route does not say which uploads exist.
     */
    const asking = url.searchParams.get('session') ?? ''
    const owner = /^session-[0-9a-f-]{36}$/i.test(asking) ? ctx.session.store.open(asking) : null
    if (owner === null || !uploadReferencedBy(ctx.session.events(owner), leaf)) {
      respond(response, 404, 'text/plain', `${UPLOAD_NOT_REFERENCED}\n`, FILE_ANSWER_HEADERS)
      return
    }
    try {
      const directory = uploadDirectory()
      const wanted = join(directory, leaf)
      if (!isUnder(canonicalPath(directory), canonicalPath(wanted))) {
        respond(response, 404, 'text/plain', 'no such asset\n', FILE_ANSWER_HEADERS)
        return
      }
      const stats = statSync(wanted)
      if (!stats.isFile()) {
        respond(response, 404, 'text/plain', 'no such asset\n', FILE_ANSWER_HEADERS)
        return
      }
      const contentType = inlineContentType(wanted)
      response.writeHead(200, {
        'content-type': contentType ?? 'application/octet-stream',
        'content-length': String(stats.size),
        'content-disposition': contentType === null ? `attachment; filename="${leaf.replace(/"/g, '')}"` : 'inline',
        'cache-control': 'no-store',
        ...FILE_ANSWER_HEADERS,
      })
      response.end(readFileSync(wanted))
    } catch {
      respond(response, 404, 'text/plain', 'no such asset\n', FILE_ANSWER_HEADERS)
    }
    return
  }

  /**
   * DOMPurify's browser build, served from the installed package.
   *
   * The sanitiser runs **in the browser**, where the DOM already is. Measured before choosing: the package is 1.6 MB
   * installed and 29 KB as the minified bundle served here, with **zero dependencies**, while doing it on the server
   * means jsdom or four packages to parse HTML the browser has already parsed. The file is read from `node_modules`
   * at request time rather than vendored into the tree, so it cannot drift from the version in `package.json`.
   */
  if (url.pathname === '/vendor/purify.js' && request.method === 'GET') {
    try {
      const bundle = readFileSync(new URL('../../node_modules/dompurify/dist/purify.min.js', import.meta.url))
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      response.end(bundle)
    } catch {
      respond(response, 404, 'text/plain', 'the sanitiser is not installed\n')
    }
    return
  }

  /**
   * An HTML document, prepared to be shown as a page.
   *
   * The answer is the document with its relative resources pointed at the route that serves them, and the policy it
   * must run under — not sanitised here, because the sanitiser is DOMPurify in the browser and the page is where a
   * DOM exists. Two things make this safe to hand over: nothing about it is executed by this server, and what the
   * browser does with it happens inside a sandboxed frame with no scripts allowed.
   */
  if (url.pathname === '/api/html' && request.method === 'GET') {
    const workspaces = ctx.workspace
    const wanted = url.searchParams.get('path')
    if (wanted === null || wanted.length === 0) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'a path is required' })}\n`)
      return
    }
    if (workspaces === undefined || workspaces.owner(wanted) === undefined) {
      respond(response, 404, 'application/json', `${JSON.stringify({ error: 'that path is not under any workspace root' })}\n`)
      return
    }
    try {
      const stats = statSync(wanted)
      if (!stats.isFile()) {
        respond(response, 404, 'application/json', `${JSON.stringify({ error: 'not a file' })}\n`)
        return
      }
      /** Bounded like every other reading: a preview is not a way to make the server hold a huge file in memory. */
      if (stats.size > 4 * 1024 * 1024) {
        respond(response, 413, 'application/json', `${JSON.stringify({ error: 'the document is larger than 4MB' })}\n`)
        return
      }
      const source = readFileSync(wanted, 'utf8')
      const html = rewriteResources(source, dirname(wanted), (path) => `/api/raw?path=${encodeURIComponent(path)}`)
      respond(
        response,
        200,
        'application/json',
        `${JSON.stringify({ path: wanted, html, csp: PREVIEW_CSP, bytes: stats.size }, null, 2)}\n`,
      )
    } catch {
      respond(response, 404, 'application/json', `${JSON.stringify({ error: 'no such document' })}\n`)
    }
    return
  }

  if (url.pathname === '/api/sessions' && request.method === 'GET') {
    /**
     * Whether a session is running is the **server's** fact, and it is what the page's running marks and its
     * "Weaving" row reconcile against. A page can miss the end of a turn (an error event, a reload mid-turn, a
     * dropped stream); without an authoritative answer that miss became a session that never stops looking active.
     */
    const sessions = ctx.session.list().map((entry) => {
      const since = state.runningSince.get(entry.id)
      const completed = state.completedAt.get(entry.id)
      return {
        ...entry,
        running: (state.running.get(entry.id) ?? 0) > 0,
        ...(since !== undefined ? { runningSince: new Date(since).toISOString() } : {}),
        ...(completed !== undefined ? { turnCompletedAt: new Date(completed).toISOString() } : {}),
      }
    })
    respond(response, 200, 'application/json', `${JSON.stringify(sessions, null, 2)}\n`)
    return
  }

  /**
   * What a session can be switched onto.
   *
   * The composer's model seat needs the list before it can offer anything, and the list is the model
   * service's own — **never** the configuration file, because a machine's endpoints are resolved from
   * several layers and a page that read the file would miss the environment overrides and the
   * repository's defaults. `describeEndpoints` is the one function that knows what is safe to say, so
   * the route reuses it: a key, a key *path* and a header value are all secrets that can live in an
   * endpoint, and none of them may reach a browser.
   */
  if (url.pathname === '/api/endpoints' && request.method === 'GET') {
    const endpoints = ctx.model.list()
    const described = describeEndpoints(endpoints, ctx.model.defaultEndpoint())
    /**
     * A provider that lists its models already knows each one's context window, and the composer's gauge needs
     * it. The declarative configuration always wins; only an endpoint that declares none asks its provider, and
     * a provider that cannot answer leaves the entry without a window — the page then prints no percentage,
     * which is the truth rather than a guessed denominator.
     */
    const discovered = await Promise.all(
      endpoints.map((endpoint) =>
        endpoint.contextWindow !== undefined ? undefined : contextWindowFromModelList(endpoint),
      ),
    )
    const withWindows = described.endpoints.map((entry, index) => {
      const window = discovered[index]
      return window === undefined ? entry : { ...entry, contextWindow: window, contextWindowSource: 'provider-models' }
    })
    respond(response, 200, 'application/json', `${JSON.stringify({ ...described, endpoints: withWindows }, null, 2)}\n`)
    return
  }

  /**
   * One level of the folder tree the left column draws.
   *
   * `GET /api/tree` lists the registered roots; `GET /api/tree?path=<absolute>` lists the folders
   * directly inside one of them. One level, never a whole walk: the page asks for a node's children
   * when a person opens it, which is what keeps a large target folder cheap to show.
   *
   * A path outside every root is refused with `400` rather than walked, for the same reason the CLI
   * refuses it: this route sits behind the token and must not become a directory browser for the
   * whole machine.
   */
  if (url.pathname === '/api/tree' && request.method === 'GET') {
    const workspaces = ctx.workspace
    if (workspaces === undefined) {
      respond(response, 503, 'application/json', `${JSON.stringify({ error: 'this profile does not load the workspace plugin' })}\n`)
      return
    }
    const wanted = url.searchParams.get('path')
    if (wanted !== null && wanted.length > 0 && workspaces.owner(wanted) === undefined) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: `${canonicalPath(wanted)} is not under any workspace root` })}\n`)
      return
    }
    const node = tree(wanted === null || wanted.length === 0 ? null : wanted, {
      roots: workspaces.list().map((record) => ({ path: record.path, title: record.title, ...(record.origin !== undefined ? { origin: record.origin } : {}) })),
      sessions: ctx.session.list(),
      generated: workspaces.generated,
      /**
       * Three states, DSH's arrangement: `?archived=show` adds archived sessions, `?archived=only` answers with
       * nothing but them, and anything else hides them. `1` still means `show`, because it is already on a URL a
       * person may have bookmarked.
       */
      archived:
        url.searchParams.get('archived') === 'only'
          ? 'only'
          : url.searchParams.get('archived') === '1' || url.searchParams.get('archived') === 'show'
            ? 'show'
            : 'hide',
    })
    respond(response, 200, 'application/json', `${JSON.stringify(node, null, 2)}\n`)
    return
  }

  /**
   * The content of one file, for the panel a file row opens.
   *
   * Refused outside every root, exactly as the tree is and for the same reason — this route is behind
   * the token and must not be a way to read the whole machine — and the path that is checked is the
   * **canonical** one, so a symlink that resolves outside a root is refused rather than followed. What
   * cannot be shown is a status rather than an empty panel: `404` for a path that is not a file, and
   * `415` for a file that is not UTF-8 text, each with the sentence the reader produced.
   */
  if (url.pathname === '/api/file' && request.method === 'GET') {
    const workspaces = ctx.workspace
    if (workspaces === undefined) {
      respond(response, 503, 'application/json', `${JSON.stringify({ error: 'this profile does not load the workspace plugin' })}\n`)
      return
    }
    const wanted = url.searchParams.get('path')
    if (wanted === null || wanted.length === 0) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'a path is required' })}\n`)
      return
    }
    if (workspaces.owner(wanted) === undefined) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: `${canonicalPath(wanted)} is not under any workspace root` })}\n`)
      return
    }
    try {
      const reading = readFileText(wanted)
      /**
       * The reading and the **renderer's decision** travel together.
       *
       * The server renders because it is where the escaping lives: a file's text is somebody else's
       * bytes, and a renderer that interpolated them into markup would be an injection with extra
       * steps. The client is handed markup this project produced, or the plain text, and never
       * builds either one itself.
       */
      respond(
        response,
        200,
        'application/json',
        `${JSON.stringify({ ...reading, ...renderSource(reading.path, reading.text) }, null, 2)}\n`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = message.includes('is not a file') ? 404 : 415
      respond(response, status, 'application/json', `${JSON.stringify({ error: message })}\n`)
    }
    return
  }

  /**
   * A file the person chose on their own computer, stored where the agent can read it.
   *
   * `POST /api/uploads?name=<encoded>` with the bytes as the body, and the answer is the absolute path
   * the composer puts in the draft. This is the route behind the `+` menu's **File** item: a browser's
   * native picker does not tell a page where the file lives (by design), so the only honest way to turn
   * "this file on my computer" into heddle's substrate — a path `read_file` can open — is to copy the
   * bytes into the harness's own store and name that copy.
   *
   * Three rules the route keeps rather than trusting the page: the body is capped at the same ceiling
   * as a turn; an empty body is refused instead of creating an empty file; and the name is sanitised by
   * `saveUpload` before any path is built, so a hand-made request cannot choose where the file lands.
   */
  if (url.pathname === '/api/uploads' && request.method === 'POST') {
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of request) {
      bytes += (chunk as Buffer).length
      if (bytes > MAX_UPLOAD_BYTES) {
        respond(
          response,
          413,
          'text/plain',
          `the file is larger than this server accepts (${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB)\n`,
        )
        return
      }
      chunks.push(Buffer.from(chunk))
    }
    if (bytes === 0) {
      respond(response, 400, 'text/plain', 'an empty file has nothing to add\n')
      return
    }
    const saved = saveUpload(url.searchParams.get('name') ?? 'file', Buffer.concat(chunks))
    respond(response, 200, 'application/json', `${JSON.stringify(saved)}\n`)
    return
  }

  /**
   * A session's goal: the durable objective, its phase, and the round it has reached.
   *
   * The GET is what the goal bar reads on every session change. The POST is the **person's** side of the
   * verbs, which is why it may do one thing the model's tool may not: resume a paused goal. A pause is a
   * person's decision, so only a person undoes it — the tool refuses and says the user must resume.
   *
   * Errors carry the goal service's own stable code next to the sentence, so a client can distinguish "the
   * goal moved while you were looking" (409) from "no goal is current" (404) without parsing prose.
   */
  // The reminder routes: DSH's remote `schedule` namespace, answered by the schedule module.
  if (await handleScheduleRoute(ctx.schedule, url, request, response)) return

  if (url.pathname === '/api/goal' && request.method === 'GET') {
    const goals = ctx.goal
    if (goals === undefined) {
      respond(response, 503, 'application/json', `${JSON.stringify({ error: 'this profile does not load the goal plugin' })}\n`)
      return
    }
    const wanted = url.searchParams.get('session')
    if (wanted === null || wanted.length === 0) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'a session is required' })}\n`)
      return
    }
    const handle = ctx.session.store.open(wanted)
    if (handle === null) {
      respond(response, 404, 'application/json', `${JSON.stringify({ error: `no session ${wanted}` })}\n`)
      return
    }
    respond(response, 200, 'application/json', `${JSON.stringify({ session: handle.id, goal: goals.get(handle) ?? null }, null, 2)}\n`)
    return
  }
  /**
   * The session's todo list, as its current fold. An absent list is `null` rather than an empty one, so a
   * client can tell "never written" from "written empty" (the UI hides both, but the API keeps the fact).
   */
  if (url.pathname === '/api/todo' && request.method === 'GET') {
    const todos = ctx.todo
    if (todos === undefined) {
      respond(response, 503, 'application/json', `${JSON.stringify({ error: 'this profile does not load the todo plugin' })}\n`)
      return
    }
    const wanted = url.searchParams.get('session')
    if (wanted === null || wanted.length === 0) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'a session is required' })}\n`)
      return
    }
    const handle = ctx.session.store.open(wanted)
    if (handle === null) {
      respond(response, 404, 'application/json', `${JSON.stringify({ error: `no session ${wanted}` })}\n`)
      return
    }
    respond(response, 200, 'application/json', `${JSON.stringify({ session: handle.id, todo: todos.get(handle) ?? null }, null, 2)}\n`)
    return
  }
  if (url.pathname === '/api/goal' && request.method === 'POST') {
    const goals = ctx.goal
    if (goals === undefined) {
      respond(response, 503, 'application/json', `${JSON.stringify({ error: 'this profile does not load the goal plugin' })}\n`)
      return
    }
    const body = await readJson(request, response)
    if (body === null) return
    const wanted = typeof body.session === 'string' ? body.session : ''
    const handle = wanted.length > 0 ? ctx.session.store.open(wanted) : null
    if (handle === null) {
      respond(response, 404, 'application/json', `${JSON.stringify({ error: `no session ${wanted}` })}\n`)
      return
    }
    const action = typeof body.action === 'string' ? body.action : ''
    const ref = { id: typeof body.goal_id === 'string' ? body.goal_id : '', revision: typeof body.revision === 'number' ? body.revision : 0 }
    try {
      if (action === 'create') {
        const view = goals.create(handle, {
          objective: typeof body.objective === 'string' ? body.objective : '',
          ...(typeof body.max_goal_rounds === 'number' ? { maxGoalRounds: body.max_goal_rounds } : {}),
        })
        respond(response, 200, 'application/json', `${JSON.stringify({ goal: view }, null, 2)}\n`)
      } else if (action === 'edit') {
        const view = goals.edit(handle, ref, {
          ...(typeof body.objective === 'string' ? { objective: body.objective } : {}),
          ...(typeof body.max_goal_rounds === 'number' ? { maxGoalRounds: body.max_goal_rounds } : {}),
        })
        respond(response, 200, 'application/json', `${JSON.stringify({ goal: view }, null, 2)}\n`)
      } else if (action === 'pause' || action === 'resume' || action === 'complete') {
        const view = action === 'pause' ? goals.pause(handle, ref) : action === 'resume' ? goals.resume(handle, ref) : goals.complete(handle, ref)
        respond(response, 200, 'application/json', `${JSON.stringify({ goal: view }, null, 2)}\n`)
      } else if (action === 'blocked') {
        const reason = body.blocked_reason
        const view = goals.block(handle, ref, reason as { code: string; message: string })
        respond(response, 200, 'application/json', `${JSON.stringify({ goal: view }, null, 2)}\n`)
      } else if (action === 'clear') {
        const cleared = goals.clear(handle, ref)
        respond(response, 200, 'application/json', `${JSON.stringify({ cleared }, null, 2)}\n`)
      } else {
        respond(response, 400, 'application/json', `${JSON.stringify({ error: `unknown goal action ${JSON.stringify(action)}` })}\n`)
      }
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : ''
      const status = code === 'GOAL_NOT_FOUND' ? 404 : code === 'GOAL_STALE_REVISION' ? 409 : 400
      const message = error instanceof Error ? error.message : String(error)
      respond(response, status, 'application/json', `${JSON.stringify({ error: message, code })}\n`)
    }
    return
  }

  /**
   * One Lead session's team, for the view that shows the roster and the shared board.
   *
   * The answer is the same state the tools see — the folded journal, the live-turn statuses and the task views
   * with readiness and write-scope warnings — because a view that recomputed any of it would be a second truth.
   */
  if (url.pathname === '/api/team' && request.method === 'GET') {
    const team = ctx.team
    if (team === undefined) {
      respond(response, 503, 'application/json', `${JSON.stringify({ error: 'this profile does not load the team plugin' })}\n`)
      return
    }
    const wanted = url.searchParams.get('session')
    if (wanted === null || wanted.length === 0) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'a session is required' })}\n`)
      return
    }
    const handle = ctx.session.store.open(wanted)
    if (handle === null) {
      respond(response, 404, 'application/json', `${JSON.stringify({ error: `no session ${wanted}` })}\n`)
      return
    }
    const state = team.state(handle)
    respond(
      response,
      200,
      'application/json',
      `${JSON.stringify({ session: handle.id, lead: state.id, members: team.list(handle), tasks: team.tasks(handle), messages: state.messages, delivered: state.delivered }, null, 2)}\n`,
    )
    return
  }

  /**
   * How one session's context was **composed**, for the view that shows it.
   *
   * The answer is the same report `heddle context <id>` prints, plus the two things a person cannot get
   * from a token count: the **surface** — which events the model will actually read, and which ones a
   * compaction summary stands in for — and the **notes** the assembler wrote, which is where the system
   * prompt and the instruction baseline come from. A budget is checkable from numbers; "the instructions
   * on the surface are the current ones" and "the summary is in there once, where the span was" are
   * claims about the messages themselves.
   *
   * It is a `GET` because assembling is a read after the first call, and it is per session because that
   * is what the question means: the same folder can hold two sessions that were composed differently.
   */
  if (url.pathname === '/api/context' && request.method === 'GET') {
    const context = ctx.context
    if (context === undefined) {
      respond(response, 503, 'application/json', `${JSON.stringify({ error: 'this profile does not load the context plugin' })}\n`)
      return
    }
    const wanted = url.searchParams.get('session')
    if (wanted === null || wanted.length === 0) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'a session is required' })}\n`)
      return
    }
    const handle = ctx.session.store.open(wanted)
    if (handle === null) {
      respond(response, 404, 'application/json', `${JSON.stringify({ error: `no session ${wanted}` })}\n`)
      return
    }
    /**
     * The directory the run resolves its instructions from, not the shell's — asking for a resumed
     * session's composition and getting a different answer than the run would produce is the failure
     * this avoids, which is why the same option is passed here as the CLI passes there.
     */
    const cwd = ctx.session.folder(handle) ?? ctx.sandbox?.workspaceRoot ?? process.cwd()
    const endpoint = url.searchParams.get('endpoint')
    const model = url.searchParams.get('model')
    const report = context.assemble(handle, {
      cwd,
      tools: ctx.tools.describe(),
      ...(endpoint !== null && endpoint.length > 0 ? { endpoint } : {}),
      ...(model !== null && model.length > 0 ? { model } : {}),
    })
    const surface = ctx.session.store.surface(handle)
    const notes = ctx.session
      .events(handle)
      .filter((event) => event.type === 'context/note')
      .map((event) => {
        /**
         * A note's message is read defensively: the event type carries it, but `SessionEvent` does not
         * narrow it, and a view that assumed the shape would break on the first note written differently.
         */
        const message = (event as { message?: { content?: readonly { type?: string; text?: string }[] } }).message
        return {
          seq: event.seq,
          origin: typeof event.origin === 'string' ? event.origin : '',
          text: (message?.content ?? []).map((part) => (part.type === 'text' ? part.text ?? '' : '')).join(''),
        }
      })
    respond(
      response,
      200,
      'application/json',
      `${JSON.stringify(
        {
          session: handle.id,
          cwd,
          endpoint: endpoint !== null && endpoint.length > 0 ? endpoint : null,
          instructions: report.instructions,
          estimatedTokens: report.estimatedTokens,
          contextWindow: report.contextWindow,
          thresholdTokens: report.thresholdTokens,
          pruned: report.pruned,
          compacted: report.compacted,
          surface: {
            nodes: surface.nodes,
            replacements: surface.replacements.map((replacement) => ({
              seq: replacement.seq,
              startSeq: replacement.startSeq,
              endSeq: replacement.endSeq,
              shadowedSeqs: replacement.shadowedSeqs,
            })),
          },
          notes,
          messages: report.messages.map((message) => ({
            role: message.role,
            ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
            text: describeContent(message.content),
          })),
        },
        null,
        2,
      )}\n`,
    )
    return
  }

  /**
   * Ask the **server's** platform for a folder, which is the only way a page can get an absolute path.
   *
   * A cancel is `200` with `cancelled`, because a person saying no is an answer rather than an error;
   * a host with no usable dialog is `501` with the sentence that names what to install, so the page can
   * offer to type the path instead of looking broken. Nothing is mounted here: the answer travels back
   * to the page, which registers it through the route below. One dialog, one decision.
   */
  /**
   * Every workspace with its parent and its sessions — the data the left column's workspace tree is drawn from.
   *
   * DSH's browser is fed one `WorkspaceView` per workspace (path, title, session membership); this is the same answer
   * under heddle's rules, derived by `WorkspaceService.views`: `parent` nests a root under its nearest registered
   * ancestor, and `sessionIds` names the sessions whose nearest root it is. Read-only and additive: the folder tree and
   * every write route are unchanged.
   */
  if (url.pathname === '/api/workspaces' && request.method === 'GET') {
    const workspaces = ctx.workspace
    if (workspaces === undefined) {
      respond(response, 503, 'application/json', `${JSON.stringify({ error: 'this profile does not load the workspace plugin' })}\n`)
      return
    }
    respond(response, 200, 'application/json', `${JSON.stringify({ workspaces: workspaces.views(ctx.session.list()) }, null, 2)}\n`)
    return
  }

  if (url.pathname === '/api/workspaces/pick' && request.method === 'POST') {
    const outcome = await pickFolder()
    if (outcome.kind === 'unavailable') {
      respond(response, 501, 'application/json', `${JSON.stringify({ error: outcome.reason })}\n`)
      return
    }
    respond(response, 200, 'application/json', `${JSON.stringify(outcome, null, 2)}\n`)
    return
  }

  /**
   * The page's own folder chooser: one directory level (`GET`), and one new child folder (`POST`).
   *
   * DSH's browse backend, for the *Add workspace* dialog: a page reached through the gate or the public edge is on
   * another machine, where the server's native dialog cannot be seen (see `directories.ts`). Directories only; a
   * refusal is `{error, code}` with DSH's code, `400` for a path that is relative, missing, not a folder or
   * unreadable, `409` for a child that already exists.
   */
  if (url.pathname === '/api/directories' && request.method === 'GET') {
    try {
      const listing = listDirectory(url.searchParams.get('path') ?? undefined)
      respond(response, 200, 'application/json', `${JSON.stringify(listing, null, 2)}\n`)
    } catch (error) {
      if (!(error instanceof DirectoryError)) throw error
      respond(response, error.status, 'application/json', `${JSON.stringify({ error: error.message, code: error.code })}\n`)
    }
    return
  }
  if (url.pathname === '/api/directories' && request.method === 'POST') {
    const body = await readJson(request, response)
    if (body === null) return
    try {
      const created = createDirectory(body.parent, body.name)
      respond(response, 200, 'application/json', `${JSON.stringify(created, null, 2)}\n`)
    } catch (error) {
      if (!(error instanceof DirectoryError)) throw error
      respond(response, error.status, 'application/json', `${JSON.stringify({ error: error.message, code: error.code })}\n`)
    }
    return
  }

  /**
   * Register a folder as a workspace root, or unregister one.
   *
   * These are the two buttons the left column offers, and both go through the same record the CLI
   * writes: a folder is registered by path (the name defaults to the folder's own name), and a root
   * is unregistered by id. Registration is idempotent — registering an already-registered folder
   * reports `created: false` rather than failing — and registering a folder that was **adopted**
   * because a session ran in it promotes it into the tree, which is how ad-hoc work becomes a
   * project without moving anything.
   *
   * `DELETE` removes the registration and nothing else — DSH's *Delete workspace*: the folder, its files and its
   * sessions stay, and the sessions move to the nearest registered root above it, or to *Ungrouped* when there is
   * none. It used to refuse that second case, because `bootstrap` re-adopts a folder that has sessions and no owner
   * and the old folder tree then showed the root again; the workspace tree draws an adopted (`auto`) root as
   * Ungrouped rather than as a workspace, so the removal now holds where a person looks. The CLI's
   * `workspace remove` keeps the refusal and its `--force`.
   */
  if (url.pathname === '/api/workspaces' && request.method === 'POST') {
    const workspaces = ctx.workspace
    if (workspaces === undefined) {
      respond(response, 503, 'application/json', `${JSON.stringify({ error: 'this profile does not load the workspace plugin' })}\n`)
      return
    }
    const body = await readJson(request, response)
    if (body === null) return
    const path = typeof body.path === 'string' ? body.path.trim() : ''
    if (path.length === 0) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'a path is required' })}\n`)
      return
    }
    if (!path.startsWith('/') && !path.startsWith('~')) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'the path must be absolute' })}\n`)
      return
    }
    let stat
    try {
      stat = statSync(expandHome(path))
    } catch {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: `${path} does not exist` })}\n`)
      return
    }
    if (!stat.isDirectory()) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: `${path} is not a folder` })}\n`)
      return
    }
    const name = typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : undefined
    if (name !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'a name must be lowercase letters, digits and dashes' })}\n`)
      return
    }
    const { record, created } = workspaces.add(path, name)
    respond(response, 200, 'application/json', `${JSON.stringify({ record, created }, null, 2)}\n`)
    return
  }
  if (url.pathname.startsWith('/api/workspaces/') && request.method === 'DELETE') {
    const workspaces = ctx.workspace
    if (workspaces === undefined) {
      respond(response, 503, 'application/json', `${JSON.stringify({ error: 'this profile does not load the workspace plugin' })}\n`)
      return
    }
    const id = decodeURIComponent(url.pathname.slice('/api/workspaces/'.length))
    if (workspaces.find(id) === undefined) {
      respond(response, 404, 'application/json', `${JSON.stringify({ error: `no workspace ${id}` })}\n`)
      return
    }
    try {
      const outcome = workspaces.remove(id, { all: ctx.session.list(), force: true })
      respond(response, 200, 'application/json', `${JSON.stringify(outcome, null, 2)}\n`)
    } catch (error) {
      respond(response, 409, 'application/json', `${JSON.stringify({ error: (error as Error).message })}\n`)
    }
    return
  }

  /**
   * Retitle a root — the `Rename` item in a row's menu.
   *
   * A `PATCH` on the same path the `DELETE` takes, because the record's identity is the path and only
   * its label changes. An empty name is refused rather than saved: a nameless row in a tree is a row
   * nobody can find again. A name another workspace already carries is refused with `409` and DSH's
   * `workspace/name-conflict`, because two rows with one label are two rows nobody can tell apart.
   */
  if (url.pathname.startsWith('/api/workspaces/') && request.method === 'PATCH') {
    const workspaces = ctx.workspace
    if (workspaces === undefined) {
      respond(response, 503, 'application/json', `${JSON.stringify({ error: 'this profile does not load the workspace plugin' })}\n`)
      return
    }
    const id = decodeURIComponent(url.pathname.slice('/api/workspaces/'.length))
    const body = await readJson(request, response)
    if (body === null) return
    if (typeof body.title !== 'string') {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'a title is required' })}\n`)
      return
    }
    try {
      const record = workspaces.rename(id, body.title)
      if (record === undefined) {
        respond(response, 404, 'application/json', `${JSON.stringify({ error: `no workspace ${id}` })}\n`)
        return
      }
      respond(response, 200, 'application/json', `${JSON.stringify(record, null, 2)}\n`)
    } catch (error) {
      if ((error as { code?: unknown }).code === 'workspace/name-conflict') {
        respond(response, 409, 'application/json', `${JSON.stringify({ error: (error as Error).message, code: 'workspace/name-conflict' })}\n`)
        return
      }
      respond(response, 400, 'application/json', `${JSON.stringify({ error: (error as Error).message })}\n`)
    }
    return
  }

  /**
   * Fork a session — `Fork session` in its menu, DSH's item.
   *
   * The answer carries the new session's id, name and definition so the page can redraw the tree; the view is
   * deliberately **not** sent there, which is what DSH does and what keeps a fork an act of branching rather
   * than of navigating away from the conversation a person was reading.
   */
  /**
   * The session's log as a file — DSH's `Download session log`, which is the one item in its header's `More actions`
   * menu that this UI can honestly offer (the other is product feedback for DSH itself).
   *
   * The log on disk is a sequence of zstd frames, so it is served **decoded**: one JSON object per line, which is what
   * a person can read and what a script can feed back in. A download whose bytes are compressed frames would be a file
   * nobody can open, which is not what the menu item promises.
   */
  if (url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/log') && request.method === 'GET') {
    const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length, -'/log'.length))
    if (!/^session-[0-9a-f-]{36}$/i.test(id)) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'not a session id' })}\n`)
      return
    }
    const handle = ctx.session.store.open(id)
    if (handle === null) {
      respond(response, 404, 'application/json', `${JSON.stringify({ error: `no session ${id}` })}\n`)
      return
    }
    const events = ctx.session.events(handle)
    const body = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
    const meta = ctx.session.list().find((entry) => entry.id === id)
    const name = logFileName(meta?.title, id)
    response.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      /**
       * A header is not a place for a person's typed title: the ASCII fallback is the id, and the title travels in the
       * RFC 6266 `filename*` parameter, encoded — so a Chinese title or a quote cannot break the header.
       */
      'content-disposition': `attachment; filename="${id}.jsonl"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'content-length': Buffer.byteLength(body),
    })
    response.end(body)
    return
  }

  if (url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/fork') && request.method === 'POST') {
    const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length, -'/fork'.length))
    if (!/^session-[0-9a-f-]{36}$/i.test(id)) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'not a session id' })}\n`)
      return
    }
    const forked = ctx.session.fork(id)
    if (forked === null) {
      respond(response, 404, 'application/json', `${JSON.stringify({ error: `no session ${id}` })}\n`)
      return
    }
    if ('error' in forked) {
      /** A fork is cut at the last completed turn; a session with none is refused rather than copied as empty. */
      respond(
        response,
        409,
        'application/json',
        `${JSON.stringify({ error: `session ${id} has no completed turn to fork from`, code: forked.error })}\n`,
      )
      return
    }
    respond(
      response,
      200,
      'application/json',
      `${JSON.stringify({ session: forked.handle.id, name: forked.definition.name, definition: forked.definition.file, log: forked.handle.transcript }, null, 2)}\n`,
    )
    return
  }

  /**
   * Pin, unpin, archive or unarchive a session — the rest of a session's menu.
   *
   * `pinned` holds a session at the top of its branch; `archived` takes it out of the tree without touching a
   * byte of its log, which is why archiving is what this UI offers and deleting is not: an append-only record
   * is the one thing here that a menu must not try to erase. Both live in the **store's** meta record and
   * nowhere else: they are this reader's state, not facts about the run, so the committed definition keeps
   * naming the session and never claims it is archived.
   */
  if (url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/flags') && request.method === 'POST') {
    const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length, -'/flags'.length))
    if (!/^session-[0-9a-f-]{36}$/i.test(id)) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'not a session id' })}\n`)
      return
    }
    const body = await readJson(request, response)
    if (body === null) return
    const pinned = typeof body.pinned === 'boolean' ? body.pinned : undefined
    const archived = typeof body.archived === 'boolean' ? body.archived : undefined
    if (pinned === undefined && archived === undefined) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'pinned or archived is required' })}\n`)
      return
    }
    /**
     * Archiving a session with a turn in flight is refused unless the caller says to stop it, which is DSH's
     * `stopActivity` option: the durable archive set is what its pre-step gate reads, so the order is archive first, then
     * stop. Here the stop is the same abort the Stop button uses, and `{ stop: true }` is the caller agreeing to it.
     */
    if (archived === true) {
      const running = state.running.get(id) ?? 0
      if (running > 0) {
        if (body.stop !== true) {
          respond(
            response,
            409,
            'application/json',
            `${JSON.stringify({ error: `session ${id} is running; pass stop: true to stop it and archive`, code: 'active', running })}\n`,
          )
          return
        }
        abortSession(state.controllers, id)
      }
    }
    let meta
    try {
      meta = ctx.session.flags(id, {
        ...(pinned !== undefined ? { pinned } : {}),
        ...(archived !== undefined ? { archived } : {}),
      })
    } catch (error) {
      /**
       * Recognised by **class or name**: the store's error class crosses the compiled module graph, and an `instanceof` that
       * silently fails there would answer a semantic refusal as a 500. The name is part of the class's contract.
       */
      const refused = error instanceof SessionFlagError || (error instanceof Error && error.name === 'SessionFlagError')
      if (refused) {
        const code = (error as SessionFlagError).code ?? 'archived'
        respond(response, 409, 'application/json', `${JSON.stringify({ error: (error as Error).message, code })}\n`)
        return
      }
      throw error
    }
    if (meta === null) {
      respond(response, 404, 'application/json', `${JSON.stringify({ error: `no session ${id}` })}\n`)
      return
    }
    respond(response, 200, 'application/json', `${JSON.stringify(meta, null, 2)}\n`)
    return
  }

  /**
   * Retitle a conversation — the `Rename…` item in a session's or an instance's menu.
   *
   * The session's own log is append-only and stays that way: this rewrites the meta record, which is
   * what a listing and a tree row read. The title is a label rather than a fact about the run, and the
   * empty string clears it.
   *
   * `folder` is the session's **definition** folder when the caller knows it, and it is why one rename
   * reaches both halves: the store holds the label this UI reads, while the definition is the record a
   * reader of the repository reads, and a rename that stopped at the store would leave the two disagreeing.
   */
  if (url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/title') && request.method === 'POST') {
    const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length, -'/title'.length))
    if (!/^session-[0-9a-f-]{36}$/i.test(id)) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'not a session id' })}\n`)
      return
    }
    const body = await readJson(request, response)
    if (body === null) return
    if (typeof body.title !== 'string') {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'a title is required' })}\n`)
      return
    }
    const folder = typeof body.folder === 'string' && body.folder.length > 0 ? canonicalPath(body.folder) : undefined
    if (folder !== undefined) {
      const definition = readSessionDefinition(folder)
      if (definition === null || definition.id !== id) {
        respond(response, 400, 'application/json', `${JSON.stringify({ error: `${folder} does not hold ${id}` })}\n`)
        return
      }
    }
    const meta = ctx.session.rename(id, body.title)
    if (meta === null) {
      respond(response, 404, 'application/json', `${JSON.stringify({ error: `no session ${id}` })}\n`)
      return
    }
    /** Written after the store accepted it, so a folder that is not this session's never causes a write. */
    if (folder !== undefined) updateSessionDefinition(folder, { title: body.title })
    respond(response, 200, 'application/json', `${JSON.stringify(meta, null, 2)}\n`)
    return
  }

  /**
   * Change one session's access mode — the owner's action, and the only writer of the mode event.
   *
   * The rule itself lives in `permissionTransition` so the unit suite, this route and the page's own dialog
   * all judge one statement rather than three copies of it. What this route adds is the parts only the server
   * can know: the session must exist, the current mode is the session's **effective** one (its own record
   * over the deployment default), and the change is written as one append-only event before the response.
   *
   * Three refusals matter and each is deliberate:
   *
   * - an unknown mode is a `400`;
   * - an escalation to `danger-full-access` without `confirm: 'full-access'` is a `409`, so the risk gate is
   *   enforced on this side too rather than only in the page that draws it — a stale tab or a script cannot
   *   widen access by accident;
   * - an unknown session is a `404` rather than a quiet write.
   *
   * Nothing here reads a tool's arguments, and no tool can reach this route: a model-requested escalation is
   * not a path this harness has, which is what makes escalation an owner action rather than a side effect.
   */
  if (url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/permission') && request.method === 'POST') {
    const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length, -'/permission'.length))
    if (!/^session-[0-9a-f-]{36}$/i.test(id)) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'not a session id' })}\n`)
      return
    }
    const handle = ctx.session.store.open(id)
    if (handle === null) {
      respond(response, 404, 'application/json', `${JSON.stringify({ error: `no session ${id}` })}\n`)
      return
    }
    const body = await readJson(request, response)
    if (body === null) return
    const current = ctx.session.effectiveMode(handle, ctx.sandbox.mode)
    const decision = permissionTransition(current, body.mode, body.confirm)
    if (!decision.ok) {
      respond(response, 409, 'application/json', `${JSON.stringify({ error: decision.reason, session: id, mode: current })}\n`)
      return
    }
    const written = ctx.session.setMode(handle, decision.mode, ctx.sandbox.mode)
    respond(
      response,
      200,
      'application/json',
      `${JSON.stringify({ session: id, mode: written.mode, changed: written.changed, ...(written.event !== undefined ? { seq: written.event.seq } : {}) }, null, 2)}\n`,
    )
    return
  }

  /**
   * Switch a session onto one endpoint — the composer's model seat, committed.
   *
   * The same shape as the retitle above and for the same reason: a session's **record** changes and its
   * append-only log does not. The endpoint is validated against the model service rather than trusted,
   * because this is the one place a name from a browser reaches the store, and an unvalidated name would
   * be recorded and then fail every following turn with "no endpoint named ...". An unknown session is a
   * `404` rather than a quiet write, so a page attached to a session that was removed finds out.
   *
   * `model` is optional and replaces any override the session carried; omitting it means the endpoint's
   * own configured model answers, which is what a switcher selects.
   */
  if (url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/model') && request.method === 'POST') {
    const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length, -'/model'.length))
    if (!/^session-[0-9a-f-]{36}$/i.test(id)) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'not a session id' })}\n`)
      return
    }
    const body = await readJson(request, response)
    if (body === null) return
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : ''
    if (endpoint.length === 0) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'an endpoint is required' })}\n`)
      return
    }
    if (!ctx.model.names().includes(endpoint)) {
      respond(
        response,
        400,
        'application/json',
        `${JSON.stringify({ error: `no endpoint named '${endpoint}'; configured: ${ctx.model.names().join(', ')}` })}\n`,
      )
      return
    }
    const model = typeof body.model === 'string' && body.model.trim().length > 0 ? body.model.trim() : undefined
    const reasoningEffort =
      typeof body.reasoningEffort === 'string' && body.reasoningEffort.trim().length > 0 ? body.reasoningEffort.trim() : undefined
    /**
     * A model or a level the endpoint does not offer is refused here rather than recorded. It is the one place a
     * name from a browser reaches the store; recording one would make every following turn of the session fail
     * with a name nobody chose, and the page would have shown a control for a value the provider never receives.
     */
    const configured = ctx.model.endpoint(endpoint)
    const problem = configured === undefined ? null : selectionProblem(configured, model, reasoningEffort)
    if (problem !== null) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: problem })}\n`)
      return
    }
    const meta = ctx.session.setModel(id, {
      endpoint,
      ...(model !== undefined ? { model } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    })
    if (meta === null) {
      respond(response, 404, 'application/json', `${JSON.stringify({ error: `no session ${id}` })}\n`)
      return
    }
    respond(response, 200, 'application/json', `${JSON.stringify(meta, null, 2)}\n`)
    return
  }

  /**
   * Start a session at a branch, and write its definition into that branch.
   *
   * This is the `New session` action on a row, and it works at any branch — including the top-level
   * workspace root, because a person may want a session that belongs to the whole repository rather than
   * to one instance. The definition is what makes the session findable and committable; the log stays
   * machine state (see `src/session/definition.ts`).
   */
  if (url.pathname === '/api/sessions' && request.method === 'POST') {
    const workspaces = ctx.workspace
    if (workspaces === undefined) {
      respond(response, 503, 'application/json', `${JSON.stringify({ error: 'this profile does not load the workspace plugin' })}\n`)
      return
    }
    const body = await readJson(request, response)
    if (body === null) return
    const wanted = typeof body.branch === 'string' && body.branch.length > 0 ? canonicalPath(body.branch) : canonicalPath(process.cwd())
    if (workspaces.owner(wanted) === undefined) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: `${wanted} is not under any workspace root` })}\n`)
      return
    }
    const { handle, definition } = ctx.session.createAt(wanted, {
      ...(typeof body.title === 'string' && body.title.length > 0 ? { title: body.title } : {}),
    })
    respond(
      response,
      200,
      'application/json',
      `${JSON.stringify({ session: handle.id, branch: wanted, name: definition.name, definition: definition.file, log: definition.log }, null, 2)}\n`,
    )
    return
  }

  /**
   * The session a folder is bound to, created when it has none.
   *
   * This is the click that opens a folder: the client asks, the server answers with the folder's
   * current session, and the transcript is then read through the existing `/api/sessions/<id>`
   * route. It is a `POST` because it may create, and it is idempotent — asking twice for one folder
   * answers with one session, which is the whole of "one folder, one session".
   */
  if (url.pathname === '/api/folders/session' && request.method === 'POST') {
    const workspaces = ctx.workspace
    if (workspaces === undefined) {
      respond(response, 503, 'application/json', `${JSON.stringify({ error: 'this profile does not load the workspace plugin' })}\n`)
      return
    }
    const body = await readJson(request, response)
    if (body === null) return
    const folder = typeof body.folder === 'string' && body.folder.length > 0 ? canonicalPath(body.folder) : ''
    if (folder === '' || workspaces.owner(folder) === undefined) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'the folder must be under a workspace root' })}\n`)
      return
    }
    const handle = ctx.session.openAt(folder, body.new === true ? { fresh: true } : {})
    const meta = ctx.session.list().find((entry) => entry.id === handle.id)
    respond(
      response,
      200,
      'application/json',
      `${JSON.stringify({ folder, session: { id: handle.id, turns: meta?.turns ?? 0, ...(meta?.title !== undefined ? { title: meta.title } : {}) } }, null, 2)}\n`,
    )
    return
  }

  /**
   * One session's history, in the same shape the live stream delivers.
   *
   * There was no such route, and the gap was visible as a **blank right side**: the page's log region is
   * fed only by the `EventSource`, so clicking a session set the id it would filter on and then had
   * nothing to show — every event of that session had already happened. Measured in a browser: 32
   * sessions listed, `#log` empty after a click. A transcript view that only works for turns you watch
   * live is not a transcript view.
   *
   * The fold is deliberately the same vocabulary as the live path — `user`, `assistant`, `reasoning`,
   * `tool`, `denied` — so the client renders history and live deltas with one function instead of two
   * that drift.
   *
   * The deltas are read, **not** `assistant/completed`: the log records both for one turn, so reading the
   * completed event as well would print every answer twice.
   */
  if (url.pathname.startsWith('/api/sessions/') && request.method === 'GET') {
    const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length))
    /**
     * The id is a directory name under the session root, so a traversal attempt must not reach the store.
     * A real id is `session-<uuid>`; anything else is refused here rather than being resolved.
     */
    if (!/^session-[0-9a-f-]{36}$/i.test(id)) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'not a session id' })}\n`)
      return
    }
    const handle = ctx.session.store.open(id)
    if (handle === null) {
      respond(response, 404, 'application/json', `${JSON.stringify({ error: `no session ${id}` })}\n`)
      return
    }
    /**
     * One route, two views of one record — which is the point of the query parameter rather than a second
     * route: the Chat view and the Trajectory view must not be able to disagree about a session, and the way
     * that happens is for both to be projections of the same events read once.
     */
    const events = ctx.session.events(handle)
    if (url.searchParams.get('view') === 'ledger') {
      /**
       * The ledger and its timeline come from one projection of one read, so the axis above the ledger cannot
       * disagree with the rows beneath it about when anything happened.
       */
      const ledger = projectLedger(events)
      /**
       * The rows travel with the ledger: DSH's Trajectory table is one row per event with the turn and
       * step boundaries on the rows, and that projection is pure, so it is made and judged on this side
       * rather than rebuilt in the page.
       */
      /**
       * The **tool catalog** travels with the ledger: DSH's tool inspector has a Schema section beside the
       * payload and the result, and the page needs the definition the model was offered to show it.
       */
      const tools = catalogOf(ctx.tools.describe())
      /**
       * A tool row travels with its inspector content already rendered: the payload and the schema
       * parameters are highlighted JSON, and every byte of them is escaped by the renderer the unit suite
       * judges. The page therefore never builds markup from a model's strings.
       */
      const rows = projectRows(ledger).map((row) =>
        row.kind === 'tool'
          ? {
              ...row,
              inspection: inspectTool(
                {
                  payload: row.record.text,
                  result: row.record.result ?? '',
                  ...(row.record.name !== undefined ? { name: row.record.name } : {}),
                  ...(row.record.state === 'error' ? { error: true } : {}),
                },
                tools,
              ),
            }
          : row,
      )
      respond(response, 200, 'application/json', `${JSON.stringify({ id, ledger, rows, timeline: projectTimeline(ledger), tools }, null, 2)}\n`)
      return
    }
    /** The session's own record, which is where a switch from the panel was written. */
    const meta = ctx.session.list().find((entry) => entry.id === id)
    respond(
      response,
      200,
      'application/json',
      `${JSON.stringify(
        {
          id,
          /**
           * How this session is run travels with its transcript, so the composer's model seat can show
           * the session rather than the server's default. `null` means the session has never recorded a
           * choice — the page then keeps the endpoint it already had, which is what makes switching
           * before a turn survives starting the session that turn creates.
           */
          endpoint: meta?.endpoint ?? null,
          model: meta?.model ?? null,
          /**
           * The reasoning level the session was switched to, when the model declares one. It travels with the
           * transcript for the same reason the endpoint and model do: a reload has no memory, and the seat must
           * come back to what the server recorded rather than to the endpoint's default.
           */
          reasoningEffort: meta?.reasoningEffort ?? null,
          /**
           * The name the session is read under, and the folder it belongs to — the two things DSH prints above a
           * conversation's tabs. The page had them only in the sidebar, so a reader had to look away to know which
           * session was open.
           */
          title: meta?.title ?? null,
          cwd: meta?.cwd ?? null,
          /**
           * The access mode this session runs under, which is what the chip shows after a reload.
           *
           * It travels with the transcript for the same reason `endpoint` does: the mode belongs to the
           * session, so a page that read only `/api/status` would show the server's default and silently
           * misreport a session that had been switched.
           */
          permission: { mode: ctx.session.effectiveMode(handle, ctx.sandbox.mode) },
          /**
           * An answer travels as the document it is, not only as its source.
           *
           * DSH renders an assistant row's markdown once the row is **settled**, and this is the same decision
           * made on the server: the transcript is read once, so rendering here costs one pass and the page
           * never has to ask per turn. The live path (a turn that just ended) asks `/api/markdown` for the one
           * answer it has, and both go through `renderMarkdown`, so there is one renderer and one allow-list.
           */
          turns: scopeAttachmentUrls(transcriptTurns(events), id).map((turn) =>
            turn.kind === 'assistant' ? { ...turn, html: renderMarkdown(turn.text) } : turn,
          ),
          /**
           * The composer's bottom statistics, from the same events as everything else in this answer.
           * The reference prints turns, steps, a token total with its cache-hit share, and a context share;
           * every one of those is a fact of this record, so they travel with it rather than being re-derived
           * by the page from whatever happened to be on screen.
           */
          stats: (() => {
            const projected = projectSessionStats(events)
            let measured: { systemTokens: number; toolsTokens: number; messageTokens: number } | undefined
            if (projected.contextBreakdown === undefined) {
              try {
                measured = ctx.context.measure(handle, { tools: ctx.tools.describe() })
              } catch {
                measured = undefined
              }
            }
            const { contextBreakdown, contextBreakdownSource } = contextBreakdownWithFallback(projected.contextBreakdown, measured)
            return {
              ...projected,
              ...(contextBreakdown !== undefined ? { contextBreakdown } : {}),
              ...(contextBreakdownSource !== undefined ? { contextBreakdownSource } : {}),
            }
          })(),
        },
        null,
        2,
      )}\n`,
    )
    return
  }

  if (url.pathname === '/api/events' && request.method === 'GET') {
    respondSse(response)
    /**
     * Subscribed **before** `ready` is written, so every frame published after a client reads `ready` reaches it:
     * a baseline read that starts on `ready` cannot race an increment (DSH's opening rule, see `stream.ts`).
     */
    state.subscribers.add(response)
    request.on('close', () => state.subscribers.delete(response))
    /**
     * The follow cursor: `Last-Event-ID` is what the browser sends on its own retries, `?cursor=` what the page sends
     * when it reconnects itself. Honoured, the frames after it follow `ready`; not honoured (the server restarted,
     * or the log no longer reaches back), a `reset` tells the client to re-read its baselines. All of it is written
     * in this one turn of the event loop, after the subscriber was added, so no frame falls between.
     */
    const header = request.headers['last-event-id']
    const presented = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get('cursor')
    const cursor = presented !== undefined && presented !== null && presented.length > 0 ? presented : null
    const replay = cursor === null ? [] : state.log.since(cursor)
    response.write(readyFrame(newClientId(), undefined, { cursor: state.log.cursor, resumed: cursor !== null && replay !== null, heartbeatMs: state.heartbeatMs }))
    if (replay === null) response.write(resetFrame())
    /** A question answered while the client was away is not put back on its page: only waiting ones replay. */
    const approvals = ctx.get('approvals') as { pendingRequests?: () => readonly unknown[] } | undefined
    const waiting = new Set(
      (approvals?.pendingRequests?.() ?? []).map((request) => (request as { id?: unknown }).id).filter((id): id is string => typeof id === 'string'),
    )
    for (const frame of withoutSettledApprovals(replay ?? [], waiting)) response.write(frame)
    return
  }

  /**
   * The questions waiting for a person, and the answer to one.
   *
   * A page that reloads while a turn waits reads the first route to repaint its card; the second settles the
   * question exactly once. The id is generated by the approval service, not accepted from the caller, so a page
   * cannot answer a question it was not shown.
   */
  if (url.pathname === '/api/approvals' && request.method === 'GET') {
    const service = ctx.get('approvals') as { pendingRequests?: () => readonly unknown[] } | undefined
    respond(response, 200, 'application/json', `${JSON.stringify({ requests: service?.pendingRequests?.() ?? [] })}\n`)
    return
  }
  if (url.pathname.startsWith('/api/approvals/') && request.method === 'POST') {
    const id = decodeURIComponent(url.pathname.slice('/api/approvals/'.length))
    if (!/^approval-[0-9a-f-]{36}$/i.test(id)) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'not an approval id' })}\n`)
      return
    }
    const body = await readJson(request, response)
    if (body === null) return
    const outcome = body.outcome
    if (outcome !== 'allowed-once' && outcome !== 'rejected' && outcome !== 'cancelled') {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: "outcome must be 'allowed-once', 'rejected' or 'cancelled'" })}\n`)
      return
    }
    const service = ctx.get('approvals') as { answer?: (id: string, outcome: 'allowed-once' | 'rejected' | 'cancelled') => boolean } | undefined
    const answered = service?.answer?.(id, outcome) ?? false
    /**
     * A question that is no longer waiting is a **conflict**, not a success.
     *
     * The page used to hide its card on any 200 and ignore this flag, so an answer that landed nowhere — a stale id
     * from a reloaded page, a different server than the one holding the question, or one already timed out — made the
     * card disappear while the turn waited out its full answer timeout. Measured as the owner's "approved but the
     * backend is still stuck".
     */
    if (!answered) {
      respond(response, 409, 'application/json', `${JSON.stringify({ answered: false, error: 'that question is no longer waiting; it was answered elsewhere, timed out, or this server does not hold it' })}\n`)
      return
    }
    respond(response, 200, 'application/json', `${JSON.stringify({ answered: true })}\n`)
    return
  }

  /**
   * Draw text as a document.
   *
   * The page's answer arrives as deltas and is plain text until the turn ends; at that point it is the same
   * document a transcript read would have carried, so it is rendered by the same function. A `POST` because
   * the body is the text, and behind the token like every other route — the output is an allow-listed
   * reduction of somebody else's characters, which is exactly the work `sanitizeHtml` exists for.
   */
  if (url.pathname === '/api/markdown' && request.method === 'POST') {
    const body = await readJson(request, response)
    if (body === null) return
    if (typeof body.text !== 'string') {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'text is required' })}\n`)
      return
    }
    respond(response, 200, 'application/json', `${JSON.stringify({ html: renderMarkdown(body.text) })}\n`)
    return
  }

  /**
   * Steer: deliver a message **into the turn that is already running** — DSH's `steer` mode.
   *
   * DSH's agent runtime owns an inbox and injects a steered message between steps. heddle has no runtime
   * between steps, so the delivery is an **append**: the message becomes part of the session's surface, and
   * the loop — which re-derives its context at the top of every round — sees it and answers it in the same
   * turn. The loop's half of that rule is in `src/agent/loop.ts`.
   *
   * The refusal is DSH's, code and meaning: a steer whose turn has ended is not a queued message the caller
   * can leave to happen, it is a delivery that cannot arrive, so it is answered `409` and the caller (the
   * composer) falls back to queueing it. Measured on 2026-10-12: without this route the composer's
   * accelerated chord could only reorder a local list, which is not what the chord means.
   */
  if (url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/steer') && request.method === 'POST') {
    const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length, -'/steer'.length))
    if (!/^session-[0-9a-f-]{36}$/i.test(id)) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'not a session id' })}\n`)
      return
    }
    const body = await readJson(request, response)
    if (body === null) return
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (prompt.length === 0) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'a prompt is required' })}\n`)
      return
    }
    let steerAttachments
    try {
      steerAttachments = readAttachments(body.attachments)
    } catch (error) {
      if (!(error instanceof AttachmentInputError)) throw error
      respond(response, 400, 'application/json', `${JSON.stringify({ error: error.message })}\n`)
      return
    }
    if ((state.running.get(id) ?? 0) === 0) {
      respond(
        response,
        409,
        'application/json',
        `${JSON.stringify({ error: 'the current turn no longer accepts steering', code: 'session/steer-unavailable' })}\n`,
      )
      return
    }
    const handle = ctx.session.store.open(id)
    if (handle === null) {
      respond(response, 404, 'application/json', `${JSON.stringify({ error: `no session ${id}` })}\n`)
      return
    }
    /**
     * Recording the message is the delivery.
     *
     * `ctx.session.user` writes the same event the composer's own turn would have written, so the appending
     * is measured by the loop's next round and streamed to every reader by the one write path — there is no
     * second channel a steer could travel on without becoming a second truth.
     */
    ctx.session.userContent(handle, [{ type: 'text', text: prompt }, ...steerAttachments])
    respond(response, 200, 'application/json', `${JSON.stringify({ accepted: true, session: id }, null, 2)}\n`)
    return
  }

  /**
   * Stop: end the turn that is running, now.
   *
   * DSH draws one button that is Send when idle and Stop while a turn runs; the difference is not cosmetic,
   * because a turn that has gone wrong costs the reader the answer they are waiting for and the provider
   * request they are paying for. The abort reaches the HTTP request itself (`src/llm/http.ts` destroys the
   * connection on `abort`), so a slow provider is interrupted rather than waited out.
   *
   * `stopped: 0` is not an error: the turn may have ended between the click and the request, which is the
   * same race the steer route answers with `409`. Answering it as success keeps the button honest — pressing
   * Stop when nothing runs is a no-op, not a failure the page has to draw.
   */
  if (url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/stop') && request.method === 'POST') {
    const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length, -'/stop'.length))
    if (!/^session-[0-9a-f-]{36}$/i.test(id)) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'not a session id' })}\n`)
      return
    }
    const stopped = abortSession(state.controllers, id)
    respond(response, 200, 'application/json', `${JSON.stringify({ stopped, session: id })}\n`)
    return
  }

  /**
   * What the composer needs to describe the machine it is talking to.
   *
   * `sandbox.mode` here is the **deployment default**: the mode a session starts from and the one the chip
   * reports while no session is open. A session that switched does not appear here — its own mode travels
   * with `GET /api/sessions/<id>`, because a server-wide answer would misreport every session that chose
   * otherwise.
   */
  if (url.pathname === '/api/status' && request.method === 'GET') {
    respond(
      response,
      200,
      'application/json',
      `${JSON.stringify({ sandbox: { mode: ctx.sandbox.mode }, cwd: ctx.sandbox.workspaceRoot })}\n`,
    )
    return
  }

  if (url.pathname === '/api/turn' && request.method === 'POST') {
    await handleTurn(ctx, request, response, state)
    return
  }

  respond(response, 404, 'text/plain', 'not found\n')
}

/**
 * The Host and Origin fence.
 *
 * Returns a reason when the request must be refused, `null` when it may proceed.
 * Extracted so the rule is testable without a socket.
 */
export function rejectUntrusted(request: { headers: Record<string, string | string[] | undefined>; method?: string }, authority: string): string | null {
  const host = String(request.headers.host ?? '')
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  if (host !== '' && !isLoopback(hostname ?? '')) return `refused: Host ${host} is not loopback`

  /**
   * `Sec-Fetch-Site` is **not** judged here, and that is a correction with a reason.
   *
   * Whether a cross-site request may write depends on whether it is **already authenticated**, and this
   * function has no access to the credential. Measured: a viewer that embeds the page in a **sandboxed
   * iframe** has an opaque origin, so the browser marks every request it makes cross-site — reads worked and
   * sending a prompt was refused with `403`, because the write path judged the header on its own. The owner
   * could watch heddle in the sidebar and not talk to it.
   *
   * The rule now lives where the credential is known, and it reads: a cross-site write is refused unless it
   * carries a valid session. That is the safe half of both previous behaviours — an attacker issuing a
   * cross-site POST cannot carry the session, because the cookie is `SameSite=Strict` and a browser does not
   * attach it, so they are refused for the older and better reason: they are unauthenticated.
   *
   */
  const origin = request.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    let hostname = ''
    let host = ''
    try {
      const parsed = new URL(origin)
      hostname = parsed.hostname
      host = parsed.host
    } catch {
      /**
       * `null` is what a sandboxed frame and a `file://` page send. It is not an origin at all, so it is
       * refused here even though the request's read requests are allowed — and this is the one Origin case
       * that still carries weight once a credential decides the rest.
       */
      return `refused: Origin ${origin} is not a URL`
    }
    /**
     * **A same-machine origin is not a foreign origin**, and it was the deployment that broke.
     *
     * Measured 2026-10-11: the owner opens heddle through a token-supplying gate on `127.0.0.1:8082`, which
     * forwards to the server on `127.0.0.1:3082` — so every write arrived with `Origin:
     * http://127.0.0.1:8082` and was refused with `403`, while every read was served. The tree drew, and
     * **New session did nothing**: the button was there, the request was rejected, and the only report was
     * one line in a note. The gate is same-machine by construction, and the credential — which this fence
     * does not hold — is what separates the owner from an attacker: a foreign page cannot carry a
     * `SameSite=Strict` cookie, and cannot know the launch token. The rule below is therefore the one the
     * comment above already states, applied to both headers: a foreign **site** is judged by its credential,
     * and an origin that is not this machine is refused outright, because no deployment of this server comes
     * from one.
     */
    if (host !== authority && !isLoopback(hostname)) return `refused: Origin ${origin} is not this machine`
  }
  return null
}

/**
 * Read a JSON body, answering `413` or `400` itself.
 *
 * Returns `null` when it has already replied, so a caller cannot answer twice for one request — the
 * failure mode of a helper that both reports and returns is a second response written onto a socket
 * that is already finished.
 */
async function readJson(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | null> {
  let raw = ''
  for await (const chunk of request) {
    raw += chunk
    if (raw.length > 10 * 1024 * 1024) {
      respond(response, 413, 'text/plain', 'request too large\n')
      return null
    }
  }
  try {
    return JSON.parse(raw.length === 0 ? '{}' : raw) as Record<string, unknown>
  } catch {
    respond(response, 400, 'text/plain', 'the body must be JSON\n')
    return null
  }
}

/**
 * Which endpoint answers a turn, from the four places a name can come from.
 *
 * Pure and exported so the order can be judged without a socket, because the order **is** the rule. It
 * mirrors DSH's model selection: what the request names wins, then what the session itself recorded, then
 * the server's own default (the flag `heddle web --endpoint` carries), then the configuration's nomination.
 * An empty string is absence rather than a name — a page that sends `endpoint: ''` must fall through
 * instead of asking the model service for an endpoint called nothing.
 */
/**
 * Abort every running turn of one session, and report how many were running.
 *
 * A function over the map rather than over the server so the rule can be judged without a socket: a stop
 * aborts the handles it finds, clears them, and a second stop finds none.
 */
export function abortSession(controllers: Map<string, Set<AbortController>>, id: string): number {
  const set = controllers.get(id)
  if (set === undefined) return 0
  let stopped = 0
  for (const controller of set) {
    if (!controller.signal.aborted) stopped += 1
    controller.abort()
  }
  set.clear()
  controllers.delete(id)
  return stopped
}

export function resolveTurnEndpoint(sources: {
  readonly requested?: string
  readonly recorded?: string
  readonly serverDefault?: string
  readonly serviceDefault?: string
}): string | undefined {
  for (const candidate of [sources.requested, sources.recorded, sources.serverDefault, sources.serviceDefault]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * Which reasoning level a turn runs with: the request's, then the session's record, then nothing.
 *
 * The same ladder as the endpoint and for the same reason — a reload sends the session id without a choice, so
 * the record is what makes a switch survive it. It is a level **id**, not the provider's wire value: the adapter
 * resolves the value through the model's own catalogue, so a level that is recorded but no longer declared is
 * filtered by the caller rather than sent to a provider that would refuse every turn.
 */
export function resolveTurnEffort(sources: {
  readonly requested?: string
  readonly recorded?: string
}): string | undefined {
  for (const candidate of [sources.requested, sources.recorded]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * The selection a session's own record carries, as fields a model request may be given.
 *
 * The `model/request` waterfall's rule reduced to a pure function: a running turn reads the session's record
 * before **every** model call, so a switch made while the turn streams lands on its next step — DSH's own
 * running-turn behaviour. A record without an endpoint names no selection at all, because an endpoint is what
 * makes a model or an effort meaningful.
 */
export function sessionRequestSelection(
  meta: SessionMeta | undefined,
): { readonly endpoint?: string; readonly model?: string; readonly reasoningEffort?: string } {
  if (meta?.endpoint === undefined) return {}
  return {
    endpoint: meta.endpoint,
    ...(meta.model !== undefined ? { model: meta.model } : {}),
    ...(meta.reasoningEffort !== undefined ? { reasoningEffort: meta.reasoningEffort } : {}),
  }
}

/** Run one turn and stream its session events back as they are written. */async function handleTurn(ctx: Context, request: IncomingMessage, response: ServerResponse, state: RequestState): Promise<void> {
  let raw = ''
  for await (const chunk of request) {
    raw += chunk
    if (raw.length > 10 * 1024 * 1024) {
      respond(response, 413, 'text/plain', 'request too large\n')
      return
    }
  }
  let body: {
    session?: string
    prompt?: string
    attachments?: unknown
    endpoint?: string
    model?: string
    reasoningEffort?: string
    folder?: string
    new?: boolean
  }
  try {
    body = JSON.parse(raw.length === 0 ? '{}' : raw) as typeof body
  } catch {
    respond(response, 400, 'text/plain', 'the body must be JSON\n')
    return
  }
  if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
    respond(response, 400, 'text/plain', 'a prompt is required\n')
    return
  }
  /**
   * The attachments the composer chose: paths into the upload directory, read into typed blocks here.
   *
   * The browser names files, never their content; the server measures the name, size, digest and media type,
   * and records the reference with the user message so the request projection can deliver it the way DSH
   * does. A bad reference refuses the whole turn rather than sending a partial one.
   */
  let attachments
  try {
    attachments = readAttachments(body.attachments)
  } catch (error) {
    if (!(error instanceof AttachmentInputError)) throw error
    respond(response, 400, 'application/json', `${JSON.stringify({ error: error.message })}\n`)
    return
  }

  /**
   * Where the turn runs, and which session it continues.
   *
   * With no `folder` the behaviour is exactly what it was: a fresh session in the server's own
   * working directory. Naming a folder is what the tree's client asks for when a person selects a
   * node, and it continues that folder's session — which is what makes a selection in the left
   * column mean "this folder's conversation" rather than "a new one". `new` starts another one for
   * that folder instead, leaving the previous log where it is.
   */
  const folder = typeof body.folder === 'string' && body.folder.length > 0 ? canonicalPath(body.folder) : null
  /**
   * The endpoint and model the request names, checked **before** a session exists.
   *
   * The order is a correction rather than a tidy-up: the earlier code created the session first and only
   * then checked the name, so a request naming an endpoint that is not configured left behind a real
   * session, with a real definition and no turn in it. A name arriving from a browser is the one thing
   * here that must be checked before anything is written.
   */
  const requested = typeof body.endpoint === 'string' && body.endpoint.length > 0 ? body.endpoint : undefined
  if (requested !== undefined && !ctx.model.names().includes(requested)) {
    respond(response, 400, 'text/plain', `no endpoint named '${requested}'; configured: ${ctx.model.names().join(', ')}\n`)
    return
  }
  const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : undefined
  const requestedEffort =
    typeof body.reasoningEffort === 'string' && body.reasoningEffort.length > 0 ? body.reasoningEffort : undefined
  const born = {
    ...(requested !== undefined ? { endpoint: requested } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(requestedEffort !== undefined ? { reasoningEffort: requestedEffort } : {}),
  }
  const handle: SessionHandle =
    typeof body.session === 'string' && body.session.length > 0
      ? ctx.session.start({ resume: body.session })
      : folder !== null
        ? ctx.session.openAt(folder, { ...(body.new === true ? { fresh: true } : {}), title: body.prompt.slice(0, 60), ...born })
        : ctx.session.start({ cwd: process.cwd(), title: body.prompt.slice(0, 60), ...born })
  if (folder !== null) ctx.workspace?.ensureOwner(folder)
  /**
   * Which endpoint answers: the request, then the session's own record, then the server's default, then the
   * configuration's. The session's record sits above the server's because a session switched from the panel
   * must stay switched — a reload sends the session id without the choice, and reading the server's default
   * first would make the switch a per-request illusion.
   */
  const record = ctx.session.list().find((entry) => entry.id === handle.id)
  const nominated = ctx.model.defaultEndpoint()
  const endpoint = resolveTurnEndpoint({
    ...(requested !== undefined ? { requested } : {}),
    ...(record?.endpoint !== undefined ? { recorded: record.endpoint } : {}),
    ...(state.defaultEndpoint !== undefined ? { serverDefault: state.defaultEndpoint } : {}),
    ...(nominated !== undefined ? { serviceDefault: nominated } : {}),
  })
  if (endpoint === undefined) {
    respond(response, 400, 'text/plain', 'no endpoint is configured\n')
    return
  }
  /**
   * A recorded endpoint that the configuration no longer holds fails **loudly**, naming it. Falling back to
   * another backend would answer a switched session with a model its person did not choose; the page shows
   * the missing name in its menu so the reason is visible where the fix is.
   */
  if (!ctx.model.names().includes(endpoint)) {
    respond(response, 400, 'text/plain', `no endpoint named '${endpoint}'; configured: ${ctx.model.names().join(', ')}\n`)
    return
  }
  /**
   * The model and the reasoning level the turn runs with, read the same way the endpoint is.
   *
   * A model belongs to the endpoint that offered it, so a request that names a **different** endpoint must not
   * inherit the record's model or effort: that pair belongs to the backend being left. When the request names
   * this endpoint (or none), the record's own choice fills in — which is what a reload relies on, because it
   * sends the session id without the page's memory.
   *
   * The level is then filtered through the model's own catalogue: an effort recorded before a configuration
   * change is not sent to a provider that no longer declares it, and a caller that names one the model does not
   * offer gets the model's default rather than a refusal on every following turn. The **route** that a browser
   * writes through (`/api/sessions/<id>/model`) refuses such a level instead of filtering, because that is the
   * point where a person can be told.
   */
  const sameEndpoint = requested === undefined || requested === record?.endpoint
  const runModel = model ?? (sameEndpoint ? record?.model : undefined)
  const runEndpoint = ctx.model.endpoint(endpoint)
  const wantedEffort = resolveTurnEffort({
    ...(requestedEffort !== undefined ? { requested: requestedEffort } : {}),
    ...(sameEndpoint && record?.reasoningEffort !== undefined ? { recorded: record.reasoningEffort } : {}),
  })
  const runEffort =
    runEndpoint !== undefined && wantedEffort !== undefined && reasoningLevelFor(runEndpoint, runModel, wantedEffort) !== undefined
      ? wantedEffort
      : undefined
  /**
   * The session records how it is run.
   *
   * A session created by this request is born with the choice, so this writes only when the record and the
   * turn disagree — a resumed session this request pointed elsewhere, or one started before the record
   * existed. Writing only on a difference is what keeps an ordinary turn from rewriting a metadata file on
   * every message, which is also the reason the comparison includes the model and the level.
   */
  if (record?.endpoint !== endpoint || record?.model !== runModel || record?.reasoningEffort !== runEffort) {
    ctx.session.setModel(handle.id, {
      endpoint,
      ...(runModel !== undefined ? { model: runModel } : {}),
      ...(runEffort !== undefined ? { reasoningEffort: runEffort } : {}),
    })
  }

  /**
   * The session is marked running **before** the stream opens, and unmarked in the `finally` below.
   *
   * That mark is the whole of "is there a turn to steer into": DSH refuses a steer whose turn has ended, and
   * this route asks the same question about the same fact. It is a count because two turns on one session are
   * possible, and a set would clear the mark for a session that is still running.
   */
  /**
   * A **new turn starts its own clock**.
   *
   * `runningSince` is the origin the running row counts from, so it must be this turn's start, not whatever start an
   * earlier turn left behind (a missed cleanup, or a turn that followed one whose end event was lost, used to make
   * the row read as a cumulative time instead of "this turn so far"). The count transitions 0 → 1 exactly when a
   * turn begins on an idle session; a second concurrent turn on the same session does not reset the first one's
   * clock.
   */
  const activeTurns = state.running.get(handle.id) ?? 0
  state.running.set(handle.id, activeTurns + 1)
  if (activeTurns === 0) state.runningSince.set(handle.id, Date.now())
  /**
   * The turn's abort handle, registered before the stream opens so a stop arriving immediately after the
   * request still finds it. The `finally` below removes it either way, which is what keeps a finished
   * session from accumulating handles a later stop would abort for nothing.
   */
  const controller = new AbortController()
  const handles = state.controllers.get(handle.id) ?? new Set<AbortController>()
  handles.add(controller)
  state.controllers.set(handle.id, handles)
  respondSse(response)
  state.clients.add(response)
  /**
   * Writing to a client that has gone away must not become an uncaught exception.
   *
   * Measured: when a check or a browser closed the stream mid-turn, the write raised
   * `ERR_STREAM_WRITE_AFTER_END` inside a request the server does not await, and the process
   * died — so the *next* request failed with "fetch failed" and the failure had nothing to do
   * with what it named.
   */
  const safeWrite = (text: string) => {
    if (response.writableEnded || response.destroyed) return
    try {
      response.write(text)
    } catch {
      // The client left; the session is recorded either way.
    }
  }
  const forward = (payload: { session: string; event: SessionEvent }) => {
    if (payload.session !== handle.id) return
    safeWrite(`event: session\ndata: ${JSON.stringify(payload)}\n\n`)
  }
  // A listener registered through `ctx.on` here would need a fiber of its own, and the
  // request has none, so the turn's events are relayed by subscribing directly to the
  // same emit the server already listens on for other clients.
  const unsubscribe = subscribeSessionEvent(ctx, forward)
  try {
    const result = await runTurn(ctx, {
      session: handle,
      endpoint,
      prompt: body.prompt,
      ...(attachments.length > 0 ? { attachments } : {}),
      signal: controller.signal,
      /**
       * An interactive turn gets the server's own round budget. Without this it inherited the loop's one-shot
       * default of eight, and a task that needed more stopped mid-way with an empty answer — the owner's
       * "backend stopped to respond" on prompts with more than twenty steps.
       */
      maxRounds: state.maxRounds,
      ...(runModel !== undefined ? { model: runModel } : {}),
      ...(runEffort !== undefined ? { reasoningEffort: runEffort } : {}),
    })
    /**
     * A turn that was stopped is a cancellation, not a completion — including the case where the loop noticed the
     * abort between rounds and returned a result instead of throwing. Without this, the page saw a normal `done`
     * and left the composer in its running state.
     */
    if (controller.signal.aborted) {
      safeWrite(`event: cancelled\ndata: ${JSON.stringify({ session: handle.id, message: 'stopped' })}\n\n`)
      return
    }
    safeWrite(
      `event: done\ndata: ${JSON.stringify({
        session: handle.id,
        text: result.text,
        finishReason: result.finishReason,
        rounds: result.rounds,
        denials: result.denials,
        /** Why the turn stopped early, so the page can say it rather than leaving an empty answer. */
        ...(result.ended !== undefined ? { ended: result.ended } : {}),
        /** What the provider said the turn cost; the page derives a rate and a context share from it. */
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
      })}\n\n`,
    )
  } catch (error) {
    /**
     * A stopped turn is an answer, not a failure: the abort reaches the provider connection and the loop
     * unwinds through this `catch`. Reporting it as an error would put a red sentence in the transcript for
     * something the reader asked for, so it is its own event and the page settles the row with it.
     */
    if (controller.signal.aborted) {
      safeWrite(`event: cancelled\ndata: ${JSON.stringify({ session: handle.id, message: 'stopped' })}\n\n`)
    } else {
      /**
       * The failure is logged as well as streamed. Measured: an error that only reached the
       * client left the server's own output silent, so diagnosing it meant guessing from an empty
       * stream instead of reading one line.
       */
      ctx.logger.warn('web: the turn failed — %s', (error as Error).message)
      /**
       * The failure carries its session. Without it a page could not clear the running state a failed turn set, and
       * a session that is not running kept its spinner and its running row (the owner's "weaving shows for sessions
       * that are not active at all").
       */
      safeWrite(`event: error\ndata: ${JSON.stringify({ session: handle.id, message: (error as Error).message })}\n\n`)
    }
  } finally {
    handles.delete(controller)
    if (handles.size === 0) state.controllers.delete(handle.id)
    unsubscribe()
    const left = (state.running.get(handle.id) ?? 1) - 1
    if (left > 0) state.running.set(handle.id, left)
    else {
      state.running.delete(handle.id)
      state.runningSince.delete(handle.id)
      state.completedAt.set(handle.id, Date.now())
    }
    state.clients.delete(response)
    if (!response.writableEnded && !response.destroyed) response.end()
  }
}

/**
 * Relay `session/event` to one function for the duration of a request.
 *
 * Cordis's `ctx.on` returns a disposer and is the normal way to listen; this wrapper
 * exists so the call site reads as what it is — a subscription with a lifetime the
 * request owns.
 */
function subscribeSessionEvent(ctx: Context, forward: (payload: { session: string; event: SessionEvent }) => void): () => void {
  const dispose = ctx.on('session/event', forward)
  return () => {
    if (typeof dispose === 'function') dispose()
  }
}

function respondSse(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  response.write(STREAM_OPEN)
}

/**
 * The type a document may embed inline, or `null` for anything a browser should not run in this origin.
 *
 * A deny-by-default map rather than a lookup of everything known: the list is the types an `<img>`, an `@font-face`
 * or a `<video>` needs, and a file outside it is still served — as a download, so a person can have it without the
 * page executing it.
 */
/**
 * The headers **every answer of a file route** carries, success or failure.
 *
 * `/api/raw` and `/api/uploads` serve a workspace's or a person's own bytes on the page's origin, with the session
 * cookie in scope, so whatever a browser can run from such an answer runs as the user. Measured 2026-10-29 (DSH
 * parity R-developer-twelve-16): a workspace SVG served inline and opened directly ran its script, and its
 * `fetch('/api/sessions')` answered 200. DSH answers its own file route with exactly these two headers on every
 * response, because "HTML and SVG files may be opened directly on the authenticated API origin": `sandbox` runs
 * such a document with no script and no origin, `default-src 'none'` lets it load nothing, and `nosniff` keeps a
 * download from being read as a page. A policy on an image or a stylesheet does not affect the page that embeds it.
 */
export const FILE_ANSWER_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "sandbox; default-src 'none'",
  'x-content-type-options': 'nosniff',
}

function inlineContentType(path: string): string | null {
  const extension = extname(path).toLowerCase()
  const known: Readonly<Record<string, string>> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.otf': 'font/otf', '.pdf': 'application/pdf',
  }
  return known[extension] ?? null
}

function respond(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  extra: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', ...extra })
  response.end(body)
}

/** The page. One file, no build step, and no framework — the same choice DSH makes. */
/**
 * The transcript's attachment addresses for one session: each card's `url` names the session it is read for, because
 * the upload route serves a file only to a session whose log references it (DSH's `session/attachment`).
 */
export function scopeAttachmentUrls<T extends { readonly attachments?: readonly TurnAttachment[] }>(
  turns: readonly T[],
  session: string,
): T[] {
  const query = `session=${encodeURIComponent(session)}`
  return turns.map((turn) =>
    Array.isArray(turn.attachments) && turn.attachments.length > 0
      ? { ...turn, attachments: turn.attachments.map((card) => ({ ...card, url: `${card.url}${card.url.includes('?') ? '&' : '?'}${query}` })) }
      : turn,
  )
}

/**
 * The files one message carries, as transcript cards.
 *
 * The stored path is only used to find the leaf the serving route addresses; everything a person sees is the
 * metadata the server measured when the message was recorded.
 */
export function attachmentsOf(
  content: readonly { readonly type?: string; readonly name?: string; readonly path?: string; readonly mimeType?: string; readonly bytes?: number }[],
): TurnAttachment[] {
  const attachments: TurnAttachment[] = []
  for (const part of content) {
    if (part.type !== 'image' && part.type !== 'file') continue
    const leaf = typeof part.path === 'string' ? basename(part.path) : ''
    if (leaf.length === 0) continue
    const bytes = typeof part.bytes === 'number' && Number.isFinite(part.bytes) ? part.bytes : 0
    attachments.push({
      kind: part.type,
      name: typeof part.name === 'string' && part.name.length > 0 ? part.name : leaf,
      mimeType: typeof part.mimeType === 'string' ? part.mimeType : 'application/octet-stream',
      bytes,
      url: `/api/uploads/${encodeURIComponent(leaf)}`,
    })
  }
  return attachments
}

/**
 * Fold a session's recorded events into the display turns the page renders.
 *
 * Exported so the fold can be judged directly: it is pure, it is where the two subtle rules live (read the
 * deltas rather than the completion; keep reasoning separate), and a unit test can cover both in a way no
 * end-to-end check can isolate.
 *
 * Read from the deltas rather than from `assistant/completed`, because one turn records both and reading
 * the completion too would double every answer. Reasoning keeps its own kind, as it does live: it is the
 * part a reader most wants separated from what the model said.
 */
export function transcriptTurns(
  /**
   * Any logged event, not only the two this fold looks at.
   *
   * A real transcript is a log: `session/created` carries a `cwd`, `model/request` carries a message
   * count, and the fold's job is to ignore what it does not display rather than to demand that a
   * caller pre-filter the log into a shape this file invented. Measured while a unit test handed it
   * the events a session actually holds: the narrower parameter rejected every one of them.
   */
  events: readonly { readonly type: string; readonly [key: string]: unknown }[],
): readonly ChatTurn[] {
  const turns: ChatTurn[] = []
  /** Where each open call sits, by the id its result will carry. */
  const open = new Map<string, number>()
  /** The newest call without a result, for a provider that sends no ids at all. */
  let lastOpen = -1
  /**
   * The turn a run of deltas is still being appended to, or `-1` when no run is open.
   *
   * A provider streams an answer as many `text-delta` chunks and a reasoning block as many
   * `reasoning-delta` chunks; a transcript that made each chunk a row drew one sentence as dozens of
   * rows, which is what a browser showed on 2026-10-17. The live view already merges them into one
   * node, so the fold has to as well or the same answer reads differently after a reload. A run ends
   * at anything that is not its own delta — another kind of delta, a call, a message, a completion.
   */
  let openAssistant = -1
  let openReasoning = -1
  /**
   * The files written since the last user message, which the exchange's answer carries as its panel data. A write
   * that arrives after the answer has been drawn belongs to no answer, so it is kept for the next one rather than
   * retroactively attached.
   */
  let written: { path: string; added: number }[] = []
  /** Writes kept per exchange, keyed by the index of the user turn that opened it. */
  const sections = new Map<number, { path: string; added: number }[]>()
  let sectionStart = -1
  const noteWrite = (name: string, argumentsText: string): void => {
    if (name !== 'write_file') return
    let args: { path?: unknown; content?: unknown }
    try {
      args = JSON.parse(argumentsText) as { path?: unknown; content?: unknown }
    } catch {
      return
    }
    if (typeof args.path !== 'string' || typeof args.content !== 'string') return
    /** Lines a file will have, not segments: a trailing newline closes the last line rather than starting one. */
    const lines = args.content === '' ? 0 : args.content.split('\n').length - (args.content.endsWith('\n') ? 1 : 0)
    if (sectionStart >= 0) {
      const bucket = sections.get(sectionStart) ?? []
      sections.set(sectionStart, bucket)
      written = bucket
    }
    const existing = written.find((file) => file.path === args.path)
    if (existing === undefined) written.push({ path: args.path, added: lines })
    else existing.added = lines
  }
  const closeRuns = (): void => {
    openAssistant = -1
    openReasoning = -1
  }
  /**
   * A blank-line-only delta between two tokens is a **stream artifact**, not prose.
   *
   * Measured 2026-10-18 in the owner's transcript: a build of the server streamed content as `'检测'`, `'\n\n\n'`,
   * `'器'`, `'\n\n\n'`, … so a sentence rendered with a blank line between every word. A real paragraph break
   * follows sentence-ending punctuation (or whitespace); a run of two or more newlines wedged between two ordinary
   * characters is not one, and the fold drops it the same way the live page does.
   */
  const isStreamArtifact = (text: string, open: { readonly text: string } | undefined): boolean => {
    if (open === undefined || !/^\n{2,}$/.test(text)) return false
    const previous = open.text.slice(-1)
    return previous !== '' && !/[\s。．.!?！？：:；;，,、）)」』】]/.test(previous)
  }
  /** Append to the open run when there is one, and otherwise open a new turn for it. */
  const append = (kind: 'assistant' | 'reasoning', text: string, index: number): number => {
    const turn = index >= 0 ? turns[index] : undefined
    if (turn !== undefined) {
      if (kind === 'assistant' && isStreamArtifact(text, turn)) return index
      turns[index] = { ...turn, text: turn.text + text }
      return index
    }
    turns.push({ kind, text })
    return turns.length - 1
  }

  const close = (index: number, result: string): void => {
    const turn = turns[index]
    if (turn === undefined) return
    turns[index] = { ...turn, result, state: /^error/i.test(result) ? 'error' : 'ok' }
  }

  for (const event of events) {
    if (event.type === 'message') {
      /** A message is a whole thing, not a delta, so whatever run was open has ended. */
      closeRuns()
      const message = event.message as
        | {
            role?: string
            content?: readonly { type?: string; text?: string; name?: string; path?: string; mimeType?: string; bytes?: number }[]
            toolCallId?: string
          }
        | undefined
      if (message === undefined) continue
      const text = (message.content ?? []).map((part) => part.text ?? '').join('')
      if (message.role === 'user') {
        written = []
        sectionStart = turns.length
        const attachments = attachmentsOf(message.content ?? [])
        turns.push({
          kind: 'user',
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(typeof event.at === 'string' ? { time: event.at } : {}),
        })
      }
      else if (message.role === 'assistant') turns.push({ kind: 'assistant', text })
      else if (message.role === 'tool') {
        /**
         * A tool's result names the call it answers, so it **fills that call in** rather than becoming a
         * row of its own.
         *
         * This is the whole point of the fold: a person reading a transcript wants "it ran this and got
         * that" as one thing they can open, not two rows they have to match up by eye — which is how
         * DSH renders it too, one element per call that carries its result. The id is what pairs them;
         * a provider that sends none is paired with the newest call still open, and a result that
         * matches nothing is still shown, because losing it would be worse than an unpaired row.
         */
        const index = message.toolCallId !== undefined && open.has(message.toolCallId) ? (open.get(message.toolCallId) ?? -1) : lastOpen
        if (index >= 0 && turns[index]?.kind === 'tool' && turns[index]?.result === undefined) {
          close(index, text)
          if (message.toolCallId !== undefined) open.delete(message.toolCallId)
          lastOpen = -1
          continue
        }
        turns.push({ kind: 'tool', text: '', result: text, state: /^error/i.test(text) ? 'error' : 'ok', ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}) })
      }
      continue
    }
    if (event.type !== 'assistant/chunk') {
      /**
       * A stopped turn records its reason on the completion. It is attached to the answer it stopped — or, when
       * the model produced no text at all, to a settled row that exists only to carry the notice.
       */
      if (event.type === 'assistant/completed' && Array.isArray(event.ended)) {
        const ended = event.ended.filter((entry): entry is string => typeof entry === 'string')
        if (ended.length > 0) {
          const last = turns[turns.length - 1]
          if (last !== undefined && last.kind === 'assistant') turns[turns.length - 1] = { ...last, ended }
          else turns.push({ kind: 'assistant', text: typeof event.text === 'string' ? event.text : '', ended })
        }
      }
      /** A completion or any other record ends the run of deltas that preceded it. */
      closeRuns()
      continue
    }
    const chunk = event.chunk as { type?: string; text?: string; id?: string; name?: string; arguments?: string } | undefined
    if (chunk === undefined) continue
    if (chunk.type === 'text-delta' && chunk.text !== undefined) {
      openAssistant = append('assistant', chunk.text, openAssistant)
      openReasoning = -1
    } else if (chunk.type === 'reasoning-delta' && chunk.text !== undefined) {
      openReasoning = append('reasoning', chunk.text, openReasoning)
      openAssistant = -1
    }
    /**
     * A call opens one turn, and keeps its **name apart from its arguments**.
     *
     * The name is what the closed one-liner shows; the arguments are worth reading only when someone
     * asks. Deriving the name on the client would mean parsing it back out of a string this code just
     * built, which is why it travels as a field.
     */
    else if (chunk.type === 'tool-call' && chunk.name !== undefined) {
      noteWrite(chunk.name, chunk.arguments ?? '')
      turns.push({
        kind: 'tool',
        name: chunk.name,
        label: `→ ${chunk.name}`,
        text: chunk.arguments ?? '{}',
        state: 'running',
        ...(chunk.id !== undefined ? { toolCallId: chunk.id } : {}),
      })
      lastOpen = turns.length - 1
      if (chunk.id !== undefined) open.set(chunk.id, lastOpen)
      /** A call is its own row, so text on either side of it is two runs rather than one. */
      closeRuns()
    }
  }
  /**
   * The **Edited files** panel belongs to the message that closes an exchange, so the writes are attached to that
   * exchange's last answer once the whole log is folded — not to the first delta of a streamed answer, which is
   * created before the writes that followed it are known.
   */
  for (const [start, files] of sections) {
    if (files.length === 0) continue
    let lastAnswer = -1
    for (let index = start + 1; index < turns.length; index += 1) {
      if (turns[index]?.kind === 'user') break
      if (turns[index]?.kind === 'assistant') lastAnswer = index
    }
    const answer = turns[lastAnswer]
    if (lastAnswer >= 0 && answer !== undefined) turns[lastAnswer] = { ...answer, files: files.map((file) => ({ ...file })) }
  }
  return turns
}

/** One thing the chat shows, after the fold. A tool turn carries both halves of one call. */
/** One file attached to a person's message, as the transcript draws it. */
export interface TurnAttachment {
  /** What the card shows: an image preview, or a file chip. */
  readonly kind: 'image' | 'file'
  readonly name: string
  readonly mimeType: string
  readonly bytes: number
  /** The same-origin read-only address this server serves the stored bytes at. */
  readonly url: string
}

export interface ChatTurn {
  readonly kind: 'user' | 'assistant' | 'reasoning' | 'tool'
  /**
   * When the logged event happened, as its own `at` — the **user message's clock**, which the page shows beside
   * the bubble and the copy button (DSH's `MessageIconActions` reads the same event time). It is the recorded
   * instant, not the render clock: a reloaded session shows when each message was sent.
   */
  readonly time?: string
  /**
   * The files this exchange wrote, in the order they were written — the **Edited files** panel's data.
   *
   * DSH derives its panel from a host-side comparison of the turn's start and end (`dsh-workspace-changes`); heddle
   * has no such snapshot service, so the fact it can state is the one its log already records: a `write_file` call's
   * path and the lines its content carried. That is what this carries — `added` is real, `deleted` is unknown rather
   * than zero, so the page shows only what it knows.
   */
  readonly files?: readonly { readonly path: string; readonly added: number }[]
  /**
   * Why the turn stopped early, from its `assistant/completed` event — the page's notice row. The reason was
   * local to the loop before this; a reloaded transcript could not say why its answer was empty.
   */
  readonly ended?: readonly string[]
  /**
   * Files attached to this message, in the order they were chosen — the gallery and file chips DSH draws on
   * a person's row. The metadata is what the server measured when it recorded the message, so the page never
   * re-derives a size or a media type from a path.
   */
  readonly attachments?: readonly TurnAttachment[]
  /** What the model said, or a tool call's arguments, or the reasoning text. */
  readonly text: string
  /** A closed tool's one-liner, kept as a field so the client never parses it back out. */
  readonly label?: string
  /** The tool's name, without the arrow the label carries. */
  readonly name?: string
  /** The call this result answers, which is what pairs the two halves. */
  readonly toolCallId?: string
  /** What the tool answered — on the same turn, which is what makes one element of it. */
  readonly result?: string
  /** DSH's phases, simplified: a call is running until its result says otherwise. */
  readonly state?: 'running' | 'ok' | 'error'
}

/**
 * The page a refused request gets: the token form, and why it appeared when there is a reason.
 *
 * Exported for the same reason: which of the two refusals a caller sees is a decision, and it is worth
 * judging without a browser.
 *
 * One helper for every refusal, so the recovery path cannot differ between them — the stale-token case
 * was a bare sentence while the unauthenticated case had a form, and there was no reason for the two to
 * differ other than that they were written apart.
 */
/**
 * What a request for the page is answered with.
 *
 * A pure decision, so the rule can be judged without a server: the page needs a session, and a refusal says
 * which of the two situations the caller is in. The first version of this route served the page to anyone —
 * measured, the bare URL returned `200` and a whole UI with an empty log, which reads as a broken page
 * rather than as an unopened one.
 */
export function pageAccess(decision: { readonly ok: boolean }, offered: { readonly cookie: boolean }): { readonly status: number; readonly stale: boolean } {
  if (decision.ok) return { status: 200, stale: false }
  return { status: 401, stale: offered.cookie }
}

export function tokenFormPage(options: { readonly stale?: boolean } = {}): string {
  /**
   * Two refusals, told apart on the page.
   *
   * "No token" and "the wrong token" are different situations and a person acts differently on each: the
   * first has never had one, the second had one that stopped working. The page says which it is, what the
   * token is, and how to read the current one — the alternative was a sentence that named neither, which
   * is what this used to be.
   */
  const reason =
    options.stale === true
      ? '<p><strong>That token is not the current one.</strong> A launch token is minted once per start, so a URL from an earlier run — a bookmark, the history, or an old log line — stops working when the server restarts.</p>'
      : '<p><strong>A launch token is required for this page.</strong> heddle prints one URL per start, with the token in it, and only that token opens this page.</p>'
  const how = `<p>Read the current one from the log, or paste it below:</p><pre>grep -o 'token=[A-Za-z0-9_-]*' ~/.heddle/web.log | tail -1</pre>`
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>heddle web</title>' +
    '<style>body{margin:0;padding:2rem;font:14px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:44rem;color-scheme:light dark}' +
    'h1{font-size:1.1rem;margin:0 0 1rem}pre{background:color-mix(in oklab,currentColor 8%,transparent);padding:.6rem .8rem;border-radius:.35rem;overflow-x:auto}' +
    'form{display:flex;gap:.5rem;margin-top:1rem}input{flex:1;padding:.5rem;font:inherit}button{padding:.5rem 1rem;font:inherit}</style>' +
    `</head><body><h1>heddle web</h1>${reason}${how}` +
    `<form method="get" action="/"><input name="${TOKEN_QUERY}" placeholder="token" autofocus><button>open</button></form>` +
    '</body></html>'
  )
}

/**
 * The page, read from the file beside this module.
 *
 * It was a template literal, and the type stripper parses the contents of one as code: an identifier-like
 * word in the markup or the CSS became a reference the compiler tried to resolve. Three separate failures
 * came from that in one edit — a `summary` element clashing with a helper's name, a bare `details` and
 * `summary` in the CSS, and an em dash reported as a module declaration. A file has none of that, needs no
 * escaping, and is what a reader can open directly.
 *
 * `build` copies it beside the compiled module, because a file the server reads at runtime is not one
 * `tsc` emits.
 */
/**
 * The page with its build marker filled in.
 *
 * The served document carries `data-page`-adjacent `meta[name=heddle-page]` set to the first 12 hex of the file's
 * sha256, computed rather than pasted: a served page that predates a rebuild can then be told apart from a page that
 * lacks the feature, which on screen look identical. (It happened: the live daemon served a stale deployment checkout
 * while the source and the checks were already correct, and a row's geometry read as "not implemented".)
 */
export function markedPage(html: string): string {
  const marker = createHash('sha256').update(html).digest('hex').slice(0, 12)
  return html.replace(/<meta name="heddle-page"[^>]*>/, `<meta name="heddle-page" content="${marker}">`)
}

/**
 * The page, read from the file beside this module.
 *
 * The served document carries `data-page="<first 12 hex of the file's sha256>"`, computed here rather than pasted
 * into the file: a served page that predates a rebuild can then be told apart from a page that lacks the feature,
 * which on screen look identical. (It happened: the live daemon served a stale deployment checkout while the source
 * and the checks were already correct, and a row's geometry read as "not implemented".)
 */
function page(): string {
  return markedPage(readFileSync(join(import.meta.dirname, 'page.html'), 'utf8'))
}

/** The addresses a person could reach this server on, for a LAN-aware message. */
export function localAddresses(): readonly string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)
}

export { COOKIE_MAX_AGE }
