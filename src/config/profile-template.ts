import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { ConfigError, profilesDir, resolveProfile, type ProfileInfo } from './schema.ts'

/**
 * Profile templates: DSH's `--profile <name> --from-default-profile <template>` replaces a custom profile with a fresh
 * copy of a shipped template, then boots it. heddle ships one template, `default`: the checkout's own tree
 * (`cordis.yml` and `heddle.patch.yml`), with every relative row name made absolute so the profile boots from any
 * directory. The Rust port's `heddle-config` `reset_profile_from_template` writes the same files.
 *
 * Only `$HEDDLE_HOME/profiles/<name>` is touched, and only for a plain name. The fresh copy is written beside it and
 * renamed into place, so an interrupted reset leaves either the old profile or the new one, never half of each.
 */

/** The templates heddle ships. */
export const PROFILE_TEMPLATES: readonly string[] = ['default']

/** The files template `default` holds, from `checkout`: the base as written, the patch with absolute row names. */
export function templateFiles(checkout: string): Readonly<Record<string, string>> {
  const root = resolve(checkout)
  const read = (file: string) => {
    try {
      return readFileSync(join(root, file), 'utf8')
    } catch (error) {
      throw new ConfigError([`the default profile template reads ${join(root, file)}: ${(error as Error).message}`])
    }
  }
  return {
    'cordis.yml': read('cordis.yml'),
    'heddle.patch.yml': read('heddle.patch.yml').replace(/^(\s*(?:-\s+)?name:\s*)\.\//gm, `$1${root}/`),
  }
}

/** Replace profile `name` with a fresh copy of `template`, and answer the profile as `resolveProfile` reads it. */
export function resetProfileFromTemplate(
  name: string,
  template: string,
  options: { readonly checkout: string; readonly env?: NodeJS.ProcessEnv },
): ProfileInfo {
  const env = options.env ?? process.env
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new ConfigError([`--from-default-profile names a profile by a plain name, not '${name}'`])
  }
  if (!PROFILE_TEMPLATES.includes(template)) {
    throw new ConfigError([`unknown profile template '${template}'; heddle ships: ${PROFILE_TEMPLATES.join(', ')}`])
  }
  const files = templateFiles(options.checkout)
  const root = profilesDir(env)
  mkdirSync(root, { recursive: true })
  const dir = join(root, name)
  const staging = join(root, `.${name}.template-${process.pid}`)
  const replaced = join(root, `.${name}.replaced-${process.pid}`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging)
  for (const [file, text] of Object.entries(files)) writeFileSync(join(staging, file), text)
  if (existsSync(dir)) renameSync(dir, replaced)
  renameSync(staging, dir)
  rmSync(replaced, { recursive: true, force: true })
  return resolveProfile(name, env)
}
