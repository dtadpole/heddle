import { rmSync } from 'node:fs'

// Scratch folders a check creates in the user TMPDIR (temp dirs, browser profiles) are removed when the
// process ends, even when the check threw before its own cleanup or the runner sent SIGTERM/SIGINT.
// SIGKILL cannot be caught; `_tools_/local-build/tmp-sweep` removes what that leaves.

const tracked = new Map() // folder -> the browser process writing into it, or null
const handlers = {}
let hooked = false

function removeAll() {
  for (const [dir, child] of tracked) {
    try {
      child?.kill('SIGKILL') // a browser still writing its profile would defeat the removal
    } catch {}
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
  tracked.clear()
}

function onSignal(signal) {
  removeAll()
  process.removeListener(signal, handlers[signal])
  // Re-raise for the default exit, unless another listener has taken charge of shutting down.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
}

/** Remove `dir` (and stop `child`) when the process exits or is told to stop. Returns `dir`. */
export function trackScratch(dir, child = null) {
  tracked.set(dir, child)
  if (!hooked) {
    hooked = true
    process.on('exit', removeAll)
    for (const signal of ['SIGINT', 'SIGTERM']) {
      handlers[signal] = () => onSignal(signal)
      process.on(signal, handlers[signal])
    }
  }
  return dir
}

/** The folder was removed by its owner; nothing left to do at exit. */
export function untrackScratch(dir) {
  tracked.delete(dir)
}
