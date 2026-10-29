import type { GenerateRequest, Message } from '../llm/types.ts'

/**
 * The guidance a request carries while its session is in plan mode — DSH's `plan:policy` section, verbatim from the
 * `plan-mode` row of its base profile (`dsh-base/cordis.patch.yml`), read 2026-10-29.
 *
 * Plan mode is **guidance, not enforcement**, in DSH and here: no tool is removed or blocked, because the tool catalog
 * stays the same across modes for request-cache stability. What stops an edit is this text, then the sandbox and the
 * approval policy, exactly as in DSH.
 */
export const PLAN_POLICY_SECTION = `You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed only to keep the request shape stable. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`

/**
 * The request with the plan-mode section added as a system message, after the system messages it already opens with.
 *
 * A separate message rather than an edit of the deployment's own system prompt, so the prompt the session recorded is
 * never rewritten, and every adapter already knows how to carry several system messages (the Anthropic shapes join
 * them into one top-level `system`; the OpenAI shapes send them in order).
 */
export function withPlanPolicy(request: GenerateRequest, section: string = PLAN_POLICY_SECTION): GenerateRequest {
  const policy: Message = { role: 'system', content: [{ type: 'text', text: section }] }
  let at = 0
  while (at < request.messages.length && request.messages[at]?.role === 'system') at += 1
  return { ...request, messages: [...request.messages.slice(0, at), policy, ...request.messages.slice(at)] }
}
