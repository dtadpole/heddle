/**
 * The two failures the schedule subsystem raises, with DSH's names and codes.
 *
 * Read as `dsh-schedule/lib/index.js` lines 33-60. The split matters to every caller:
 *
 * - a {@link ScheduleInputError} is a **model- or person-supplied value** that cannot become a record. Its code and
 *   message are public: the tools hand them back verbatim as `{code, message}`, which is what the model reads;
 * - a {@link ScheduleLogError} is **stored data** that is malformed or contradicts an invariant. It is never shown
 *   to a model as such — the tools withhold it behind `internal_error`, and the store refuses to open over it.
 *
 * Kept in its own module because every other schedule module raises one of them, and the lowest layer (time) must
 * not import the rules that build on it.
 */

/** The public codes a {@link ScheduleInputError} carries, as DSH publishes them (TOOL:175-185). */
export type ScheduleErrorCode =
  | 'invalid_prompt'
  | 'invalid_selector'
  | 'invalid_rule'
  | 'invalid_time_zone'
  | 'not_future'
  | 'time_out_of_range'
  | 'frequency_too_high'
  | 'subagent_session'
  | 'internal_error'

/** A supplied rule, selector or target session that cannot become a schedule record. */
export class ScheduleInputError extends Error {
  /** Stable public discriminator; a caller switches on this, not on the sentence. */
  readonly code: ScheduleErrorCode

  constructor(code: ScheduleErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = 'ScheduleInputError'
    this.code = code
  }
}

/** Durable schedule data that is malformed or violates an invariant. */
export class ScheduleLogError extends Error {
  /** DSH's code for the whole family. */
  readonly code = 'corrupt_schedule_log'

  constructor(message: string) {
    super(message)
    this.name = 'ScheduleLogError'
  }
}
