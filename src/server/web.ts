import { readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import { runTurn } from '../agent/loop.ts'
import { renderSource } from './code.ts'
import { pickFolder } from './picker.ts'
import { projectLedger, projectRows, projectTimeline } from './ledger.ts'
import { catalogOf } from './tool-catalog.ts'
import { PREVIEW_CSP, rewriteResources } from './html.ts'
import { renderMarkdown } from './markdown.ts'
import { expandHome } from '../config/schema.ts'
import { describeEndpoints } from '../endpoints.ts'
import { canonicalPath } from '../paths.ts'
import { readSessionDefinition, updateSessionDefinition } from '../session/definition.ts'
import { readFileText, tree } from '../session/tree.ts'
import type { SessionEvent, SessionHandle } from '../session/store.ts'
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

export interface WebServerOptions {
  readonly host?: string
  readonly port?: number
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
  // Tracked so shutdown can reach a connection whose handler is still awaiting a turn.
  const sockets = new Set<import('node:net').Socket>()

  // Every append is pushed to whoever is listening, from the one write path.
  ctx.on('session/event', (payload) => {
    const line = `event: session\ndata: ${JSON.stringify(payload)}\n\n`
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
      running,
      controllers,
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
  /**
   * How many turns are running per session.
   *
   * A count rather than a flag because two turns on one session are possible, and a set would then clear the
   * mark for a session that is still running. It is what the steer route asks before it accepts a message:
   * DSH refuses a steer whose turn has ended, and this is the same question about the same fact.
   */
  readonly running: Map<string, number>
  /**
   * The abort handle of each running turn, per session.
   *
   * A stop and a steer ask about the same fact — is there a turn to act on — but a stop needs the handle
   * itself: the provider request is where a turn spends its time, and DSH's stop button ends the answer
   * rather than waiting for it. `runTurn` has taken a signal since it was written; nothing passed one until
   * the composer grew a Stop.
   */
  readonly controllers: Map<string, Set<AbortController>>
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
      respond(response, 400, 'text/plain', 'a path is required\n')
      return
    }
    if (workspaces === undefined || workspaces.owner(wanted) === undefined) {
      respond(response, 404, 'text/plain', 'no such asset\n')
      return
    }
    try {
      const stats = statSync(wanted)
      if (!stats.isFile()) {
        respond(response, 404, 'text/plain', 'no such asset\n')
        return
      }
      const contentType = inlineContentType(wanted)
      response.writeHead(200, {
        'content-type': contentType ?? 'application/octet-stream',
        'content-length': String(stats.size),
        /** `inline` only for a type a document embeds; anything else is offered as a download. */
        'content-disposition': contentType === null ? `attachment; filename="${basename(wanted).replace(/"/g, '')}"` : 'inline',
        'cache-control': 'no-store',
      })
      response.end(readFileSync(wanted))
    } catch {
      respond(response, 404, 'text/plain', 'no such asset\n')
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
    respond(response, 200, 'application/json', `${JSON.stringify(ctx.session.list(), null, 2)}\n`)
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
    respond(response, 200, 'application/json', `${JSON.stringify(described, null, 2)}\n`)
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
   * A session's goal: the durable objective, its phase, and the round it has reached.
   *
   * The GET is what the goal bar reads on every session change. The POST is the **person's** side of the
   * verbs, which is why it may do one thing the model's tool may not: resume a paused goal. A pause is a
   * person's decision, so only a person undoes it — the tool refuses and says the user must resume.
   *
   * Errors carry the goal service's own stable code next to the sentence, so a client can distinguish "the
   * goal moved while you were looking" (409) from "no goal is current" (404) without parsing prose.
   */
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
    const cwd = ctx.sandbox?.workspaceRoot ?? process.cwd()
    const endpoint = url.searchParams.get('endpoint')
    const report = context.assemble(handle, {
      cwd,
      tools: ctx.tools.describe(),
      ...(endpoint !== null && endpoint.length > 0 ? { endpoint } : {}),
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
            text: message.content
              .map((part) => (part.type === 'tool-call' ? `→ ${part.name} ${part.arguments}` : part.text))
              .join(''),
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
   * Register a folder as a workspace root, or unregister one.
   *
   * These are the two buttons the left column offers, and both go through the same record the CLI
   * writes: a folder is registered by path (the name defaults to the folder's own name), and a root
   * is unregistered by id. Registration is idempotent — registering an already-registered folder
   * reports `created: false` rather than failing — and registering a folder that was **adopted**
   * because a session ran in it promotes it into the tree, which is how ad-hoc work becomes a
   * project without moving anything.
   *
   * `DELETE` refuses when the root still holds sessions that no other root could adopt, and says so:
   * `bootstrap` re-registers any folder that has sessions and no owner, so removing such a root
   * would be undone on the next run. A refusal a person can read is better than a button that lies.
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
      const outcome = workspaces.remove(id, { all: ctx.session.list() })
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
   * nobody can find again.
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
    const meta = ctx.session.flags(id, {
      ...(pinned !== undefined ? { pinned } : {}),
      ...(archived !== undefined ? { archived } : {}),
    })
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
    const meta = ctx.session.setModel(id, { endpoint, ...(model !== undefined ? { model } : {}) })
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
      respond(
        response,
        200,
        'application/json',
        `${JSON.stringify({ id, ledger, rows: projectRows(ledger), timeline: projectTimeline(ledger), tools: catalogOf(ctx.tools.describe()) }, null, 2)}\n`,
      )
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
           * The name the session is read under, and the folder it belongs to — the two things DSH prints above a
           * conversation's tabs. The page had them only in the sidebar, so a reader had to look away to know which
           * session was open.
           */
          title: meta?.title ?? null,
          cwd: meta?.cwd ?? null,
          /**
           * An answer travels as the document it is, not only as its source.
           *
           * DSH renders an assistant row's markdown once the row is **settled**, and this is the same decision
           * made on the server: the transcript is read once, so rendering here costs one pass and the page
           * never has to ask per turn. The live path (a turn that just ended) asks `/api/markdown` for the one
           * answer it has, and both go through `renderMarkdown`, so there is one renderer and one allow-list.
           */
          turns: transcriptTurns(events).map((turn) =>
            turn.kind === 'assistant' ? { ...turn, html: renderMarkdown(turn.text) } : turn,
          ),
        },
        null,
        2,
      )}\n`,
    )
    return
  }

  if (url.pathname === '/api/events' && request.method === 'GET') {
    respondSse(response)
    state.subscribers.add(response)
    request.on('close', () => state.subscribers.delete(response))
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
    ctx.session.user(handle, prompt)
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
   * The access chip names the sandbox mode the server actually runs under: `read-only`, `workspace-write` or
   * `danger-full-access`. It is read, not chosen, because the mode is fixed when the sandbox is constructed —
   * the chip's job is to stop a person assuming they have write access they do not have.
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

/** Run one turn and stream its session events back as they are written. */async function handleTurn(ctx: Context, request: IncomingMessage, response: ServerResponse, state: RequestState): Promise<void> {
  let raw = ''
  for await (const chunk of request) {
    raw += chunk
    if (raw.length > 10 * 1024 * 1024) {
      respond(response, 413, 'text/plain', 'request too large\n')
      return
    }
  }
  let body: { session?: string; prompt?: string; endpoint?: string; model?: string; folder?: string; new?: boolean }
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
  const born = { ...(requested !== undefined ? { endpoint: requested } : {}), ...(model !== undefined ? { model } : {}) }
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
   * The session records how it is run.
   *
   * A session created by this request is born with the choice, so this writes only when the record and the
   * turn disagree — a resumed session this request pointed elsewhere, or one started before the record
   * existed. Writing only on a difference is what keeps an ordinary turn from rewriting a metadata file on
   * every message, which is also the reason the comparison includes the model.
   */
  if (record?.endpoint !== endpoint || record?.model !== model) {
    ctx.session.setModel(handle.id, { endpoint, ...(model !== undefined ? { model } : {}) })
  }

  /**
   * The session is marked running **before** the stream opens, and unmarked in the `finally` below.
   *
   * That mark is the whole of "is there a turn to steer into": DSH refuses a steer whose turn has ended, and
   * this route asks the same question about the same fact. It is a count because two turns on one session are
   * possible, and a set would clear the mark for a session that is still running.
   */
  state.running.set(handle.id, (state.running.get(handle.id) ?? 0) + 1)
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
      signal: controller.signal,
      ...(model !== undefined ? { model } : {}),
    })
    safeWrite(
      `event: done\ndata: ${JSON.stringify({
        session: handle.id,
        text: result.text,
        finishReason: result.finishReason,
        rounds: result.rounds,
        denials: result.denials,
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
      safeWrite(`event: error\ndata: ${JSON.stringify({ message: (error as Error).message })}\n\n`)
    }
  } finally {
    handles.delete(controller)
    if (handles.size === 0) state.controllers.delete(handle.id)
    unsubscribe()
    const left = (state.running.get(handle.id) ?? 1) - 1
    if (left > 0) state.running.set(handle.id, left)
    else state.running.delete(handle.id)
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
  response.write(': heddle stream open\n\n')
}

/**
 * The type a document may embed inline, or `null` for anything a browser should not run in this origin.
 *
 * A deny-by-default map rather than a lookup of everything known: the list is the types an `<img>`, an `@font-face`
 * or a `<video>` needs, and a file outside it is still served — as a download, so a person can have it without the
 * page executing it.
 */
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

function respond(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' })
  response.end(body)
}

/** The page. One file, no build step, and no framework — the same choice DSH makes. */
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
  const closeRuns = (): void => {
    openAssistant = -1
    openReasoning = -1
  }
  /** Append to the open run when there is one, and otherwise open a new turn for it. */
  const append = (kind: 'assistant' | 'reasoning', text: string, index: number): number => {
    const turn = index >= 0 ? turns[index] : undefined
    if (turn !== undefined) {
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
        | { role?: string; content?: readonly { type?: string; text?: string }[]; toolCallId?: string }
        | undefined
      if (message === undefined) continue
      const text = (message.content ?? []).map((part) => part.text ?? '').join('')
      if (message.role === 'user') turns.push({ kind: 'user', text })
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
  return turns
}

/** One thing the chat shows, after the fold. A tool turn carries both halves of one call. */
export interface ChatTurn {
  readonly kind: 'user' | 'assistant' | 'reasoning' | 'tool'
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
function page(): string {
  return readFileSync(join(import.meta.dirname, 'page.html'), 'utf8')
}

/** The addresses a person could reach this server on, for a LAN-aware message. */
export function localAddresses(): readonly string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)
}

export { COOKIE_MAX_AGE }
