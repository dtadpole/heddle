#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApp } from './app.ts'
import { boot, failedEntries, settle } from './boot.ts'
import { runTurn } from './agent/loop.ts'
import { finalAssistantText, type SubagentService } from './agent/subagent.ts'
import { describeEndpoint } from './endpoints.ts'
import { describeContent } from './llm/types.ts'
import { canonicalPath } from './paths.ts'
import { defaultSessionRoot } from './session/store.ts'
import { readFileText, tree, type TreeNode } from './session/tree.ts'
import type { WorkspaceService } from './workspace/service.ts'
import { printStream } from './stream/printer.ts'
import { declaredModuleNames } from './config/plugin-inventory.ts'
import { resetProfileFromTemplate } from './config/profile-template.ts'
import { ConfigError, heddleHome, profilesDir } from './config/schema.ts'

/**
 * `FiberState` is a `const enum`, so it has no runtime object to read names from.
 * The numbers are the declaration order in cordis `src/fiber.ts`.
 */
const STATES = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'] as const

interface Args {
  punctuation?: string
  target?: string
  quiet: boolean
  help: boolean
  config?: string
  profile?: string
  /** `--from-default-profile <template>`: replace the `--profile` with a fresh copy of a shipped template first. */
  fromDefaultProfile?: string
  patch: string[]
  turn?: string
  resume?: string
  endpoint?: string
  model?: string
  system?: string
  maxRounds?: number
  maxOutputTokens?: number
  sessionRoot?: string
  sandboxRoot?: string
  dryRun: boolean
  port?: number
  host?: string
  workspace?: string
  stream: boolean
  validate: boolean
  origins: boolean
  list: boolean
  json: boolean
  /** Start a new session in the folder rather than continuing the one it already has. */
  fresh: boolean
  /** Folder names a tool writes, so the tree names them instead of calling them content. */
  generated: string[]
  /** The word after a two-part command, such as `add` in `workspace add`. */
  subcommand?: string
  /** Do the thing even though the command warned it would be undone (`workspace remove --force`). */
  force?: boolean
  /** An optional workspace name, given to `workspace add`. */
  name?: string
  command?: string
}

