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
 * The shape the repair builds is the one the provider reads as adjacent: each assistant `tool_calls` message is
 * followed by its answers, in call order. Real answers are **moved** into place rather than replaced — a steering
 * message appended between a call and its result is how a real log legitimately holds that pair apart — so a call
 * with an answer keeps its output; only a call with no answer anywhere becomes `error (INTERRUPTED)`. Answers whose
 * call is absent from the surface are dropped (the mirror-image invalid shape) and a duplicate answer is dropped
 * too. The input is returned itself when it was already valid.
 */
export function repairToolPairing(messages: readonly Message[]): readonly Message[] {
  /** The first stored answer per call id, wherever it sits in the list. */
  const answers = new Map<string, Message>()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    const id = message.toolCallId
    if (id !== undefined && !answers.has(id)) answers.set(id, message)
  }

  const repaired: Message[] = []
  const placed = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool') {
      /** An answer is emitted beside the call it belongs to below; here it is a duplicate or an orphan. */
      continue
    }
    repaired.push(message)
    if (message.role !== 'assistant') continue
    const calls = message.content.filter((part) => part.type === 'tool-call')
    for (const call of calls) {
      if (placed.has(call.id)) continue
      placed.add(call.id)
      const answer = answers.get(call.id)
      repaired.push(
        answer ?? {
          role: 'tool',
          toolCallId: call.id,
          content: [{ type: 'text', text: 'error (INTERRUPTED): the turn ended before this call answered' }],
        },
      )
    }
  }

  /** Already valid: same messages, same order, nothing added or moved. */
  if (repaired.length === messages.length && repaired.every((message, index) => message === messages[index])) {
    return messages
  }
  return repaired
}
