import type { ToolSpec } from '../llm/types.ts'

/**
 * The profile's tool catalog, as the Trajectory details pane shows it.
 *
 * DSH's tool inspector has a **Schema** section beside the payload and the result: the tool's name, what
 * it says it does, and the JSON Schema its arguments must satisfy. Heddle already holds that in the tool
 * service (`describe()`); this module shapes it for the view, and is pure so the shaping can be judged.
 */

/** One tool's definition, as a view shows it. */
export interface ToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
}

/**
 * A stable, de-duplicated catalog.
 *
 * Sorted by name because the details pane looks a tool up by name and a reader scanning the pane should
 * find it where it would expect to; the **first** definition of a name wins, because that is the one the
 * tool service registered and therefore the one the model was offered.
 */
export function catalogOf(specs: readonly ToolSpec[]): readonly ToolSchema[] {
  const byName = new Map<string, ToolSchema>()
  for (const spec of specs) {
    if (byName.has(spec.name)) continue
    byName.set(spec.name, { name: spec.name, description: spec.description, parameters: spec.parameters ?? {} })
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/** The definition of one tool, or `undefined` when the profile does not offer it. */
export function schemaFor(catalog: readonly ToolSchema[], name: string): ToolSchema | undefined {
  return catalog.find((tool) => tool.name === name)
}
