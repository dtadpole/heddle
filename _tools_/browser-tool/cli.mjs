#!/usr/bin/env node
import { readFileSync } from 'node:fs'

import { browserPath, stateDir } from './chrome.mjs'
import { callTool, startHostProcess, status, stopHost } from './client.mjs'
import { startHost } from './host.mjs'
import { TOOL_HELP, TOOL_NAMES } from './tools.mjs'

/**
 * The command line for the browser tool.
 *
 * One command per browser tool, with the tool's arguments as either one JSON object or `--name=value`
 * pairs, so a shell that is bad at quoting is not the reason a call fails:
 *
 *     node _tools_/browser-tool/cli.mjs take_snapshot
 *     node _tools_/browser-tool/cli.mjs click '{"uid": "1_3"}'
 *     node _tools_/browser-tool/cli.mjs fill --uid=1_4 --value=hello
 *
 * `start`, `stop` and `status` manage the session host. Any tool call starts one if none is running.
 */

const USAGE = `browser — drive a real Chrome over the DevTools protocol

usage:
  node _tools_/browser-tool/cli.mjs <tool> [json | --name=value ...] [--session=NAME]
  node _tools_/browser-tool/cli.mjs start [--headless] [--session=NAME] [--profile=DIR] [--binary=PATH] [--state=DIR]
  node _tools_/browser-tool/cli.mjs stop [--session=NAME]
  node _tools_/browser-tool/cli.mjs status [--session=NAME]
  node _tools_/browser-tool/cli.mjs tools

commands:
  start    open the browser and keep it open for later commands (a visible window)
  stop     close the browser and forget the session
  status   report whether a browser is running, and on which endpoint
  tools    list the tools this implementation offers

state and isolation:
  the browser profile and the session live in ${stateDir()} (HEDDLE_BROWSER_HOME moves them);
  a login done in the visible window is reused by every later call in that session.

  --session=NAME (or HEDDLE_BROWSER_SESSION) gives this command a browser of its own: its own
  process, profile and tabs, under state/sessions/NAME/. Two sessions never see each other's
  pages, so two agents driving a browser at once do not fight over one selected page.

examples:
  cli.mjs new_page '{"url": "https://example.com"}'
  cli.mjs take_snapshot
  cli.mjs click '{"uid": "1_2"}'
  cli.mjs take_screenshot '{"fullPage": true}'
`

/** Parse `--name=value` pairs into an argument object, converting booleans and numbers. */
function parsePairs(pairs) {
  const args = {}
  for (const pair of pairs) {
    if (!pair.startsWith('--')) throw new Error(`'${pair}' is not a --name=value argument`)
    const body = pair.slice(2)
    const index = body.indexOf('=')
    if (index < 0) {
      args[body] = true
      continue
    }
    const name = body.slice(0, index)
    const raw = body.slice(index + 1)
    if (raw === 'true' || raw === 'false') args[name] = raw === 'true'
    else if (raw !== '' && Number.isFinite(Number(raw)) && !/^0\d/.test(raw) && name !== 'uid') args[name] = Number(raw)
    else if (raw.startsWith('{') || raw.startsWith('[')) {
      try {
        args[name] = JSON.parse(raw)
      } catch {
        args[name] = raw
      }
    } else args[name] = raw
    /** The schema names a coordinate pair `x`/`y`; a caller typing `--x=1` means the number. */
    if (name === 'uid') args[name] = String(raw)
  }
  return args
}

