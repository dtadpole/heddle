/**
 * Stopping a command means stopping everything it started.
 *
 * The shell a tool launches (`/bin/sh -c …`, wrapped or not in a kernel runner) forks the command's own processes.
 * Signalling only the shell re-parents them to init, and they keep running after a Stop or a timeout: live-testing
 * draft developer-five-5 watched `sleep 37` outlive its Stop on both builds, and this build's turn wait for it, because
 * the orphan still held the output pipes. DSH spawns each child detached, as the leader of its own process group, and
 * signals the group (`dsh-subprocess-local`: `signalChildGroup` sends the signal to `-child.pid`). A launcher here
 * starts its child the same way (`spawn(…, { detached: true })`) and stops it with {@link killProcessGroup}; the Rust
 * twin is `heddle_sandbox::kill_process_group` (`signal_process_group` for another signal).
 *
 * One helper serves both launchers: a foreground `bash` sends `SIGKILL` at once, and a background job
 * (`src/jobs/bash.ts`) sends `SIGTERM`, then `SIGKILL` after DSH's 3000 ms grace (`dsh-subprocess-local`'s
 * TERM-wait-KILL).
 */

/**
 * Send `signal` (`SIGKILL` unless named) to every process in the group that `leader` leads.
 *
 * `leader` is the pid of a child spawned `detached`, which makes it the leader of its own group. The two values that
 * cannot be such a leader are refused rather than signalled, because `kill(-pid)` gives them a meaning nobody wants
 * here: 0 is the server's own group, and 1 is every process the server may signal. A group that has already gone
 * (`ESRCH`) counts as stopped.
 *
 * @returns `true` when the group was signalled or was already gone; `false` when it could not be (no pid, a refused
 *   pid, a platform without process groups, or a refusal such as `EPERM`), so the caller falls back to signalling its
 *   child alone.
 */
export function killProcessGroup(leader: number | undefined, signal: NodeJS.Signals = 'SIGKILL'): boolean {
  if (leader === undefined || !Number.isInteger(leader) || leader <= 1) return false
  if (process.platform === 'win32') return false
  try {
    process.kill(-leader, signal)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}
