import type { Message } from '../llm/types.ts'

/**
 * Tool-pair pairing over the messages a request will carry.
 *
 * A provider refuses a request whose assistant `tool_calls` message is not followed by one tool message per call —
 * "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'" — and
 * a turn that was stopped (or whose tool threw) between the call and its answer leaves exactly that shape in the
 * log. DSH keeps its surface balanced by construction (`dsh-compaction`'s tool-pairing: compaction only cuts where
 * no call is unanswered), and heddle now closes the calls when it unwinds; this is the **repair** for a log that was
 * already written broken before either rule existed, so an affected session can answer again instead of failing
 * every request with a 400.
 *
 * The repair is deterministic and request-local: the log is left as it is, the missing answers are inserted where
 * the provider expects them, and an answer whose call is not on the surface is dropped (a tool message with no
 * preceding call is the mirror-image invalid shape).
 */
export function repairToolPairing(messages: readonly Message[]): readonly Message[] {
  const repaired: Message[] = []
  /** Call ids whose answer the provider is still owed. */
  const awaiting = new Map<string, string>()
  let changed = false
  const settle = (): void => {
    for (const [id] of awaiting) {
      repaired.push({
        role: 'tool',
        toolCallId: id,
        content: [{ type: 'text', text: 'error (INTERRUPTED): the turn ended before this call answered' }],
      })
      changed = true
    }
    awaiting.clear()
  }

  for (const message of messages) {
    if (message.role === 'tool') {
      const id = message.toolCallId
      /** An answer without its question is not sendable; the question it answered was cut or never written. */
      if (id === undefined || !awaiting.has(id)) {
        changed = true
        continue
      }
      awaiting.delete(id)
      repaired.push(message)
      continue
    }
    /**
     * Anything that is not a tool answer ends a run of answers: the calls still owed above must be settled before
     * the next turn of the conversation, because the provider reads the pair as adjacent.
     */
    settle()
    repaired.push(message)
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'tool-call') awaiting.set(part.id, part.name)
      }
    }
  }
  settle()
  return changed ? repaired : messages
}