const USAGE = `heddle — a harness and agent framework built on Cordis

usage: heddle [options] [command]

options:
  -c, --config <path>        boot from this configuration layer instead of the default profile
      --profile <name>       boot a named profile from $HEDDLE_HOME/profiles
      --from-default-profile <template>
                             replace that profile with a fresh copy of a shipped template (default), then boot it
      --patch <path>         apply an extra layer after it (repeatable)
      --dry-run              report what a run would do and stop before doing it
      --sandbox-root <path>  confine file effects to this directory instead of the working one
      --turn <text>          run one agent turn and print the answer
      --resume <id>          continue an existing session rather than starting one
      --new                  start a new session in this folder instead of continuing its own
      --generated <name>     a folder a tool writes, so the tree names it as generated (repeatable)
      --endpoint <name>      which configured endpoint answers (default: the configured default, else the first by name)
      --model <id>           override the endpoint's model for this turn
      --system <text>        system prompt, recorded when the session is new
      --max-rounds <n>       stop after n model-plus-tools rounds (one-shot default 8; web: uncapped)
      --max-output-tokens <n>  cap the tokens one model call may generate
      --stream               print reasoning and content deltas to stderr as they arrive
      --list                 list what is registered, then stop
      --json                 print machine-readable output
  -p, --punctuation <mark>   punctuation the greeting service appends (default !)
  -t, --target <name>        who the run is for (default heddle)
  -q, --quiet                do not attach the console exporter
  -h, --help                 show this message

commands:
  models                     list the configured endpoints, without calling any
  tools                      list the registered tools
  commands                   list the registered commands
  sessions                   list the sessions this store holds
  workspaces                 list the workspaces and their sessions
  workspace add <path> [name]  register a target folder as a workspace root
  session new [<branch>]     start a session at a branch and write its definition there
  workspace rename <id|path> <name>  retitle a root, leaving its path alone
  workspace remove <id|path>   unregister a root, reporting where its sessions went
  tree [<path>]              print one level of the folder tree the left column shows
  file <path>                print a text file under a workspace root, as the right panel shows it
  context                    show the assembled context for a session, without calling a model
  goal [<session-id>]        show the goal a session is working toward
  hooks                      list the hook points this build emits
  web                        serve the Web UI on localhost
  transcript <id>            print a session's transcript
  profiles                   list the profiles this machine holds
  config                     print the composed tree, or validate it with --validate
      --validate             with the config command, check every row without starting it
      --origins              with the config command, show which layer supplied each field

Endpoint configuration lives outside the repository, in $HEDDLE_CONFIG,
$HEDDLE_HOME/heddle.json or ~/.heddle/heddle.json. Nothing here carries a URL or a
credential of its own.
`

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { quiet: false, help: false, patch: [], list: false, json: false, stream: false, validate: false, origins: false, dryRun: false, fresh: false, generated: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    const next = () => argv[++index]
    switch (arg) {
      case '-p':
      case '--punctuation':
        args.punctuation = next()
        break
      case '-t':
      case '--target':
        args.target = next()
        break
      case '-c':
      case '--config':
        args.config = next()
        break
      case '--profile': {
        /**
         * A profile argument is a **name** or a **directory**, and the two are told apart by the
         * argument itself rather than by the working directory.
         *
         * Measured, both ways round: leaving it relative made a fixture profile resolve as the
         * repository's working directory (`/Users/zhenc/heddle/dev`) and fail; resolving it
         * unconditionally made `--profile dev` look for a directory called `dev` instead of the
         * profile named `dev`. A path is recognised by starting with `.`, `/` or `~`.
         */
        const value = next() ?? ''
        const looksLikePath = value.startsWith('.') || value.startsWith('/') || value.startsWith('~')
        args.profile = looksLikePath ? resolve(value) : value
        break
      }
      case '--from-default-profile':
        args.fromDefaultProfile = next() ?? ''
        break
      case '--patch':
        args.patch.push(next() ?? '')
        break
      case '--turn':
        args.turn = next()
        break
      case '--force':
        args.force = true
        break
      case '--resume':
        args.resume = next()
        break
      case '--new':
        args.fresh = true
        break
      case '--generated':
        args.generated.push(next() ?? '')
        break
      case '--endpoint':
        args.endpoint = next()
        break
      case '--model':
        args.model = next()
        break
      case '--system':
        args.system = next()
        break
      case '--max-rounds':
        args.maxRounds = Number(next())
        break
      case '--max-output-tokens':
        args.maxOutputTokens = Number(next())
        break
      case '--session-root':
        args.sessionRoot = next()
        break
      case '--sandbox-root':
        args.sandboxRoot = next()
        break
      case '--port':
        args.port = Number(next())
        break
      case '--host':
        args.host = next()
        break
      case '--stream':
        args.stream = true
        break
      case '--dry-run':
        args.dryRun = true
        break
      case '--validate':
        args.validate = true
        break
      case '--origins':
        args.origins = true
        break
      case '--list':
        args.list = true
        break
      case '--json':
        args.json = true
        break
      case '-q':
      case '--quiet':
        args.quiet = true
        break
      case '-h':
      case '--help':
        args.help = true
        break
      case 'goal': {
        /**
         * A session id is optional, exactly as for `transcript` and `context`: asking about *the* session
         * means the one in the current folder, which is what a person in a folder is looking at.
         */
        args.command = 'goal'
        const candidate = argv[index + 1]
        if (candidate !== undefined && !candidate.startsWith('-')) args.target = next()
        break
      }
      case 'models':
      case 'tools':
      case 'commands':
      case 'sessions':
      case 'transcript':
      case 'web':
      case 'workspaces':
      case 'context':
      case 'hooks':
      case 'profiles':
      case 'config':
        args.command = arg
        /**
         * `transcript` and `context` take one positional session id.
         *
         * Consuming the next token for every command is what made `heddle web --port 3099` fail with
         * "unknown argument: 3099": the command ate the flag that followed it. Measured while first
         * wiring the Web UI, and the reason this is a list rather than a rule. `context` joins it
         * because asking what a session would send is a question about *that* session.
         */
        if (arg === 'transcript' || arg === 'context') args.target = next() ?? undefined
        break
      case 'workspace': {
        /**
         * `workspace add <path>` is two words, and the subcommand is checked rather than assumed.
         *
         * A one-word `workspace` that silently did nothing would be the worst of both: a person types
         * `heddle workspace ~/x`, sees no complaint, and believes the folder is registered.
         */
        args.command = 'workspace'
        const subcommand = next() ?? ''
        if (subcommand !== 'add' && subcommand !== 'list' && subcommand !== 'remove' && subcommand !== 'rename') {
          throw new Error(
            `unknown workspace subcommand '${subcommand}'; try 'heddle workspace add <path> [name]', 'heddle workspace rename <id|path> <name>', 'heddle workspace remove <id|path>' or 'heddle workspace list'`,
          )
        }
        args.subcommand = subcommand
        if (subcommand === 'add') {
          const path = next()
          if (path === undefined || path.startsWith('-')) throw new Error('workspace add needs a path')
          args.target = path
          /**
           * An optional name, taken only when it is not a flag.
           *
           * Same trap as `web --port` and `tree --json`: reading the next token unconditionally would
           * make `heddle workspace add ~/x --json` register a workspace called `--json`.
           */
          const candidate = argv[index + 1]
          if (candidate !== undefined && !candidate.startsWith('-')) args.name = next() ?? undefined
        }
        if (subcommand === 'remove') {
          const id = next()
          if (id === undefined || id.startsWith('-')) throw new Error('workspace remove needs a workspace id or path')
          args.target = id
        }
        if (subcommand === 'rename') {
          const id = next()
          if (id === undefined || id.startsWith('-')) throw new Error('workspace rename needs a workspace id or path')
          args.target = id
          const name = next()
          if (name === undefined || name.startsWith('-')) throw new Error('workspace rename needs a name')
          args.name = name
        }
        break
      }
      case 'tree': {
        /**
         * `tree [<path>]`, and the path is optional because asking for no path asks for the roots.
         *
         * The next token is taken only when it is not a flag: `heddle tree --json` must not read
         * `--json` as a folder, which is the same trap the comment above records for `web --port`.
         */
        args.command = 'tree'
        const candidate = argv[index + 1]
        if (candidate !== undefined && !candidate.startsWith('-')) args.target = next()
        break
      }
      case 'session': {
        /**
         * `session new [<branch>]` — the one session verb that writes, and the branch is optional because
         * asking for no branch means the folder the command runs in.
         */
        args.command = 'session'
        const subcommand = next() ?? ''
        if (subcommand !== 'new') {
          throw new Error(`unknown session subcommand '${subcommand}'; try 'heddle session new [<branch>]'`)
        }
        args.subcommand = subcommand
        const candidate = argv[index + 1]
        if (candidate !== undefined && !candidate.startsWith('-')) args.target = next()
        break
      }
      case 'file': {
        /** `file <path>` — one path, and only when it is not a flag, for the same reason as `tree`. */
        args.command = 'file'
        const candidate = argv[index + 1]
        if (candidate === undefined || candidate.startsWith('-')) throw new Error('file needs a path')
        args.target = next()
        break
      }
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

interface LoaderLike {
  locate(fiber: never): string | undefined
  resolve(id: string): { options?: { id?: string } } | undefined
}

interface RegistryView {
  readonly registry: Map<unknown, { name?: string; fibers: Set<{ state: number }> }>
}

/**
 * Machinery a profile always loads, so it is not counted as a configured plugin.
 *
 * Named here rather than filtered by name in the check, because the check's claim
 * is "the tree is what the file declares": a run whose count included these two
 * would report the same number for two different files, which is exactly the
 * false pass the count exists to prevent. Measured while writing the first
 * version of this command.
 */
const REGISTRY_INFRASTRUCTURE = new Set(['Loader', 'isolate'])

/**
 * What to call a loaded plugin.
 *
 * The **configured id** when the loader owns the plugin, because that is the name
 * a reader of the configuration file used and therefore the name a check can
 * assert on. Falling back to the runtime name, then the package's `name` export,
 * covers a plugin loaded in code rather than from a layer.
 */
function labelOf(entry: [unknown, { name?: string; fibers: Set<object> }], loader?: LoaderLike): string {
  const [callback, runtime] = entry
  const fiber = [...runtime.fibers][0]
  const owned = fiber && loader ? loader.locate(fiber as never) : undefined
  if (owned) {
    const resolved = loader?.resolve(owned)
    if (resolved?.options?.id) return resolved.options.id
  }
  return runtime.name ?? (callback as { name?: string }).name ?? '(anonymous)'
}

function pluginEntries(ctx: RegistryView): [unknown, { name?: string; fibers: Set<{ state: number }> }][] {
  return [...ctx.registry.entries()].filter(
    ([callback, runtime]) => !REGISTRY_INFRASTRUCTURE.has(runtime.name ?? (callback as { name?: string }).name ?? ''),
  )
}

function printTree(ctx: RegistryView & { loader?: LoaderLike }): void {
  const entries = pluginEntries(ctx)
  process.stdout.write(`heddle: ${entries.length} plugin(s) loaded\n`)
  for (const entry of entries) {
    const [, runtime] = entry
    const fibers = [...runtime.fibers]
    const states = fibers.map((fiber) => STATES[fiber.state] ?? `unknown(${fiber.state})`).join(', ')
    process.stdout.write(`  ${labelOf(entry, ctx.loader).padEnd(16)} ${fibers.length} fiber(s)  ${states}\n`)
  }
}

/** One level of the tree, printed the way the left column draws it: kind, name, badge, session. */
function describeTree(node: TreeNode): string[] {
  const lines = [`heddle: ${node.children?.length ?? 0} node(s) under ${node.path === '' ? 'the workspace level' : node.path}`]
  const walk = (current: TreeNode, depth: number): void => {
    const badge = current.badge === null ? '' : ` [${current.badge}]`
    const session = current.session === null ? '' : `  session ${current.session.id} (${current.session.turns} turn(s))`
    lines.push(`  ${'  '.repeat(depth)}${current.kind.padEnd(9)} ${current.label}${badge}${session}`)
    for (const child of current.children ?? []) walk(child, depth + 1)
  }
  walk(node, 0)
  return lines
}

/** The base layer a run uses: the flag if given, else the profile beside the project. */function baseLayer(args: Args): { readonly base?: string; readonly patches: readonly string[]; readonly includeProjectPatch: boolean } {
  /**
   * A named profile **excludes** the project's own base layer.
   *
   * Measured: `heddle --profile X tools` booted the repository's `cordis.yml` instead, because
   * this function offered a base whenever one sat in the working directory and `boot` prefers a
   * profile only when no base is given. The profile looked applied — two endpoints loaded — and
   * was not. Asking for a profile is asking for exactly that tree.
   */
  if (args.profile !== undefined) return { patches: args.patch, includeProjectPatch: false }
  const defaultBase = resolve(process.cwd(), 'cordis.yml')
  if (args.config !== undefined) return { base: args.config, patches: args.patch, includeProjectPatch: args.patch.length === 0 }
  if (existsSync(defaultBase)) return { base: defaultBase, patches: args.patch, includeProjectPatch: args.patch.length === 0 }
  return { patches: args.patch, includeProjectPatch: false }
}

/**
 * Boot from the default profile or from the flags.
 *
 * `machineOutput` is a one-shot run whose stdout is `--json`'s document. Its plugins, and a turn it runs, log errors
 * only: the console exporter writes `info` to stdout, and measured on 2026-10-29 `heddle goal <session> --json`
 * printed `model: 1 endpoint(s) — …`, `tools: 4 registered, …` and `team: durable team service ready` ahead of the
 * JSON — and a `--turn` added `turn: wrote …` for a `write_file` call — so stdout did not parse. The Rust binary
 * prints those lines on neither stream, so this matches it; an error a row logs still reaches stderr. `web` does
 * not ask for it — its `--json` line follows human lines, and its log is a server's — and a run without `--json`
 * prints exactly what it did.
 */
async function bootFromArgs(args: Args, options: { readonly machineOutput?: boolean } = {}) {
  return boot({ ...bootOptions(args), ...(options.machineOutput === true ? { logLevel: 0 } : {}) })
}

/** The layers and overrides a command line boots, which the settings surface must judge writes against. */
function bootOptions(args: Args) {
  const layers = baseLayer(args)
  return {
    configDir: process.cwd(),
    ...(args.profile !== undefined ? { profile: args.profile } : {}),
    ...(layers.base !== undefined ? { base: layers.base } : {}),
    patches: [...layers.patches],
    includeProjectPatch: layers.includeProjectPatch,
    // Restates the session row rather than reaching past the configuration: the
    // override is a layer, which is how every other override in this project works.
    /**
     * Both overrides restate a row rather than reaching past the configuration, because that is how
     * every other override in this project works — and the sandbox root matters for a check: measured,
     * a fixture that ran the built CLI with the repository as its working directory let a relative
     * `write_file` land in the repository, and two of those files were committed before anyone noticed.
     */
    ...(args.sessionRoot !== undefined || args.sandboxRoot !== undefined
      ? {
          overrides: [
            {
              patch: [
                ...(args.sessionRoot !== undefined ? [{ id: 'session', config: { root: resolve(args.sessionRoot) } }] : []),
                ...(args.sandboxRoot !== undefined ? [{ id: 'sandbox', config: { workspaceRoot: resolve(args.sandboxRoot) } }] : []),
              ],
            },
          ],
        }
      : {}),
  }
}

function hasProfile(args: Args): boolean {
  return (
    args.profile !== undefined ||
    args.config !== undefined ||
    args.patch.length > 0 ||
    existsSync(resolve(process.cwd(), 'cordis.yml'))
  )
}

/**
 * The commands that answer without running a model.
 *
 * They exist before the turn does on purpose: `models` and `tools` are how a
 * person checks a configuration without spending anything, and a harness whose
 * first usable command costs money is one nobody configures carefully.
 */
async function runWeb(args: Args): Promise<void> {
  const { startWebServer, DEFAULT_PORT } = await import('./server/web.ts')
  const app = await bootFromArgs(args)
  try {
    const pending = await settle(app.ctx)
    if (pending.length > 0) throw new Error(`${pending.length} entr(y/ies) are still pending: ${pending.join(', ')}`)
    /**
     * `--dry-run` reports the plan and stops before the socket.
     *
     * It exists for two callers. A person checks that a daemon's arguments will work without taking the
     * port away from the daemon that is already serving it; a check judges which port the server chooses
     * without binding it. Measured: a check that bound the documented port failed with `EADDRINUSE` once a
     * real agent held it, which was correct behaviour and the wrong claim to assert from there.
     */
    if (args.dryRun) {
      const chosen = args.port ?? DEFAULT_PORT
      const url = `http://${args.host ?? '127.0.0.1'}:${chosen}/?token=generated-at-start`
      process.stdout.write(`heddle web: would serve ${url}\n`)
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ url, host: args.host ?? '127.0.0.1', port: chosen, dryRun: true })}\n`)
      }
      return
    }

    const { settingsServiceFor } = await import('./config/settings.ts')
    const server = await startWebServer(app.ctx, {
      /**
       * A settings write applies to the running tree as it lands, as DSH's settings do: the loader re-applies the
       * entry with its newly composed config (committing a volatile value in place, remounting otherwise).
       */
      settings: settingsServiceFor(bootOptions(args), process.env, (ns, config) => app.ctx.loader.update(ns, { config: config as never })),
      browser: process.env['HEDDLE_WEB_BROWSER'] === '1',
      ...(args.port !== undefined ? { port: args.port } : { port: DEFAULT_PORT }),
      ...(args.host !== undefined ? { host: args.host } : {}),
      ...(args.maxRounds !== undefined ? { maxRounds: args.maxRounds } : {}),
      // The endpoint the flag named becomes the server's default, so a turn posted without one
      // is answered by the endpoint the operator chose rather than by whichever is first.
      ...(args.endpoint !== undefined ? { defaultEndpoint: args.endpoint } : {}),
      // The plugin inventory reports each row's module name as the layer wrote it, not as `boot` resolved it.
      pluginModuleNames: declaredModuleNames(app),
    })
    /**
     * The sessions the startup sweeps read: every listed one whose log reads whole. A log that does not is named once
     * and left out (`SessionStore.loads`), because these sweeps run after the listener is up and before the login line:
     * one throw here used to unwind this function into `app.dispose()`, leaving a listener with every plugin gone and
     * no link printed (#130).
     */
    const sweepHandles = () =>
      app.ctx.session
        .list()
        .map((meta) => app.ctx.session.store.open(meta.id))
        .filter((handle): handle is NonNullable<typeof handle> => handle !== null && app.ctx.session.store.loads(handle))
    /**
     * A restarted harness picks up the goals it finds still active.
     *
     * Only the **server** does this: a one-shot command (`heddle tree`, `--turn`) must not start model calls
     * for sessions it is not working on, which is why this is an explicit call here rather than a boot sweep
     * inside the plugin. No new event is invented — the goal's durable phase is the condition, and this is
     * the startup edge that asks it.
     */
    if (app.ctx.goalDriver !== undefined) {
      const handles = sweepHandles()
      const resumed = await app.ctx.goalDriver.resumeAtStart(handles)
      if (resumed.requested > 0) process.stdout.write(`heddle web: resuming ${resumed.requested} active goal(s)\n`)
    }
    /**
     * The same startup edge for teams: settle members a previous process left provisioning and offer every
     * undelivered message to its target again. Only the server does this — a one-shot command must not start
     * turns for teams it is not working on.
     */
    if (app.ctx.team !== undefined) {
      const handles = sweepHandles()
      const recovered = await app.ctx.team.recoverAll(handles)
      if (recovered.recovered > 0 || recovered.failed > 0) {
        process.stdout.write(`heddle web: recovered ${recovered.recovered} team(s) (${recovered.settled} settled, ${recovered.delivered} delivered${recovered.failed > 0 ? `, ${recovered.failed} failed` : ''})\n`)
      }
    }
    /** Reminders that came due are delivered by the server only, after the sweeps above (DSH's dsh-schedule). */
    if (app.ctx.get('schedule') !== undefined) app.ctx.schedule.startDelivery()
    process.stdout.write(`heddle web: ${server.url}\n`)
    process.stdout.write(`heddle web: serving on ${server.host}:${server.port}; pass --port to change it\n`)
    if (args.json) process.stdout.write(`${JSON.stringify({ url: server.url, host: server.host, port: server.port, token: server.token })}\n`)
    // Run until interrupted, which is the only honest lifetime for a server.
    await new Promise<void>((resolvePromise) => {
      const stop = () => {
        void server.close().then(resolvePromise)
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
  } finally {
    await app.dispose()
  }
}

/**
 * Commands that answer from the configuration alone, without starting anything.
 *
 * `profiles`, `config` and `config --validate` must not boot: the question they answer is
 * what the tree *is*, and a command that started every plugin to describe them could not
 * be run on a tree that is broken — which is exactly when it is needed.
 */
async function runConfigCommand(command: string, args: Args): Promise<boolean> {
  const { compose, defaultLayers, listProfiles, originOf } = await import('./config/schema.ts')
  // The same defaulting the boot path uses, so `heddle config` describes the tree a bare
  // `heddle --turn` would run rather than an empty one. Measured: the first version had no
  // default here and reported "0 configured row(s)", which was true and useless.
  const projectBase = resolve(process.cwd(), 'cordis.yml')
  const named = args.profile !== undefined || args.config !== undefined || args.patch.length > 0
  const layers = defaultLayers({
    ...(args.profile !== undefined ? { profile: args.profile } : {}),
    ...(args.config !== undefined
      ? { base: args.config }
      : args.profile === undefined && existsSync(projectBase)
        ? { base: projectBase }
        : {}),
    patches: args.patch,
    includeProjectPatch: !named && args.profile === undefined,
    configDir: process.cwd(),
  })

  if (command === 'profiles') {
    const profiles = listProfiles()
    if (args.json) process.stdout.write(`${JSON.stringify(profiles, null, 2)}\n`)
    else {
      process.stdout.write(`heddle: ${profiles.length} profile(s) under ${join(heddleHome(), 'profiles')}\n`)
      for (const profile of profiles) process.stdout.write(`  ${profile.name.padEnd(18)} ${profile.layers.join(', ') || '(no layers)'}\n`)
    }
    return true
  }

  if (command === 'config' && args.validate) {
    const { validateRows } = await import('./config/validate.ts')
    const result = await validateRows(layers)
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    else {
      process.stdout.write(`heddle: ${result.rows} row(s) checked, ${result.problems.length} problem(s)\n`)
      for (const problem of result.problems) process.stdout.write(`  ${problem}\n`)
    }
    if (result.problems.length > 0) process.exitCode = 1
    return true
  }

  if (command === 'config') {
    let rows
    try {
      rows = compose(layers)
    } catch (error) {
      process.stderr.write(`heddle: ${(error as Error).message}\n`)
      process.exitCode = 1
      return true
    }
    if (args.json) {
      process.stdout.write(`${JSON.stringify(rows.map((entry) => ({ ...entry.row, position: entry.position, origins: entry.fields })), null, 2)}\n`)
      return true
    }
    process.stdout.write(`heddle: ${rows.length} configured row(s) from ${layers.map((layer) => layer.layer).join(' -> ')}\n`)
    for (const entry of rows) {
      const flags = [entry.row.disabled === true ? 'disabled' : '', entry.row.inject !== undefined ? `inject ${(entry.row.inject ?? []).join(',')}` : '']
        .filter((part) => part.length > 0)
        .join('  ')
      process.stdout.write(`  ${String(entry.row.id ?? '-').padEnd(16)} ${entry.row.name}${flags.length > 0 ? `  ${flags}` : ''}\n`)
      if (args.origins) {
        for (const origin of entry.fields) {
          process.stdout.write(`      ${origin.field.padEnd(28)} ${origin.layer}\n`)
        }
      }
    }
    if (!args.origins) {
      process.stdout.write('heddle: pass --origins to see which layer supplied each field\n')
    }
    return true
  }
  return false
}

/**
 * Apply the configured allow list once the tree has loaded.
 *
 * One helper because there are two entry points — the one-shot commands and a turn — and a filter
 * applied on only one of them is how `heddle tools` listed four tools from a profile that allowed one.
 * Measured, in exactly that way.
 */
function applyToolAllowList(ctx: { tools?: { filterTo?: (allow: readonly string[]) => void; allowList?: () => readonly string[] } }): void {
  ctx.tools?.filterTo?.(ctx.tools.allowList?.() ?? [])
}

async function runCommand(command: string, target: string | undefined, json: boolean, args: Args): Promise<boolean> {
  const app = await bootFromArgs(args, { machineOutput: json })
  try {
    await settle(app.ctx)
    /**
     * A row that failed to load is reported here too.
     *
     * Measured: a fixture plugin's registration was refused, the row failed, and `heddle tools`
     * printed four healthy tools and exited `0` — the same silence as before, on the path a person
     * would use to diagnose it. The one-shot commands are where a broken tree is looked for, so this
     * is where it has to be reported.
     */
    const failed = failedEntries(app.ctx)
    if (failed.length > 0) {
      process.stderr.write(`heddle: ${failed.length} row(s) failed to load: ${failed.map((entry) => entry.id).join(', ')}\n`)
      process.exitCode = 1
      return true
    }
    applyToolAllowList(app.ctx)
    if (command === 'models') {
      const endpoints = app.ctx.model.list().map(describeEndpoint)
      if (json) process.stdout.write(`${JSON.stringify(endpoints, null, 2)}\n`)
      else {
        process.stdout.write(`heddle: ${endpoints.length} endpoint(s)\n`)
        for (const endpoint of endpoints) {
          const credential = endpoint.credential ?? endpoint.credentialFile ? ' credential' : ''
          process.stdout.write(
            `  ${String(endpoint.name).padEnd(18)} ${String(endpoint.kind).padEnd(16)} ${String(endpoint.model ?? '-')}${credential}\n`,
          )
        }
      }
      return true
    }
    if (command === 'tools') {
      const tools = app.ctx.tools.describe().map((tool) => ({ name: tool.name, description: tool.description }))
      if (json) process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`)
      else {
        process.stdout.write(`heddle: ${tools.length} tool(s)\n`)
        for (const tool of tools) process.stdout.write(`  ${tool.name.padEnd(14)} ${tool.description.split('.')[0]}\n`)
      }
      return true
    }
    if (command === 'commands') {
      const commands = app.ctx.tools.describeCommands()
      if (json) process.stdout.write(`${JSON.stringify(commands, null, 2)}\n`)
      else {
        process.stdout.write(`heddle: ${commands.length} command(s)\n`)
        for (const entry of commands) process.stdout.write(`  ${entry.name.padEnd(14)} — ${entry.description}\n`)
      }
      return true
    }
    if (command === 'sessions') {
      const sessions = app.ctx.session.list()
      if (json) process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`)
      else {
        process.stdout.write(`heddle: ${sessions.length} session(s) in ${app.ctx.session.store.root}\n`)
        for (const meta of sessions.slice(0, 20)) {
          process.stdout.write(`  ${meta.id}  ${meta.created}  turns=${meta.turns}  ${meta.title ?? ''}\n`)
        }
      }
      return true
    }
    if (command === 'transcript') {
      if (target === undefined) throw new Error('transcript needs a session id')
      const handle = app.ctx.session.start({ resume: target })
      for (const event of app.ctx.session.events(handle)) process.stdout.write(`${JSON.stringify(event)}\n`)
      return true
    }
    if (command === 'workspaces' || (command === 'workspace' && args.subcommand === 'list')) {
      const workspaces = requireWorkspace(app.ctx)
      const records = workspaces.list()
      const all = app.ctx.session.list()
      if (json) {
        process.stdout.write(
          `${JSON.stringify(
            records.map((record) => ({ ...record, sessions: workspaces.sessions(record, all).map((meta) => meta.id) })),
            null,
            2,
          )}\n`,
        )
      } else {
        process.stdout.write(`heddle: ${records.length} workspace(s) in ${workspaces.file}\n`)
        for (const record of records) {
          const sessions = workspaces.sessions(record, all)
          process.stdout.write(`  ${record.title}  ${record.path}  ${sessions.length} session(s)\n`)
          for (const meta of sessions.slice(0, 5)) process.stdout.write(`    ${meta.id}  turns=${meta.turns}\n`)
        }
      }
      return true
    }
    if (command === 'workspace' && args.subcommand === 'remove') {
      if (target === undefined) throw new Error('workspace remove needs a workspace id or path')
      const outcome = requireWorkspace(app.ctx).remove(target, {
        all: app.ctx.session.list(),
        ...(args.force === true ? { force: true } : {}),
      })
      if (json) process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`)
      else {
        process.stdout.write(`heddle: removed ${outcome.removed.title}  ${outcome.removed.path}\n`)
        if (outcome.adoptedBy !== undefined) process.stdout.write(`  ${outcome.ownedSessions} session(s) adopted by ${outcome.adoptedBy}\n`)
      }
      return true
    }
    if (command === 'workspace') {
      if (target === undefined) throw new Error('workspace add needs a path')
      const workspaces = requireWorkspace(app.ctx)
      if (args.subcommand === 'rename') {
        const renamed = workspaces.rename(target, args.name ?? '')
        if (renamed === undefined) throw new Error(`no workspace '${target}'`)
        if (json) process.stdout.write(`${JSON.stringify(renamed, null, 2)}\n`)
        else process.stdout.write(`heddle: renamed to ${renamed.title}  ${renamed.path}\n`)
        return true
      }
      const { record, created } = workspaces.add(target, args.name)
      if (json) process.stdout.write(`${JSON.stringify({ ...record, created }, null, 2)}\n`)
      else process.stdout.write(`heddle: ${created ? 'registered' : 'already registered'} ${record.title}  ${record.path}\n`)
      return true
    }
    if (command === 'tree') {
      const wanted = target !== undefined && target.length > 0 ? canonicalPath(target) : null
      /**
       * A path outside every root is refused rather than walked.
       *
       * The tree is a view of the folders a person registered; answering for an arbitrary directory
       * would make `heddle tree /` a listing of the whole machine, and the Web UI's route must not be
       * a general directory browser behind a token.
       */
      const workspaces = requireWorkspace(app.ctx)
      if (wanted !== null && workspaces.owner(wanted) === undefined) {
        throw new Error(`${wanted} is not under any workspace root; register it with 'heddle workspace add ${wanted}'`)
      }
      const node = tree(wanted, {
        roots: workspaces.list().map((record) => ({ path: record.path, title: record.title, ...(record.origin !== undefined ? { origin: record.origin } : {}) })),
        sessions: app.ctx.session.list(),
        generated: [...workspaces.generated, ...args.generated],
      })
      if (json) process.stdout.write(`${JSON.stringify(node, null, 2)}\n`)
      else process.stdout.write(`${describeTree(node).join('\n')}\n`)
      return true
    }
    if (command === 'session') {
      /**
       * Where the session belongs: the branch named, or the folder the command runs in. Registering the
       * owner of that branch keeps "a session always has a workspace" true for a session created *before*
       * anything has run there, which is the case a root-level session is.
       */
      const branch = target !== undefined && target.length > 0 ? canonicalPath(target) : canonicalPath(process.cwd())
      const workspaces = requireWorkspace(app.ctx)
      workspaces.ensureOwner(branch)
      const { handle, definition } = app.ctx.session.createAt(branch, {
        ...(args.name !== undefined ? { title: args.name } : {}),
        ...(args.endpoint !== undefined ? { endpoint: args.endpoint } : {}),
        ...(args.model !== undefined ? { model: args.model } : {}),
      })
      if (json) {
        process.stdout.write(`${JSON.stringify({ session: handle.id, name: definition.name, definition: definition.file, log: definition.log }, null, 2)}\n`)
      } else {
        process.stdout.write(`heddle: session ${handle.id} at ${definition.dir}\n`)
        process.stdout.write(`heddle: its log is ${definition.log}\n`)
      }
      return true
    }
    if (command === 'file') {
      if (target === undefined) throw new Error('file needs a path')
      const wanted = canonicalPath(target)
      /**
       * The same fence as the tree, and one more reason for it: a reader that answers for any path is a
       * way to read the whole machine behind a token. The canonical path is what is checked, so a
       * symlink that resolves outside every root is refused here rather than followed.
       */
      const workspaces = requireWorkspace(app.ctx)
      if (workspaces.owner(wanted) === undefined) {
        throw new Error(`${wanted} is not under any workspace root; register its folder with 'heddle workspace add <path>'`)
      }
      const reading = readFileText(wanted)
      if (json) process.stdout.write(`${JSON.stringify(reading, null, 2)}\n`)
      else process.stdout.write(reading.text.endsWith('\n') || reading.text === '' ? reading.text : `${reading.text}\n`)
      return true
    }
    if (command === 'hooks') {
      const points = [
        { name: 'agent/pre-step', mode: 'waterfall', what: 'before a round request is built; may replace messages or tools' },
        { name: 'model/request', mode: 'waterfall', what: 'before an adapter is chosen; may replace the request' },
        { name: 'model/stream', mode: 'waterfall', what: 'around the adapter stream; may yield its own chunks' },
        { name: 'tools/pre-execute', mode: 'waterfall', what: 'before a tool runs; may refuse it' },
        { name: 'tools/post-execute', mode: 'waterfall', what: 'after a tool runs; may replace the result' },
        { name: 'session/event', mode: 'emit', what: 'after an event reaches the session file' },
      ]
      if (json) process.stdout.write(`${JSON.stringify(points, null, 2)}\n`)
      else {
        process.stdout.write(`heddle: ${points.length} hook point(s)\n`)
        for (const point of points) process.stdout.write(`  ${point.name.padEnd(20)} ${point.mode.padEnd(10)} ${point.what}\n`)
      }
      return true
    }
    if (command === 'goal') {
      const goal = app.ctx.goal
      if (goal === undefined) throw new Error('this profile does not load the goal plugin')
      const handle = target !== undefined && target.length > 0 ? app.ctx.session.start({ resume: target }) : app.ctx.session.start({ cwd: process.cwd() })
      const view = goal.get(handle)
      if (json) process.stdout.write(`${JSON.stringify({ session: handle.id, goal: view ?? null }, null, 2)}\n`)
      else if (view === undefined) process.stdout.write(`heddle: no goal is current in ${handle.id}\n`)
      else {
        process.stdout.write(`heddle: ${view.id}  revision ${view.revision}  ${view.phase} (${view.activation})\n`)
        process.stdout.write(`  objective: ${view.objective}\n`)
        process.stdout.write(`  rounds: ${view.roundsStarted}/${view.maxGoalRounds}\n`)
        if (view.blockedReason !== undefined) process.stdout.write(`  blocked: ${view.blockedReason.code} — ${view.blockedReason.message}\n`)
      }
      return true
    }
    if (command === 'context') {
      const handle =
        target !== undefined && target.length > 0
          ? app.ctx.session.start({ resume: target })
          : app.ctx.session.start({ cwd: process.cwd() })
      const report = app.ctx.context.assemble(handle, {
        /**
         * The directory the run resolved its instructions from, not the shell's.
         *
         * Asking a resumed session what it would send and getting a different answer than the run
         * would produce is the whole failure this avoids: use the session's recorded folder,
         * with the sandbox root only as a fallback for a legacy record with no directory.
         */
        cwd: app.ctx.session.folder(handle) ?? app.ctx.sandbox.workspaceRoot,
        tools: app.ctx.tools.describe(),
        ...(args.endpoint !== undefined ? { endpoint: args.endpoint } : {}),
        ...(args.model !== undefined ? { model: args.model } : {}),
      })
      /**
       * What the model would read, not only how much of it.
       *
       * A budget is checkable from numbers, but "the summary is in there once, where the span was"
       * and "the instructions on the surface are the current ones" are claims about the messages
       * themselves. Both a person and a check want to see them, so the derived surface is part of
       * this command's answer rather than something only a debugger can reach.
       */
      const messages = report.messages.map((message) => ({
        role: message.role,
        ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
        text: describeContent(message.content),
      }))
      if (json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              session: handle.id,
              messageCount: report.messages.length,
              messages,
              estimatedTokens: report.estimatedTokens,
              thresholdTokens: report.thresholdTokens,
              contextWindow: report.contextWindow,
              pruned: report.pruned,
              compacted: report.compacted,
              instructions: report.instructions,
            },
            null,
            2,
          )}\n`,
        )
      } else {
        process.stdout.write(`heddle: ${report.messages.length} message(s), about ${report.estimatedTokens} token(s)\n`)
        process.stdout.write(`heddle: budget ${report.thresholdTokens} of ${report.contextWindow}; pruned ${report.pruned}; compacted ${report.compacted}\n`)
        for (const path of report.instructions) process.stdout.write(`  instruction ${path}\n`)
        for (const message of messages) process.stdout.write(`  ${message.role}: ${message.text.slice(0, 80).replace(/\n/g, ' ')}\n`)
      }
      return true
    }
    return false
  } finally {
    await app.dispose()
  }
}

/**
 * The profile a run boots when it names none (issue #74).
 *
 * A run that boots — `web`, a command, or a `--turn` — and names no profile, no `--config` and no `--patch`, from a
 * folder with no project tree (`cordis.yml`), used to boot **nothing**: on a fresh home the page loaded with no
 * session, model or workspace service, and the first message failed with an internal TypeError. DSH auto-initializes
 * its shipped profiles from their templates on first use; heddle does the same for `default`: such a run boots
 * `$HEDDLE_HOME/profiles/default`, created from the shipped template the first time, and says so on stderr. A profile a
 * person already keeps under that name is booted as it is. `profiles` lists what exists and creates nothing. Answers
 * false when the template could not be written (the reason is on stderr and the exit code is 1).
 */
function useDefaultProfile(args: Args): boolean {
  if (args.profile !== undefined || args.config !== undefined || args.patch.length > 0) return true
  /**
   * `--from-default-profile` replaces a profile, so it must name one: the check below refuses it without `--profile`.
   * Choosing `default` here first would turn that refusal into a reset of the default profile (developer-two's review).
   */
  if (args.fromDefaultProfile !== undefined) return true
  if (args.command === undefined && args.turn === undefined) return true
  if (args.command === 'profiles') return true
  if (existsSync(resolve(process.cwd(), 'cordis.yml'))) return true
  const dir = join(profilesDir(), 'default')
  if (!existsSync(dir)) {
    try {
      resetProfileFromTemplate('default', 'default', { checkout: resolve(dirname(fileURLToPath(import.meta.url)), '..') })
    } catch (error) {
      process.stderr.write(`heddle: ${error instanceof ConfigError ? error.problems.join('; ') : (error as Error).message}\n`)
      process.exitCode = 1
      return false
    }
    process.stderr.write(`heddle: created profile 'default' from the shipped template at ${dir}\n`)
  }
  args.profile = 'default'
  return true
}

function hasProfileArgs(args: Args): boolean {
  return hasProfile(args)
}

/** Fill in the flags `runCommand` does not read from the caller. */
function emptyArgs(args: Args): Args {
  return { ...args, command: undefined }
}

/**
 * The workspace service, or a sentence saying the profile does not load it.
 *
 * `ctx.workspace` is a **proxy lookup**, so a profile that leaves the plugin out answers `undefined`
 * rather than throwing at boot, and `undefined.list()` is a diagnosis a person has to
 * reverse-engineer. The three workspace-facing commands are meaningless without the service, so they
 * say which row is missing instead.
 */
function requireWorkspace(ctx: { workspace?: WorkspaceService }): WorkspaceService {
  if (ctx.workspace === undefined) {
    throw new Error('this profile does not load the workspace plugin, so it keeps no workspace records')
  }
  return ctx.workspace
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(USAGE)
    return
  }

  if (!useDefaultProfile(args)) return

  /**
   * DSH's `--profile <name> --from-default-profile <template>`: the named profile is replaced by a fresh copy of a
   * shipped template, then the command boots it as usual. A profile named by a directory is not a profile this can
   * replace, so the flag needs a plain name.
   */
  if (args.fromDefaultProfile !== undefined) {
    if (args.profile === undefined || args.profile.startsWith('/')) {
      process.stderr.write('heddle: --from-default-profile needs --profile <name>, a profile under $HEDDLE_HOME/profiles\n')
      process.exitCode = 1
      return
    }
    try {
      resetProfileFromTemplate(args.profile, args.fromDefaultProfile, { checkout: resolve(dirname(fileURLToPath(import.meta.url)), '..') })
    } catch (error) {
      process.stderr.write(`heddle: ${error instanceof ConfigError ? error.problems.join('; ') : (error as Error).message}\n`)
      process.exitCode = 1
      return
    }
    process.stderr.write(`heddle: profile '${args.profile}' replaced by a fresh copy of the '${args.fromDefaultProfile}' template\n`)
  }

  if (args.command === 'web') {
    await runWeb(args)
    return
  }

  if (args.command === 'profiles' || args.command === 'config') {
    const handled = await runConfigCommand(args.command, args)
    if (handled) return
  }

  if (args.command !== undefined) {
    const handled = await runCommand(args.command, args.target, args.json, args)
    if (handled) return
  }

  if (!hasProfileArgs(args)) {
    const app = await createApp(args)
    const { ctx } = app
    printTree(ctx as unknown as RegistryView)
    ctx.emit('heddle/ready', app.target)
    await app.dispose()
    return
  }

  const app = await bootFromArgs(emptyArgs(args), { machineOutput: args.json && args.turn !== undefined })
  try {
    const pending = await settle(app.ctx)
    /**
     * The allow list is applied **now**, after every plugin has had its chance to register.
     *
     * Measured: filtering inside the tools plugin's constructor removed a plugin's own tool before the
     * plugin existed, so a project could not replace a built-in with its own version of the same name
     * — the most ordinary reason to register one. Filtering here keeps the configuration's word, that
     * the run gets the tools it named, while letting a plugin contribute one at any load order.
     */
    applyToolAllowList(app.ctx)
    /**
     * The finished tree is asked whether the configuration was satisfied.
     *
     * Asked rather than listened for: `boot` emits `heddle/ready` before it returns, so a listener
     * attached here would never see it — measured, and the reason the earlier attempt at this
     * silently checked nothing.
     */
    const configProblems = [
      ...failedEntries(app.ctx).map((entry) => `row '${entry.id}' (${entry.name}) failed to load`),
      ...(app.ctx.tools?.missing?.() ?? []),
    ]
    if (pending.length > 0) {
      process.stdout.write(`heddle: ${pending.length} entry(ies) still pending: ${pending.join(', ')}\n`)
      process.exitCode = 1
      return
    }

    if (configProblems.length > 0) {
      process.stderr.write(`heddle: the configuration names ${configProblems.join(', ')}, which nothing registered\n`)
      process.exitCode = 1
      return
    }

    if (args.turn === undefined) {
      printTree(app.ctx as unknown as RegistryView & { loader?: LoaderLike })
      return
    }

    const endpoints = app.ctx.model.names()
    const endpoint = args.endpoint ?? app.ctx.model.defaultEndpoint()
    if (endpoint === undefined) throw new Error('no endpoint is configured; write ~/.heddle/heddle.json or pass --endpoint after configuring one')
    if (!endpoints.includes(endpoint)) throw new Error(`no endpoint named '${endpoint}'; configured: ${endpoints.join(', ')}`)

    /**
     * A turn asks **this folder's session**, which is the whole of "one folder, one session".
     *
     * Measured against the old behaviour: a second `--turn` in one directory started a second
     * session, so the folder accumulated conversations and the left column had no way to say which
     * one a person meant. Now the folder is the identity: the first turn creates its session, later
     * turns continue it, and `--new` is the explicit way to start another (which then becomes the
     * folder's current one, with the old log left untouched).
     *
     * `--resume` still addresses a session by id from anywhere, because a person who has an id is
     * asking about that session rather than about this folder.
     *
     * A new session is born untitled, as the turn route's is (#68): its first message writes the fallback name and
     * the session layer asks the model for the title (`session/title.ts`).
     */
    const folder = canonicalPath(process.cwd())
    /**
     * A new session that names neither an endpoint nor a model starts with the configured default selection (the
     * model row's defaultModel and defaultEffort, checked against the default endpoint; DSH's default model
     * selection). It is recorded when the session is created, so a later change of default leaves this session as
     * it is, and a session that already exists keeps what it had.
     */
    const known = new Set(app.ctx.session.list().map((meta) => meta.id))
    const defaults = args.endpoint === undefined && args.model === undefined && args.resume === undefined ? app.ctx.model.defaultSelection() : {}
    const handle =
      args.resume !== undefined
        ? app.ctx.session.start({ resume: args.resume })
        : app.ctx.session.openAt(folder, {
            fresh: args.fresh,
            endpoint,
            ...((args.model ?? defaults.model) !== undefined ? { model: args.model ?? defaults.model } : {}),
            ...(defaults.reasoningEffort !== undefined ? { reasoningEffort: defaults.reasoningEffort } : {}),
          })
    const created = !known.has(handle.id)
    const startModel = args.model ?? (created ? defaults.model : undefined)
    const startEffort = created ? defaults.reasoningEffort : undefined

    /**
     * A session always has a workspace — **when the profile has one at all**.
     *
     * The folder a session is bound to registers itself when no root is above it, so the record is
     * never something a person has to maintain, and the registration is immediate rather than waiting
     * for the next boot's bootstrap. The service is asked for rather than assumed: a profile may
     * leave the workspace plugin out and still run turns, and an unconditional call is what made
     * every turn in three verifiers' own minimal profiles fail — measured, five checks at once, with
     * the failure reading as a sandbox bug rather than as a missing service.
     */
    const bound = app.ctx.session.list().find((meta) => meta.id === handle.id)?.cwd ?? folder
    app.ctx.workspace?.ensureOwner(bound)
    // The live view, started before the turn so nothing that arrives is missed.
    const printer = args.stream ? printStream(app.ctx, { session: handle.id }) : null
    const result = await runTurn(app.ctx, {
      session: handle,
      endpoint,
      prompt: args.turn,
      ...(args.system !== undefined ? { system: args.system } : {}),
      ...(startModel !== undefined ? { model: startModel } : {}),
      ...(startEffort !== undefined ? { reasoningEffort: startEffort } : {}),
      ...(args.maxRounds !== undefined ? { maxRounds: args.maxRounds } : {}),
      ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
    })

    /**
     * Background children report back by notice, so a one-shot process waits for them — DSH's headless host waits
     * for its children before its final answer. `settle` returns once no child of this session is running and every
     * notice has been answered (each notice to an idle parent starts a turn of its own); the answer printed is then
     * the session's last one, not the turn that only started the children.
     */
    const subagents = app.ctx.get('subagents') as SubagentService | undefined
    const settleSubagents = async (): Promise<number> => (subagents !== undefined ? subagents.settle(handle.id) : 0)
    let notices = await settleSubagents()

    /**
     * A goal continues itself. The driver started on this turn's own `turn/completed` event, so this call
     * **joins** the running chain rather than starting a second one — and joining it here is what keeps a
     * one-shot process alive until its rounds are done.
     */
    if (app.ctx.goalDriver !== undefined) {
      const driven = await app.ctx.goalDriver.advance(handle)
      if (!args.json && driven.rounds > 0) {
        process.stdout.write(`heddle: the goal continued for ${driven.rounds} round(s); ${driven.stopped}\n`)
      }
      notices = await settleSubagents()
    }
    const finalText = notices > 0 ? finalAssistantText(app.ctx.session.store.read(handle)) : result.text
    if (!args.json && notices > 0) process.stdout.write(`heddle: answered ${notices} subagent notice(s)\n`)
    printer?.dispose()
    const streamed = printer?.summary()
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            session: handle.id,
            ...(streamed !== undefined ? { stream: streamed } : {}),
            // What the context was: the estimate, the budget, what was pruned, whether a
            // compaction ran. Reported because a budget nobody can see is a budget nobody can
            // check, and the context check reads exactly this.
            ...(result.context !== undefined ? { context: result.context } : {}),
            endpoint,
            text: finalText,
            ...(notices > 0 ? { subagentNotices: notices } : {}),
            finishReason: result.finishReason,
            rounds: result.rounds,
            toolCalls: result.toolCalls.map((call) => ({ name: call.name, ok: call.result.error === undefined })),
            denials: result.denials,
            transcript: handle.transcript,
          },
          null,
          2,
        )}\n`,
      )
    } else {
      process.stdout.write(`${finalText}\n`)
      for (const call of result.toolCalls) {
        process.stdout.write(
          `heddle: tool ${call.name} ${call.result.error ? `refused (${call.result.error.code}) — ${call.result.error.message}` : 'ok'}\n`,
        )
      }
      for (const denial of result.denials) process.stdout.write(`heddle: denied ${denial.tool} — ${denial.message}\n`)
      process.stdout.write(`heddle: session ${handle.id} — ${handle.transcript}\n`)
    }
    if (result.denials.some((denial) => denial.code !== 'UNKNOWN_TOOL')) process.exitCode = 1
  } finally {
    await app.dispose()
  }
}

try {
  await main()
} catch (error) {
  process.stderr.write(`heddle: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
