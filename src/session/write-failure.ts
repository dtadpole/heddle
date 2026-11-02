/**
 * A session store write that failed: a creation, rename, pin, unpin, archive or unarchive the store could not save
 * (issue #149).
 *
 * The store writes a session's record into its folder under the heddle home, and a full disk or a permission mistake
 * makes that write throw. The route used to let Node's error through as a `500 internal error: EACCES: permission
 * denied, open '<absolute path into the store>'`, and the Rust build answered a rename `404 no session` and a pin
 * `409 code: "archived"` for the same failure.
 *
 * DSH reports such a failure as an infrastructure fault, `gateway/internal`: its rename wraps it as `failed to rename
 * session "<id>": <error>` (`dsh-api-session-controller` lib/index.js:839), and its pin and archive let the registry's
 * storage fault through, which the gateway answers with that code (`dsh-workspace` lib/index.js:609-612, "storage faults
 * never masquerade as an unknown session"; `dsh-api-gateway` `rpcFailure`, lib/index.js:1673-1690). Both builds answer it
 * `500` with DSH's code and DSH's rename sentence for every verb. The reason is said in words and never with the path:
 * the store's folder names are the working folder spelled out, home directory included (#106, #130). The words and the
 * code are the Rust build's `SessionError::write_failure`, word for word.
 *
 * Creating a session is a store write too, and it failed the same raw way: New session in a workspace whose store folder
 * is unwritable answered `500 internal error: EACCES: permission denied, open '<absolute store path>/session-<id>.json'`
 * here and `400 <absolute store path>/session-<id>.json: Permission denied (os error 13)` in the Rust build (#149, J180).
 * DSH wraps a failed creation as `failed to create session: <error>` with the same `gateway/internal`
 * (`dsh-api-session-controller` lib/index.js:1073-1086, `rejectCreation`), and names no session, since none was made.
 * `storeCreateFailure` is that sentence with the same reason words; the Rust build's is `SessionError::create_failure`.
 */

/** DSH's code for a failure that is not the caller's: the store could not save the change. */
export const WRITE_FAILED_CODE = 'gateway/internal'

/** What was being saved, in the sentence's words. A `create` names no session: none was made. */
export type SessionWriteVerb = 'create' | 'rename' | 'pin' | 'unpin' | 'archive' | 'unarchive'

/** A store write that failed, with DSH's code beside the sentence. Recognised by class, name or code. */
export class SessionWriteError extends Error {
  readonly code = WRITE_FAILED_CODE
  /** `id` is the session the write was for, and `undefined` for a creation, which DSH's sentence names no session in. */
  constructor(verb: SessionWriteVerb, id: string | undefined, reason: string) {
    super(id === undefined ? `failed to ${verb} session: ${reason}` : `failed to ${verb} session "${id}": ${reason}`)
    this.name = 'SessionWriteError'
  }
}

/**
 * The reason a file-system call failed, in words, or `undefined` for an error that is not one (a refusal such as
 * `SessionFlagError` carries a `code` too, so the call's `syscall` is what tells them apart). EACCES and EPERM are both
 * "permission denied", as #106's unwritable branch reads them and as Rust's `PermissionDenied` folds them.
 */
export function writeFailureReason(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const { code, syscall } = error as NodeJS.ErrnoException
  if (typeof code !== 'string' || typeof syscall !== 'string' || !/^E[A-Z0-9]+$/.test(code)) return undefined
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'permission denied'
    case 'EROFS':
      return 'read-only file system'
    case 'ENOSPC':
      return 'no space left on device'
    default:
      return 'the session store could not be written'
  }
}

/** The failure for `error` met saving `verb` on session `id`, or `undefined` when it is not a write failure. */
export function storeWriteFailure(verb: SessionWriteVerb, id: string, error: unknown): SessionWriteError | undefined {
  const reason = writeFailureReason(error)
  return reason === undefined ? undefined : new SessionWriteError(verb, id, reason)
}

/**
 * The failure for `error` met creating a session — `failed to create session: <reason>`, DSH's `rejectCreation`
 * sentence (`dsh-api-session-controller` lib/index.js:1085) — or `undefined` when it is not a write failure. A branch
 * heddle cannot write its definition into is not one: that is #106's `session/unwritable`, which carries no `syscall`.
 */
export function storeCreateFailure(error: unknown): SessionWriteError | undefined {
  const reason = writeFailureReason(error)
  return reason === undefined ? undefined : new SessionWriteError('create', undefined, reason)
}

/** The verb a flags patch saves: an archive change names the write when there is one, else the pin change. */
export function flagVerb(patch: { readonly pinned?: boolean; readonly archived?: boolean }): SessionWriteVerb {
  if (patch.archived !== undefined) return patch.archived ? 'archive' : 'unarchive'
  return patch.pinned === false ? 'unpin' : 'pin'
}
