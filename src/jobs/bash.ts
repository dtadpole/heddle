import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

import { classifyOutcome, type ConfinedArgv } from '../sandbox/backend.ts'
import { killProcessGroup } from '../sandbox/process-group.ts'
import type { SandboxMode, SandboxService } from '../sandbox/service.ts'
import type { SessionEvent, SessionHandle } from '../session/store.ts'
import { launchShell, shellEnv, type BashBackground } from '../tools/builtin.ts'
import type { ToolResult, ToolRunContext } from '../tools/service.ts'
import { JobError, type JobHooks, type JobOutcome, type JobRegistry, type JobToolCall } from './registry.ts'

/**
 * Background `bash`: the job producer and the `run_in_background` half of the tool (`dsh-tool-bash/lib/index.js`,
 * cited `BASH:n`; the process mechanics from `dsh-bash-local`).
 *
 * The command is confined by the same sandbox path a foreground call takes (`launchShell` in `src/tools/builtin.ts`),
 * runs in the call's folder with the same environment, and is spawned **detached**, in a process group of its own,
 * so a kill reaches the whole tree: SIGTERM to the group, then SIGKILL after a grace period (DSH's 3000 ms). Both
 * signals go through the sandbox's one group helper (`killProcessGroup` in `src/sandbox/process-group.ts`), the one a
 * foreground `bash` stops its group with.
 */

/** DSH's parameter description, verbatim (BASH:514-517). */
export const RUN_IN_BACKGROUND_DESCRIPTION =
  'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.'

/** How long a killed command's group has between SIGTERM and SIGKILL (DSH's 3000 ms). */
export const DEFAULT_KILL_GRACE_MS = 3_000

/** Stderr kept for the sandbox classification at exit: the tail is where a denial or a runner failure is written. */
const STDERR_CLASSIFY_CHARS = 256 * 1024

/** DSH's sandbox markers (`dsh-sandbox/lib/index.js:64-78`). */
const denialMarker = (mode: SandboxMode): string => `[sandbox: file access denied under ${mode} mode]`
const ESCALATION_HINT =
  '[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]'
const runnerFailureMarker = (mode: SandboxMode): string =>
  `[sandbox: the sandbox runner itself failed under ${mode} mode — the command did not run; this is a sandbox problem, not a command failure]`

/** What a settled process reports, before it becomes a job outcome. */
export interface ProcessEnd {
  /** Whether a kill was asked for, or the process died of a signal. */
  readonly killed: boolean
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  /** The sandbox's reading of the end, when the command was confined. */
  readonly sandbox?: { readonly mode: SandboxMode; readonly denied: boolean; readonly runnerFailed: boolean }
}

/**
 * Map a settled process onto the job vocabulary (BASH:42-55): killed stays `killed` with the signal, or
 * `killed before exit`; every other end — a nonzero exit included — is `completed` with `exit code: <n>`. Sandbox
 * notes join the detail with "; ".
 */
export function processOutcome(end: ProcessEnd, escalationModes: readonly string[] = []): JobOutcome {
  const base: JobOutcome = end.killed
    ? { status: 'killed', detail: end.signal !== null ? `signal: ${end.signal}` : 'killed before exit' }
    : { status: 'completed', detail: `exit code: ${end.exitCode ?? 0}` }
  const notes: string[] = []
  if (end.sandbox?.runnerFailed === true) notes.push(runnerFailureMarker(end.sandbox.mode))
  else if (end.sandbox?.denied === true) {
    notes.push(denialMarker(end.sandbox.mode))
    if (escalationModes.length > 0) notes.push(ESCALATION_HINT)
  }
  return notes.length === 0 ? base : { ...base, detail: `${base.detail}; ${notes.join(' ')}` }
}

/** Everything one background command needs to run. */
export interface BackgroundProcess {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly confined: ConfinedArgv | null
  readonly mode: SandboxMode
  readonly escalationModes: readonly string[]
  readonly killGraceMs?: number
  /** Told the process id once it is spawned, so a caller (a test) can watch the group. */
  readonly onSpawn?: (pid: number) => void
}

/**
 * Signal a whole process group through the sandbox's helper (a group already gone counts as signalled); where the
 * group cannot be signalled, the shell alone is.
 */
function signalGroup(pid: number, signal: NodeJS.Signals, child: { kill(signal: NodeJS.Signals): boolean } | undefined): void {
  if (!killProcessGroup(pid, signal)) child?.kill(signal)
}

/**
 * Run one command as a job's producer: stdout and stderr appended to the job as they arrive, a cancel that stops
 * the group, and a `done` that never rejects — a spawn failure settles `failed` with the error's message.
 */
