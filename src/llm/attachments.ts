import { readFileSync } from 'node:fs'

import type { ContentPart, EndpointConfig, FilePart, ImagePart, Message } from './types.ts'

/**
 * The attachment projection: what a provider is actually sent for an attached file.
 *
 * DSH's rules, measured from its packages rather than invented here:
 *
 * - a **non-image file never reaches a provider**; request assembly replaces it with a deterministic
 *   handle naming the file, its byte size, its sha256 prefix and the read-only path it was saved at, with
 *   the instruction to read that path with the file tools;
 * - an **image** is sent as image content only to a route that declares image input; otherwise it is
 *   replaced with a deterministic placeholder saying the model accepts text only and naming the
 *   attachment's sha256 prefix;
 * - the replacement is stable text, so the same attachment reads the same way on every request and a
 *   compacted transcript stays legible.
 *
 * The reference in the session log is the durable path the upload store wrote. The bytes are read here,
 * at request time, so the log holds no file content and a large image costs one send, not one log line.
 */

/** The media types the projection can send as image content. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** The stable identifier DSH gives an attachment: the `sha256:`-prefixed digest of its bytes. */
export function attachmentId(sha256: string): string {
  return `sha256:${sha256}`
}

/** The eight hex characters DSH's placeholders and handles show next to the attachment identity. */
export function shortDigest(sha256: string): string {
  return sha256.slice(0, 8)
}

/** Whether an endpoint declares that its model accepts image input. */
export function acceptsImages(endpoint: EndpointConfig): boolean {
  return endpoint.inputModalities?.includes('image') === true
}

/** DSH's model-facing handle for one verbatim file. */
export function fileHandleText(part: FilePart): string {
  return (
    `[File ${JSON.stringify(part.name)} (${part.bytes} bytes, sha256:${shortDigest(part.sha256)}): ` +
    `verbatim read-only copy saved at ${JSON.stringify(part.path)}. ` +
    'Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. ' +
    'When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]'
  )
}

/** DSH's model-facing placeholder for an image a text-only route cannot accept. */
export function textOnlyImageText(part: ImagePart): string {
  return `[image omitted because this model accepts text only; attachment sha256:${shortDigest(part.sha256)}]`
}

/** What a route is told when an image's saved bytes can no longer be read. */
function unreadableImageText(part: ImagePart, reason: string): string {
  return (
    `[image ${JSON.stringify(part.name)} could not be read at ${JSON.stringify(part.path)} ` +
    `(${reason}); attachment sha256:${shortDigest(part.sha256)}. Ask the person to attach it again if it is needed.]`
  )
}

/** Read one stored image and attach its base64 bytes for the adapter, degrading to text on failure. */
function materializeImage(part: ImagePart): ImagePart | { readonly type: 'text'; readonly text: string } {
  try {
    const bytes = readFileSync(part.path)
    return { ...part, data: bytes.toString('base64') }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { type: 'text', text: unreadableImageText(part, reason) }
  }
}

/** Project one content part for the provider boundary. */
function projectPart(part: ContentPart, endpoint: EndpointConfig): ContentPart {
  if (part.type === 'file') return { type: 'text', text: fileHandleText(part) }
  if (part.type === 'image' && part.data === undefined) {
    return acceptsImages(endpoint) ? materializeImage(part) : { type: 'text', text: textOnlyImageText(part) }
  }
  return part
}

/**
 * Project every message's content for one endpoint.
 *
 * Applied after the `model/request` waterfall (so a listener sees the message as it was recorded) and
 * before the adapter (so no adapter sees a `file` part or gets image bytes a route cannot take).
 */
export function projectAttachments(messages: readonly Message[], endpoint: EndpointConfig): readonly Message[] {
  let changed = false
  const projected = messages.map((message) => {
    const content = message.content.map((part) => {
      const next = projectPart(part, endpoint)
      if (next !== part) changed = true
      return next
    })
    return content.some((part, index) => part !== message.content[index]) ? { ...message, content } : message
  })
  return changed ? projected : messages
}
