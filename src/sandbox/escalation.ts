import type { SandboxMode } from './policy.ts'

/**
 * The escalation ladder: how one call may ask for a wider mode, and how that ask is approved.
 *
 * DSH's vocabulary, ported: a denied call may be retried **once** at a strictly wider mode with a one-sentence
 * justification, and the retry is approved by a person before it executes. The ladder is checked at execution,
 * never baked into a tool schema — schemas are registry-global while the effective mode is per-call truth.
 */

/** The strictly-wider table: what a call whose effective mode is the key may escalate to. */
export const WIDER_MODES: Record<SandboxMode, readonly SandboxMode[]> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
  'danger-full-access': [],
}

/**
 * Every mode a call could ever escalate **to**. Advertised whenever the composition confines: cutting the enum down
 * to the modes wider than the deployment default would strand a session whose own mode sits below it.
 */
export const ESCALATION_TARGETS = ['workspace-write', 'danger-full-access'] as const

/** The closed outcome vocabulary of one approval ask, structurally DSH's `ApprovalOutcome`. */
export type EscalationOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * Validate the argument pairing a tool schema cannot express: `sandbox_permissions` and `justification` travel
 * together — an approval prompt without a reason, or a reason driving nothing, is a malformed ask — and the
 * justification must be a non-empty sentence.
 */
export function validateEscalationArgs(permissions: unknown, justification: unknown): void {
  if (permissions !== undefined && justification === undefined) throw new Error('invalid escalation: sandbox_permissions requires a justification')
  if (justification !== undefined && permissions === undefined) throw new Error('invalid escalation: justification is only valid together with sandbox_permissions')
  if (justification !== undefined && (typeof justification !== 'string' || justification.trim().length === 0)) {
    throw new Error('invalid justification: expected a non-empty sentence')
  }
}

/** Why an escalation did not happen, with a stable code so a caller can report rather than guess. */
export class EscalationRefusal extends Error {
  readonly code: 'MALFORMED' | 'NOT_WIDER' | 'REJECTED' | 'CANCELLED' | 'UNAVAILABLE'

  constructor(code: EscalationRefusal['code'], message: string) {
    super(message)
    this.name = 'EscalationRefusal'
    this.code = code
  }
}

/** What one escalation request is judged on. */
export interface EscalationRequest {
  readonly tool: string
  /** The raw schema value, judged here rather than trusted. */
  readonly requestedMode: unknown
  readonly effectiveMode: SandboxMode
  readonly justification: unknown
  /** The family's noun for the escalated action: `command` for a shell, `operation` for a file mutation. */
  readonly subject: 'command' | 'operation'
  readonly session?: string
  /**
   * The call's own abort signal, so a Stop settles the question instead of waiting out its timeout.
   *
   * DSH's approval service (`dsh-user-approval`, `decide`) returns `cancelled` when the request's signal aborts, and
   * starts cancelled when it already is; heddle's service handles the signal but the escalation never passed one,
   * which left a Stop unable to end a turn waiting on a card.
   */
  readonly signal?: AbortSignal
}

/** The minimal approval channel the escalation needs; the tool layer supplies the real service behind it. */
export interface EscalationApproval {
  request(options: {
    readonly tool: string
    readonly reason: string
    readonly displayReason: string
    readonly session?: string
    readonly signal?: AbortSignal
  }): Promise<EscalationOutcome>
}

/** The refusal sentences a person and the model read, in DSH's shape. */
function refusalFor(outcome: Exclude<EscalationOutcome, 'allowed-once'>, mode: SandboxMode, effective: SandboxMode): EscalationRefusal {
  const code = outcome === 'rejected' ? 'REJECTED' : outcome === 'cancelled' ? 'CANCELLED' : 'UNAVAILABLE'
  const sentence =
    outcome === 'rejected'
      ? `the request to run this ${'%subject%'} with '${mode}' permissions was rejected; the call stays under '${effective}'`
      : outcome === 'cancelled'
        ? `the request to run this %subject% with '${mode}' permissions was cancelled; the call stays under '${effective}'`
        : `no one can approve running this %subject% with '${mode}' permissions on this run; the call stays under '${effective}'`
  return new EscalationRefusal(code, sentence)
}

/**
 * Resolve one escalation before anything executes.
 *
 * - repeating the call's effective mode is allowed **without** approval (it is the same boundary);
 * - a mode that is not strictly wider is refused;
 * - a wider mode asks a person: `allowed-once` grants exactly this call, anything else refuses it.
 *
 * Nothing here executes anything, and the returned mode is the caller's per-call policy — the session's own mode is
 * untouched. That is what "one approved wider retry" means.
 */
export async function approveEscalation(request: EscalationRequest, approval: EscalationApproval): Promise<SandboxMode> {
  const requested = request.requestedMode
  if (typeof requested !== 'string' || !(requested in WIDER_MODES)) {
    throw new EscalationRefusal('MALFORMED', `'${String(requested)}' is not a sandbox mode that a call can escalate to`)
  }
  const target = requested as SandboxMode
  if (target === request.effectiveMode) return target
  if (!(WIDER_MODES[request.effectiveMode] ?? []).includes(target)) {
    throw new EscalationRefusal(
      'NOT_WIDER',
      `an escalation to '${target}' is not strictly wider than this call's '${request.effectiveMode}' mode`,
    )
  }
  const outcome = await approval.request({
    tool: request.tool,
    reason: `escalate sandbox to ${target}: ${String(request.justification)}`,
    displayReason: `Allow this ${request.subject} with ${target} permissions: ${String(request.justification)}`,
    ...(request.session !== undefined ? { session: request.session } : {}),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
  })
  if (outcome === 'allowed-once') return target
  const refusal = refusalFor(outcome, target, request.effectiveMode)
  refusal.message = refusal.message.replaceAll('%subject%', request.subject)
  throw refusal
}
