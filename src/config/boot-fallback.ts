import { compose, type ComposedRow, type NamedLayer } from './schema.ts'
import { judgeRow } from './validate.ts'

/**
 * A row the profile patch has broken does not stop the server (issue #213).
 *
 * A row whose configuration its schema or rule refuses fails when it loads, and every row that injects its service
 * waits forever: a patch holding `contextWindow: -5` or `"abc"` left five rows pending and the server exited with "5
 * entr(y/ies) are still pending: …", naming neither the row, the value nor the file. Such a patch comes from a hand
 * edit, from a build that accepted the value, or from before a rule tightened.
 *
 * DSH keeps the running configuration when a written value is bad and refuses only Save, and #165 settled the same for
 * an unreadable patch. So before the tree loads, each enabled row is judged as `config --validate` judges it. A refused
 * row whose configuration the settings target (the profile patch Settings writes) contributes to runs on its
 * configuration composed without Settings' block in that patch — the value Reset restores — when that one passes;
 * Settings still shows the block's value, a Save validates the whole candidate, and Reset removes it. Every refused row gets one note naming it, the problem and the
 * file, whether or not it could fall back. heddle-config's `boot_fallback.rs` is the twin.
 */

/** What boot runs: the rows, some of them on the value beneath the patch, and one note per refused row. */
export interface BootFallback {
  readonly rows: readonly ComposedRow[]
  readonly notes: readonly string[]
}

/** The file a refused row's configuration came from: the target when it wrote any of the row's config, else the last writer. */
function configFile(row: ComposedRow, target: string | undefined): string | undefined {
  const config = row.fields.filter((field) => field.field === 'config' || field.field.startsWith('config.'))
  if (target !== undefined && config.some((field) => field.file === target)) return target
  return config.at(-1)?.file
}

/**
 * Judge `rows` (composed from `layers`) and fall back where Settings' block broke a row.
 *
 * `beneath` is `layers` with the settings target's block taken out (`layersBeneathSettings`), and `targetFile` that
 * target's path; with either absent no row falls back, and each refused row is only named.
 */
export async function bootFallback(
  layers: readonly NamedLayer[],
  rows: readonly ComposedRow[],
  beneath: readonly NamedLayer[] | undefined,
  targetFile: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<BootFallback> {
  let under: readonly ComposedRow[] | null | undefined
  const out: ComposedRow[] = []
  const notes: string[] = []
  for (const composed of rows) {
    const judged = await judgeRow(composed.row, layers)
    // A row that could not be judged (a module that does not import) fails as it always has, and the loader says why.
    if (!judged.checked || judged.problems.length === 0) {
      out.push(composed)
      continue
    }
    const file = configFile(composed, targetFile)
    const said = judged.problems.join('; ')
    if (beneath !== undefined && targetFile !== undefined && file === targetFile) {
      if (under === undefined) {
        try {
          under = compose(beneath, env)
        } catch {
          under = null
        }
      }
      const label = composed.row.id ?? composed.row.name
      const fallback = under?.find((candidate) => (candidate.row.id ?? candidate.row.name) === label)
      if (fallback !== undefined && (await judgeRow(fallback.row, beneath)).problems.length === 0) {
        const { config: _broken, ...rest } = composed.row
        out.push({ ...composed, row: fallback.row.config === undefined ? rest : { ...rest, config: fallback.row.config } })
        notes.push(`heddle: ${said} (in ${file}); this run uses the value beneath it until Settings saves or resets it`)
        continue
      }
    }
    out.push(composed)
    notes.push(`heddle: ${said}${file !== undefined ? ` (in ${file})` : ''}; fix it in the file or run \`heddle config --validate\``)
  }
  return { rows: out, notes }
}
