/**
 * Tool-argument validation, DSH's: a call's arguments are checked against the tool's declared parameter schema
 * before it runs, and a violation is an `INVALID_ARGS` result (`invalid arguments: <violations>`), never a crash.
 *
 * Ported from `dsh-tools`' `validateJsonSchemaValue` (read 2026-10-29), sentence for sentence, so a model sees
 * the same refusal from either harness:
 *
 * - the root is the call's arguments object, named `arguments` in a sentence; a property path is `key` at the
 *   root and `parent.key` below it, an array item `path[index]`;
 * - an object reports its missing required properties first, then each present declared property in
 *   declaration order, then — only where the schema says `additionalProperties: false` — each undeclared key;
 * - an unknown **top-level** key passes, because DSH's tool roots are open (`defineTool` compiles the root with
 *   no `additionalProperties`). R-developer-five-6, coordinator ruling (a).
 */

/** The JSON Schema subset tool parameters use (DSH's enforced subset). */
export interface ParameterSchema {
  readonly type?: string
  readonly properties?: Readonly<Record<string, ParameterSchema>>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
  readonly items?: ParameterSchema
  readonly enum?: readonly unknown[]
  readonly const?: unknown
  readonly oneOf?: readonly ParameterSchema[]
}

const named = (path: string): string => (path === '' ? 'arguments' : path)
const below = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`)

function scalar(schema: ParameterSchema, value: unknown, path: string): string[] {
  if (schema.enum !== undefined && !schema.enum.includes(value)) return [`"${named(path)}" must be one of ${JSON.stringify(schema.enum)}`]
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return [`"${named(path)}" must be ${JSON.stringify(schema.const)}`]
  return []
}

/** Every way `value` breaks `schema`, in DSH's order; empty when it is valid. */
export function argumentViolations(schema: ParameterSchema, value: unknown, path = ''): string[] {
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((branch) => argumentViolations(branch, value, path).length === 0).length
    return matches === 1 ? [] : [`"${named(path)}" must match exactly one oneOf branch (matched ${matches})`]
  }
  switch (schema.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`"${named(path)}" must be an object`]
      const record = value as Record<string, unknown>
      const properties = schema.properties ?? {}
      const violations: string[] = []
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(record, key) || record[key] === undefined) violations.push(`missing required property "${below(path, key)}"`)
      }
      for (const [key, node] of Object.entries(properties)) {
        if (!Object.hasOwn(record, key) || record[key] === undefined) continue
        violations.push(...argumentViolations(node, record[key], below(path, key)))
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (!Object.hasOwn(properties, key)) violations.push(`"${below(path, key)}" is not a declared property (additionalProperties: false)`)
        }
      }
      return violations
    }
    case 'array': {
      if (!Array.isArray(value)) return [`"${named(path)}" must be an array`]
      const items = schema.items
      if (items === undefined) return []
      return value.flatMap((entry, index) => argumentViolations(items, entry, `${path}[${index}]`))
    }
    case 'string':
      return typeof value === 'string' ? scalar(schema, value, path) : [`"${named(path)}" must be a string`]
    case 'number':
      if (typeof value !== 'number') return [`"${named(path)}" must be a number`]
      return Number.isFinite(value) ? scalar(schema, value, path) : [`"${named(path)}" must be a finite JSON number`]
    case 'integer':
      return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) ? scalar(schema, value, path) : [`"${named(path)}" must be an integer`]
    case 'boolean':
      return typeof value === 'boolean' ? scalar(schema, value, path) : [`"${named(path)}" must be a boolean`]
    case 'null':
      return value === null ? scalar(schema, value, path) : [`"${named(path)}" must be null`]
    default:
      return []
  }
}

/** The refusal's sentence, DSH's `ToolArgsError` message. */
export function invalidArguments(violations: readonly string[]): string {
  return `invalid arguments: ${violations.join('; ')}`
}

/**
 * A tool's parameter schema as DSH shapes a root: open. `defineTool` compiles the root with no
 * `additionalProperties`, so an unknown top-level key is accepted; a nested node keeps what it declares. Applied
 * where a schema leaves the registry (what the model is shown) and where a call is validated, so a tool's own
 * spec — which may still say `additionalProperties: false` at its root — never has to change.
 */
export function openRoot(parameters: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (!Object.hasOwn(parameters, 'additionalProperties')) return { ...parameters }
  const { additionalProperties: _closed, ...open } = parameters
  return open
}
