/**
 * Stopping a command means stopping everything it started.
 *
 * The shell a tool launches (`/bin/sh -c …`, wrapped or not in a kernel runner) forks the command's own processes.
 * Signalling only the shell re-parents them to init, and they keep running after a Stop or a timeout: live-testing
 * draft developer-five-5 watched `sleep 37` outlive its Stop on both builds, and this build's turn wait for it, because
 * the orphan still held the output pipes. DSH spawns each child detached, as the leader of its own process group, and
 * signals the group (`dsh-subprocess-local`: `signalChildGroup` sends the signal to `-child.pid`). A launcher here
 * starts its child the same way (`spawn(…, { detached: true })`) and stops it with {@link killProcessGroup}; the Rust
 * twin is `heddle_sandbox::kill_process_group`.
 */

/**
 * Send `SIGKILL` to every process in the group that `leader` leads.
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
export function killProcessGroup(leader: number | undefined): boolean {
  if (leader === undefined || !Number.isInteger(leader) || leader <= 1) return false
  if (process.platform === 'win32') return false
  try {
    process.kill(-leader, 'SIGKILL')
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/**
 * The process groups of commands still running, ended when the process exits so a restart cannot leave them behind
 * (live-testing issue #6). The server's own shutdown stops its turns first; this is the backstop for any other exit,
 * shared by every launcher that starts a detached group (the bash tool, and the jobs producers).
 */
const liveGroups = new Set<number>()
let exitHookArmed = false

/** Register a running command's group leader with the exit backstop. */
export function trackGroup(leader: number | undefined): void {
  if (leader === undefined) return
  liveGroups.add(leader)
  if (exitHookArmed) return
  exitHookArmed = true
  process.once('exit', () => {
    for (const group of liveGroups) killProcessGroup(group)
  })
}

/** Forget a group whose command has ended, so the backstop never signals a pid that may be reused. */
export function untrackGroup(leader: number | undefined): void {
  if (leader !== undefined) liveGroups.delete(leader)
}
