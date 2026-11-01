import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

/**
 * A background job's process group ends when the harness process exits, through the same exit backstop the bash
 * tool's launcher registers with (`trackGroup` in `src/sandbox/process-group.ts`, issue #6).
 *
 * The job producer spawns detached, in a group of its own, so nothing else would end it: before, a job (and every
 * promoted foreground call, which runs as one) outlived a harness that exited without its graceful teardown.
 */

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function gone(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !alive(pid)
}

test('a job started by the producer ends with the process that started it (issue #6 backstop)', { timeout: 15_000 }, async () => {
  const module = JSON.stringify(new URL('../src/jobs/bash.ts', import.meta.url).href)
  const script = [
    `import { runProcess } from ${module}`,
    "let reported = false",
    "runProcess({ argv: ['/bin/sh', '-c', 'sleep 43 & echo $!; wait'], cwd: process.cwd(), confined: null, mode: 'danger-full-access', escalationModes: [] }, (text, channel) => {",
    "  if (reported || channel !== 'stdout') return",
    "  reported = true",
    "  process.stdout.write(text.trim())",
    "  process.exit(0)",
    "})",
  ].join('\n')
  const child = Number(execFileSync(process.execPath, ['--input-type=module', '-e', script]).toString().trim())
  assert.ok(Number.isInteger(child) && child > 1, 'the background sleep reported its pid')
  assert.ok(await gone(child, 3_000), 'the exit hook ended the job\'s group, so the sleep did not outlive the process')
})
