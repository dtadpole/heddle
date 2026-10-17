import { renderCode } from './code.ts'
import { escapeHtml } from './markdown.ts'
import { schemaFor, type ToolSchema } from './tool-catalog.ts'

/**
 * What a tool row's inspector shows, rendered on the server with the renderers that are already tested.
 *
 * DSH's inspector renders the payload and the schema parameters as JSON (a json-tree component) and the
 * result as a monospace block. Heddle has no second renderer to write: `renderCode(..., 'json')` already
 * escapes every byte and highlights it, and its escaping is judged by the unit suite. This module turns one
 * tool row into those three blocks, purely, so the page only inserts markup it did not build.
 */
export interface ToolInspection {
  /** The arguments, highlighted JSON when they parse. */
  readonly payload: string
  readonly payloadIsJson: boolean
  /** The result, as an escaped block; an error is marked so it can be tinted. */
  readonly result: string
  readonly resultIsError: boolean
  /** The tool's definition, when the profile declares it. */
  readonly schema?: {
    readonly name: string
    readonly description: string
    /** The parameter JSON Schema, highlighted. */
    readonly parameters: string
  }
}

/** JSON as JSON when it parses, escaped text otherwise — arguments are not always valid JSON. */
export function renderPayload(text: string): { readonly html: string; readonly isJson: boolean } {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      return { html: renderCode(JSON.stringify(parsed, null, 2), 'json', { gutter: false }), isJson: true }
    } catch {
      // A partial or provider-shaped payload: show it as text rather than pretending it is JSON.
    }
  }
  return { html: `<pre class="tr-plain">${escapeHtml(text)}</pre>`, isJson: false }
}

/** One tool row's inspector content. */
export function inspectTool(
  input: { readonly payload: string; readonly result: string; readonly name?: string; readonly error?: boolean },
  catalog: readonly ToolSchema[],
): ToolInspection {
  const payload = renderPayload(input.payload)
  const result = `<pre class="tr-result-text${input.error === true ? ' tr-error-text' : ''}">${escapeHtml(input.result)}</pre>`
  const tool = input.name === undefined ? undefined : schemaFor(catalog, input.name)
  return {
    payload: payload.html,
    payloadIsJson: payload.isJson,
    result,
    resultIsError: input.error === true,
    ...(tool !== undefined
      ? {
          schema: {
            name: tool.name,
            description: tool.description,
            parameters: renderCode(JSON.stringify(tool.parameters, null, 2), 'json', { gutter: false }),
          },
        }
      : {}),
  }
}