/** Everything after the command, as one argument object. */
function parseToolArguments(rest) {
  if (rest.length === 0) return {}
  if (rest[0].startsWith('{')) {
    try {
      const parsed = JSON.parse(rest[0])
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
      return parsed
    } catch (error) {
      throw new Error(`the argument object is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (rest[0].startsWith('--file=')) {
    const path = rest[0].slice('--file='.length)
    if (path.length === 0) throw new Error('--file needs a path')
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  if (rest[0] === '--file') {
    const path = rest[1]
    if (path === undefined) throw new Error('--file needs a path')
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  return parsePairs(rest)
}

/** Print one result: its text when it has one, JSON otherwise. */
function printResult(result, { json = false } = {}) {
  if (json !== true && typeof result?.text === 'string') {
    console.log(result.text)
    return
  }
  console.log(JSON.stringify(result, null, 2))
}

/** The internal command `cli.mjs __daemon` runs the session host in the foreground of its own process. */
async function daemon(argv) {
  const options = {}
  for (const arg of argv) {
    if (arg === '--headless') options.headless = true
    else if (arg.startsWith('--state=')) options.stateDir = arg.slice('--state='.length)
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length)
    else if (arg.startsWith('--binary=')) options.binary = arg.slice('--binary='.length)
    else if (arg.startsWith('--width=')) options.width = Number(arg.slice('--width='.length))
    else if (arg.startsWith('--height=')) options.height = Number(arg.slice('--height='.length))
  }
  const host = await startHost(options)
  const stop = async () => {
    await host.shutdown()
    process.exit(0)
  }
  process.on('SIGTERM', () => void stop())
  process.on('SIGINT', () => void stop())
  // Keep the process alive on the server itself; the browser may outlive a quiet moment.
  await new Promise(() => {})
}

async function main(argv) {
  /**
   * The session name is a property of the invocation rather than of one command, so it is read before
   * the command is dispatched and removed from the arguments an individual tool would otherwise see.
   */
  const sessionArgument = argv.find((arg) => arg.startsWith('--session='))
  if (sessionArgument !== undefined) {
    const name = sessionArgument.slice('--session='.length)
    if (name.length === 0) throw new Error('--session needs a name')
    process.env.HEDDLE_BROWSER_SESSION = name
    argv = argv.filter((arg) => !arg.startsWith('--session='))
  }
  const [command, ...rest] = argv
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE)
    return 0
  }
  if (command === '__daemon') {
    await daemon(rest)
    return 0
  }
  if (command === 'tools') {
    const lines = ['the tools this browser implementation offers:']
    for (const name of TOOL_NAMES) lines.push(`  ${name.padEnd(24)} ${TOOL_HELP[name] ?? ''}`)
    lines.push('', 'arguments are one JSON object, or --name=value pairs', '')
    lines.push('not replicated from the harness browser: lighthouse_audit, performance_start_trace,')
    lines.push('performance_stop_trace, performance_analyze_insight, take_heapsnapshot, get_css_styles,')
    lines.push('screencast_start, screencast_stop, and the extension/PWA/third-party tool groups — each')
    lines.push('needs a package or a DevTools frontend this tool deliberately does not ship.')
    process.stdout.write(`${lines.join('\n')}\n`)
    return 0
  }

  const options = {}
  if (command === 'start') {
    let state
    for (const arg of rest) {
      if (arg === '--headless') options.headless = true
      else if (arg === '--json') options.json = true
      else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length)
      else if (arg.startsWith('--binary=')) options.binary = arg.slice('--binary='.length)
      else if (arg.startsWith('--state=')) state = arg.slice('--state='.length)
      else if (arg.startsWith('--width=')) options.width = Number(arg.slice('--width='.length))
      else if (arg.startsWith('--height=')) options.height = Number(arg.slice('--height='.length))
      else throw new Error(`unknown start option '${arg}'`)
    }
    const live = await status({ ...options, ...(state !== undefined ? { stateDir: state } : {}) })
    if (live.running) {
      printResult({ running: true, pid: live.health?.pid, endpoint: live.health?.wsUrl, headless: live.health?.headless })
      return 0
    }
    const started = await startHostProcess({ ...options, ...(state !== undefined ? { stateDir: state } : {}) })
    printResult({
      running: true,
      pid: started.health.pid,
      endpoint: started.health.wsUrl,
      headless: started.health.headless,
      noSandbox: started.health.noSandbox,
      browser: started.health.version,
      profile: options.profile ?? joinProfile(),
    })
    return 0
  }
  if (command === 'stop') {
    printResult(await stopHost())
    return 0
  }
  if (command === 'status') {
    const result = await status()
    printResult({
      running: result.running,
      ...(result.running ? { pid: result.health.pid, endpoint: result.health.wsUrl, headless: result.health.headless, pages: result.health.pages, browser: result.health.version } : {}),
    })
    return result.running ? 0 : 0
  }

  if (!TOOL_NAMES.includes(command)) {
    process.stderr.write(`there is no browser tool called '${command}'\n\n${USAGE}`)
    return 2
  }
  const json = rest.includes('--json')
  const args = parseToolArguments(rest.filter((arg) => arg !== '--json'))
  const result = await callTool(command, args)
  printResult(result, { json })
  return 0
}

/** The profile a start used, for reporting. */
function joinProfile() {
  const home = process.env.HEDDLE_BROWSER_HOME ?? stateDir()
  return `${home}/chrome-profile`
}

try {
  const code = await main(process.argv.slice(2))
  process.exitCode = code
} catch (error) {
  process.stderr.write(`browser: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
