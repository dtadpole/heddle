import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { canonicalPath } from '../paths.ts'
import type { SessionHandle } from './store.ts'
import { normalizeSessionTitle } from './title-text.ts'

/**
 * The **definition** of one session, written into the folder it belongs to.
 *
 * The owner's ruling of 2026-10-11 splits a session in two, and this module is the half that is content:
 *
 * - the **log** — every event, in order — is machine state and lives outside any repository;
 * - the **definition** — which log this is, the folder the session is bound to, and how it is run — is
 *   written under `<branch>/_sessions_/<name>/` and is meant to be committed.
 *
 * The name comes from the clock rather than from the first prompt, because a session is created before it
 * has one. It matches the conventions' instance pattern (two to four kebab-case words) so that the folder
 * passes the linter like any other instance, and it sorts chronologically, so the newest session of a
 * branch is also the last one a listing shows.
 */

/** The type folder a branch's sessions live in. The tree never draws it — it hoists what is inside. */
export const SESSIONS_FOLDER = '_sessions_'

/** The machine-readable half of a definition. */
export const DEFINITION_FILE = 'session.json'

/** What a definition says, as the harness reads it back. */
export interface SessionDefinition {
  /** The instance name, which is also the folder's name. */
  readonly name: string
  /** The `_sessions_/<name>` folder. */
  readonly dir: string
  /** The `session.json` inside it. */
  readonly file: string
  /** The log this definition references, as the store actually keeps it. */
  readonly log: string
}

/** The fields written to `session.json`. */
export interface SessionDefinitionFields {
  readonly id: string
  readonly log: string
  readonly cwd: string
  readonly createdAt: string
  readonly title?: string
  readonly endpoint?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

/**
 * A name for a new session: `session-<yyyymmdd>-<hhmm>`, and an ordinal when that minute is taken.
 *
 * Three words, so it is a valid instance name; chronological, so a name-ordering is a time-ordering; and
 * stable, because a session that has been committed should not be renamed by the next one.
 */
export function sessionName(now: Date, taken: readonly string[] = []): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const base = `session-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  if (!taken.includes(base)) return base
  for (let ordinal = 2; ordinal < 100; ordinal += 1) {
    const candidate = `${base}-${ordinal}`
    if (!taken.includes(candidate)) return candidate
  }
  throw new Error(`could not name a session for ${base}: a hundred already exist for that minute`)
}

/** The entry point every content folder carries, for the definition folder. */
function indexFor(name: string, branch: string, definition: SessionDefinitionFields): string {
  return `---
title: ${name}
version: 1.0.0
description: One agentic session — the log it references, and how it is run.
grounded_in:
  - source: heddle session ${definition.id}
---

# \`${name}\`

One session of \`${branch}\`, created by heddle. The transcript is machine state and lives outside every
repository, at \`${definition.log}\`; this folder is the **definition** a person can read, review and
commit — which log the session is, and how it is run.

## What belongs in it

- [\`${DEFINITION_FILE}\`](${DEFINITION_FILE}) — the fields the harness reads: the log's path, the folder
  the session is bound to, and the endpoint and model it was started with.
`
}

/**
 * The entry point of a branch's `_sessions_` folder, written once.
 *
 * A type folder is a content folder, so the conventions require it to carry an `INDEX.md` — and heddle
 * writes it, because the folder is created by heddle. Measured: the first version created only the session's
 * own folder, so a repository in which a session had been started failed the convention linter with
 * ``_sessions_: no entry point``. A folder that a tool creates is a folder the tool has to finish.
 */
const SESSIONS_INDEX = `---
title: Sessions
version: 1.0.0
description: One instance per agentic session of this branch — the log it references, and how it is run.
grounded_in:
  - source: heddle session definitions
---

# \`_sessions_\`

Type folder. One instance per session of the branch it sits in, written by heddle when a session is started
there. An instance names the **log** it references and how the session is run; the transcript itself is
machine state and lives outside this repository, under \`~/.heddle/sessions\`.

The tree does not draw this folder. It shows each session directly under the branch, first, because the
folder is a filing decision rather than something to navigate — and the branch is what a person is looking
for, not the drawer the session is kept in.
`

