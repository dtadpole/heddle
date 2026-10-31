import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isSerializedSchema, normalizeProjection, type SerializedSchema } from './form-projection.ts'
import { findSchema } from './validate.ts'

/**
 * The built-in rows' form projections, generated from their TypeScript `Config`s for the Rust build (issue #123).
 *
 * The Rust binary has no Schemastery, so it could not serialize a row's schema the way DSH's settings view does. This
 * module writes the TypeScript build's normalized projections (`form-projection.ts`) for every built-in the Rust
 * catalog knows into `rust/crates/heddle-config/src/builtin_forms.json`, which `heddle-config` embeds and serves. The
 * TypeScript schemas stay the one source; `test/builtin-forms.test.ts` fails when the file and the schemas disagree.
 *
 * A default the schema computes from the environment (the session root, the workspaces file) is written with the
 * placeholder `$HEDDLE_HOME`, and each build serves it resolved against its own `HEDDLE_HOME`, so no machine path is
 * committed and both builds answer the same bytes.
 *
 * Run: `HEDDLE_HOME='$HEDDLE_HOME' node src/config/builtin-forms.ts --write`.
 */

/** The Rust catalog's built-in modules (`BUILTINS` in rust/crates/heddle/src/builtins.rs), by their module path. */
export const BUILTIN_MODULES = [
  'plugins/console-exporter',
  'plugins/greeting',
  'plugins/announce',
  'plugins/session',
  'plugins/model',
  'context/service',
  'workspace/service',
  'sandbox/service',
  'approvals/service',
  'goal/service',
  'plugins/goal-driver',
  'plugins/goal-tool',
  'plugins/subagent-tool',
  'todo/service',
  'plugins/todo-tool',
  'plugins/turns',
  'plugins/locale',
  'plugins/ui-theme',
  'plugins/presets',
  'plugins/team',
  'plugins/schedule',
  'plugins/jobs',
  'plugins/tools',
] as const

/** The placeholder a home-derived default is written with. */
export const HEDDLE_HOME_PLACEHOLDER = '$HEDDLE_HOME'

/** Every built-in's normalized projection, by module; a module without a `Config` is absent. */
export async function builtinForms(): Promise<Record<string, SerializedSchema>> {
  const forms: Record<string, SerializedSchema> = {}
  for (const module of BUILTIN_MODULES) {
    const loaded = (await import(`../${module}.ts`)) as Record<string, unknown>
    const schema = findSchema(loaded) as { toJSON?: () => unknown } | undefined
    const serialized = typeof schema?.toJSON === 'function' ? schema.toJSON() : undefined
    if (isSerializedSchema(serialized)) forms[module] = normalizeProjection(serialized)
  }
  return forms
}

/** The file's text: stable key order, two-space indent, a trailing newline. */
export function formsText(forms: Record<string, SerializedSchema>): string {
  return `${JSON.stringify(forms, null, 2)}\n`
}

export const FORMS_FILE = join(import.meta.dirname, '..', '..', 'rust', 'crates', 'heddle-config', 'src', 'builtin_forms.json')

if (process.argv.includes('--write')) {
  if (process.env.HEDDLE_HOME !== HEDDLE_HOME_PLACEHOLDER) {
    process.stderr.write(`run with HEDDLE_HOME='${HEDDLE_HOME_PLACEHOLDER}', so home-derived defaults are written as the placeholder\n`)
    process.exit(2)
  }
  writeFileSync(FORMS_FILE, formsText(await builtinForms()))
  process.stdout.write(`wrote ${FORMS_FILE}\n`)
}