export function runProcess(spec: BackgroundProcess, append: (text: string, channel: 'stdout' | 'stderr') => void): JobHooks {
  let cancelled = false
  let closed = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let pid: number | undefined
  let spawned: ReturnType<typeof spawn> | undefined
  let stderrTail = ''

  const done = new Promise<JobOutcome>((resolve) => {
    let finished = false
    const finish = (outcome: JobOutcome): void => {
      if (finished) return
      finished = true
      resolve(outcome)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(spec.argv[0] as string, spec.argv.slice(1), {
        cwd: spec.cwd,
        env: shellEnv(),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ status: 'failed', detail: error instanceof Error ? error.message : String(error) })
      return
    }
    pid = child.pid
    spawned = child
    if (pid !== undefined) spec.onSpawn?.(pid)
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    const take = (channel: 'stdout' | 'stderr', text: string): void => {
      if (text.length === 0) return
      if (channel === 'stderr') stderrTail = (stderrTail + text).slice(-STDERR_CLASSIFY_CHARS)
      append(text, channel)
    }
    child.stdout?.on('data', (chunk: Buffer) => take('stdout', decoders.stdout.write(chunk)))
    child.stderr?.on('data', (chunk: Buffer) => take('stderr', decoders.stderr.write(chunk)))
    child.on('error', (error) => {
      closed = true
      if (killTimer !== undefined) clearTimeout(killTimer)
      finish({ status: cancelled && pid === undefined ? 'killed' : 'failed', detail: error.message })
    })
    child.on('close', (code, signal) => {
      closed = true
      take('stdout', decoders.stdout.end())
      take('stderr', decoders.stderr.end())
      // A killed group's stragglers still get their SIGKILL, but the pending timer no longer holds the process open.
      killTimer?.unref()
      let sandbox: ProcessEnd['sandbox']
      if (spec.confined !== null) {
        const reading = classifyOutcome({ exitCode: code ?? 1, stderr: stderrTail, confined: spec.confined })
        sandbox = { mode: spec.mode, denied: reading.kind === 'denied', runnerFailed: reading.kind === 'runner-failure' }
      }
      finish(
        processOutcome(
          { killed: cancelled || signal !== null, exitCode: code, signal, ...(sandbox !== undefined ? { sandbox } : {}) },
          spec.escalationModes,
        ),
      )
    })
  })

  return {
    cancel: () => {
      if (cancelled) return
      cancelled = true
      if (pid === undefined || closed) return
      const group = pid
      const shell = spawned
      signalGroup(group, 'SIGTERM', shell)
      killTimer = setTimeout(() => signalGroup(group, 'SIGKILL', shell), spec.killGraceMs ?? DEFAULT_KILL_GRACE_MS)
    },
    done,
  }
}

/**
 * The tool call that is running, read from the session log.
 *
 * Heddle's tool context carries no call id, and `bash` is an exclusive tool: every call before it in the step has
 * already been answered in the log when it runs. So the running call is the first `bash` tool call of the current
 * model answer that has no tool result yet and whose arguments are these. Absent when the log cannot say.
 */
export function runningToolCall(events: readonly SessionEvent[], name: string, args: Record<string, unknown>): JobToolCall | undefined {
  const answered = new Set<string>()
  const candidates: { id: string; arguments: string }[] = []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'model/request') break
    if (event.type === 'message') {
      const message = event.message as { role?: string; toolCallId?: unknown } | undefined
      if (message?.role === 'tool' && typeof message.toolCallId === 'string') answered.add(message.toolCallId)
      continue
    }
    if (event.type !== 'assistant/chunk') continue
    const chunk = event.chunk as { type?: string; id?: unknown; name?: unknown; arguments?: unknown } | undefined
    if (chunk?.type === 'tool-call' && chunk.name === name && typeof chunk.id === 'string' && typeof chunk.arguments === 'string') {
      candidates.unshift({ id: chunk.id, arguments: chunk.arguments })
    }
  }
  const wanted = JSON.stringify(args)
  for (const candidate of candidates) {
    if (answered.has(candidate.id)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate.arguments)
    } catch {
      continue
    }
    if (JSON.stringify(parsed) === wanted) return { callId: candidate.id, rootCallId: candidate.id }
  }
  return undefined
}

export interface BashBackgroundOptions {
  /** Reads a session's log, to find the tool call that started a job. */
  readonly readLog?: (session: SessionHandle) => readonly SessionEvent[]
  readonly killGraceMs?: number
  readonly onSpawn?: (jobId: string, pid: number) => void
}

/**
 * The runner the jobs row attaches to `bash` (`attachBashBackground`): register the command as a `bash` job owned by
 * the calling session and answer `started background job <id>` at once (BASH:651, 673-685).
 */
export function bashBackground(jobs: JobRegistry, sandbox: SandboxService, options: BashBackgroundOptions = {}): BashBackground {
  return {
    property: { type: 'boolean', description: RUN_IN_BACKGROUND_DESCRIPTION },
    start: async (args: Record<string, unknown>, context: ToolRunContext): Promise<ToolResult> => {
      const command = String(args.command ?? '')
      if (context.signal?.aborted === true) return { output: '', error: { code: 'TOOL_ABORTED', message: 'tool call aborted' } }
      const launch = launchShell(sandbox, command, context)
      if ('refusal' in launch) return launch.refusal
      const toolCall = context.session !== undefined && options.readLog !== undefined ? runningToolCall(options.readLog(context.session), 'bash', args) : undefined
      let jobId = ''
      try {
        jobId = jobs.start({
          kind: 'bash',
          label: command,
          ...(context.session !== undefined ? { owner: context.session.id } : {}),
          ...(toolCall !== undefined ? { toolCall } : {}),
          run: (handle) =>
            runProcess(
              {
                argv: launch.argv,
                cwd: context.cwd,
                confined: launch.confined,
                mode: context.mode,
                escalationModes: sandbox.escalationTargets(),
                ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
                onSpawn: (pid) => options.onSpawn?.(handle.id, pid),
              },
              (text, channel) => handle.append(text, { channel }),
            ),
        })
      } catch (error) {
        if (error instanceof JobError) return { output: '', error: { code: error.code, message: error.message } }
        throw error
      }
      context.log(`started background job ${jobId}`)
      return { output: `started background job ${jobId}`, data: { jobId, cwd: context.cwd } }
    },
  }
}
