import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The local endpoint configuration, and the rule that keeps it out of git.
 *
 * Endpoint URLs, model names and anything credential-shaped belong to the
 * **machine**, not to the repository: a project that commits them either leaks a
 * secret or forces every other user to edit tracked files to run at all. So this
 * file is read from outside the checkout, first match wins:
 *
 * 1. `$HEDDLE_CONFIG`
 * 2. `$HEDDLE_HOME/heddle.json`
 * 3. `~/.heddle/heddle.json`
 *
 * The shape is deliberately a partial of the model plugin's own config, so the
 * same keys work in either place and a local file can override one endpoint
 * without restating the tree. A file that does not exist is not an error: the
 * defaults in `src/plugins/model.ts` are the offline ones, and a machine with no
 * file still boots.
 *
 * ```json
 * {
 *   "endpoints": {
 *     "plugboard-ds": { "baseUrl": "http://127.0.0.1:8790/ds", "model": "deepseek-flash" }
 *   },
 *   "exclude": ["scripted"]
 * }
 * ```
 */
export interface LocalConfig {
  /** Per-endpoint overrides, addressed by endpoint name. */
  readonly endpoints?: Record<string, unknown>
  /** The endpoint a run uses when nothing else says. */
  readonly default?: string
  /**
   * Names this machine does not want in its endpoint list at all.
   *
   * The repository ships offline defaults so a fresh clone runs its checks; a person who only wants their own
   * gateways says so here. Applied after every layer, so it can also hide an endpoint this same file declares.
   */
  readonly exclude?: readonly string[]
  /** Anything else the caller wants to read; passed through untouched. */
  readonly [key: string]: unknown
}

/** Where the local configuration was found, or `null` when there is none. */
export interface LocalConfigLocation {
  readonly path: string
  readonly config: LocalConfig
}

/** Candidate paths, in precedence order. */
export function localConfigCandidates(home = homedir()): readonly string[] {
  const candidates: string[] = []
  if (process.env.HEDDLE_CONFIG) candidates.push(process.env.HEDDLE_CONFIG)
  const heddleHome = process.env.HEDDLE_HOME ?? join(home, '.heddle')
  candidates.push(join(heddleHome, 'heddle.json'))
  return candidates
}

/**
 * Read the first local configuration that exists.
 *
 * A malformed file **fails loudly** rather than being ignored: silently falling
 * back to offline defaults because a file has a trailing comma would present
 * itself as "the real backend is broken", which is the wrong diagnosis to send
 * someone to.
 */
export function readLocalConfig(candidates: readonly string[] = localConfigCandidates()): LocalConfigLocation | null {
  for (const path of candidates) {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`${path}: not valid JSON — ${(error as Error).message}`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${path}: expected a JSON object at the top level`)
    }
    return { path, config: parsed as LocalConfig }
  }
  return null
}