/** Create a branch's `_sessions_` folder and its entry point when they are not there yet. */
export function ensureSessionsFolder(branch: string): string {
  const dir = join(canonicalPath(branch), SESSIONS_FOLDER)
  mkdirSync(dir, { recursive: true })
  const index = join(dir, 'INDEX.md')
  if (!existsSync(index)) writeFileSync(index, SESSIONS_INDEX)
  return dir
}

/**
 * Write a session's definition under a branch, and answer with where it went.
 *
 * `taken` is the list of names already in the branch's `_sessions_` folder, so two sessions created in one
 * minute do not collide. The log is never touched: this writes the two small files and nothing else, which
 * is what keeps the definition safe to commit while the log is not.
 */
export function writeSessionDefinition(
  handle: SessionHandle,
  branch: string,
  options: { readonly createdAt: string; readonly title?: string; readonly endpoint?: string; readonly model?: string; readonly reasoningEffort?: string; readonly taken?: readonly string[] } ,
): SessionDefinition {
  const canonical = canonicalPath(branch)
  const name = sessionName(new Date(options.createdAt), options.taken ?? [])
  const dir = join(ensureSessionsFolder(canonical), name)
  mkdirSync(dir, { recursive: true })

  /** The store's rule for a title (`./title-text.ts`), so the definition and the record name the session alike. */
  const title = options.title === undefined ? '' : normalizeSessionTitle(options.title)
  const fields: SessionDefinitionFields = {
    id: handle.id,
    log: handle.transcript,
    cwd: canonical,
    createdAt: options.createdAt,
    ...(title.length > 0 ? { title } : {}),
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
  }
  writeFileSync(join(dir, DEFINITION_FILE), `${JSON.stringify(fields, null, 2)}\n`)
  writeFileSync(join(dir, 'INDEX.md'), indexFor(name, canonical, fields))
  return { name, dir, file: join(dir, DEFINITION_FILE), log: handle.transcript }
}

/** The session names a branch already holds, so a new one does not take an existing folder's name. */
export function existingSessionNames(branch: string): string[] {
  try {
    return readdirSync(join(canonicalPath(branch), SESSIONS_FOLDER), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** What a definition says, read back from disk; `null` when there is none or it is not readable. */
export function readSessionDefinition(dir: string): SessionDefinitionFields | null {
  try {
    const fields = JSON.parse(readFileSync(join(dir, DEFINITION_FILE), 'utf8')) as SessionDefinitionFields
    if (typeof fields?.id !== 'string' || fields.id.length === 0) return null
    return fields
  } catch {
    return null
  }
}

/**
 * Retitle a definition, so the tracked record and the label a person reads do not disagree.
 *
 * A session's title is a label rather than a fact about the run, which is why the log is never touched; the
 * definition file is the other half of that reasoning — it *is* the place a session's name is written down for
 * a reader of the repository, so a rename that stopped at the store would leave a committed record calling the
 * session something else.
 */
export function updateSessionDefinition(dir: string, patch: { readonly title?: string | undefined }): boolean {
  const current = readSessionDefinition(dir)
  if (current === null) return false
  const next: SessionDefinitionFields = { ...current }
  if (patch.title !== undefined) {
    /** Cleaned as the store cleans a rename (`./title-text.ts`); nothing visible left deletes the key. */
    const trimmed = normalizeSessionTitle(patch.title)
    if (trimmed.length === 0) delete (next as { title?: string }).title
    else (next as { title?: string }).title = trimmed
  }
  writeFileSync(join(dir, DEFINITION_FILE), `${JSON.stringify(next, null, 2)}\n`)
  return true
}
