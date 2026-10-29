import type { ToolDefinition, ToolResult, ToolRunContext } from '../tools/service.ts'
import { ScheduleInputError } from './errors.ts'
import { MAX_TITLE_LENGTH, MIN_EVERY_INTERVAL_SECONDS, REQUIRED_TITLE_MESSAGE, scheduleView } from './rules.ts'
import type { ScheduleService } from './service.ts'

/**
 * The four model-facing reminder tools, a port of DSH's `dsh-tool-schedule` (TOOL:1-661).
 *
 * `schedule_create`, `schedule_list`, `schedule_update` and `schedule_delete` act on the session of the turn that
 * called them; the model never names a session. Descriptions, parameter schemas, validation order and every
 * `{code, message}` are DSH's, character for character.
 *
 * **How a DSH value becomes a heddle `ToolResult`.** DSH renders every value its tools return — a view, a list, a
 * delete or update receipt, and every `{code, message}` refusal — as one text block `JSON.stringify(value)` with
 * `isError: false`: the refusals are part of each tool's declared output schema, not failures (TOOL:157-268). So they
 * are returned here as `output` with no `error`, which makes the model-visible text byte-identical to DSH's. Setting
 * `error` would have made the loop print `error (code): message` instead of the JSON the model is told to expect.
 * The one genuine failure is DSH's own: arguments that do not match the parameter schema throw `ToolArgsError`
 * (`invalid arguments: …`, code `INVALID_ARGS`), which DSH turns into an `isError` result; that maps to heddle's
 * `error` with the same code and message.
 */

const CREATE_DESCRIPTION =
  'Create a reminder in the current session that delivers prompt when it becomes due. Supply exactly one timing parameter: after_seconds, at, every_seconds, daily, weekly, or cron. Local times that do not exist in the zone are skipped; repeated local times fire once, at the earlier instant. After downtime, a recurring reminder delivers only its latest missed occurrence. Delivery can repeat after a crash.'
const LIST_DESCRIPTION = 'List the active reminders in the current session.'
const DELETE_DESCRIPTION = 'Delete a reminder in the current session, active or inactive. Deletion does not retract a reminder message that is already queued.'
const UPDATE_DESCRIPTION =
  'Change a reminder in place, keeping its id. Supply a new title, prompt, or at most one timing parameter; omitted fields keep their stored values. To change a relative delay, create a new reminder.'
const CREATE_TITLE_DESCRIPTION = `Concise task name in the user's language, at most ${MAX_TITLE_LENGTH} characters. Name only the core action and subject; keep essential target identifiers such as PR numbers and branch names. Do not include execution frequency (e.g. daily, hourly), scheduled dates/times, time zones, task status, or configuration and execution details (e.g. read-only mode, profile-tag filters), even when embedded in the requested or existing title. Do not append parenthetical notes. Put scheduling information in the timing parameters and execution instructions in prompt.`

const TIME_ZONE_DESCRIPTION = 'UTC or IANA Area/Location, for example Asia/Shanghai.'

/** The JSON-Schema subset DSH's tool compiler emits and its validator enforces. */
interface JsonSchema {
  readonly type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  readonly description?: string
  readonly additionalProperties?: boolean
  readonly properties?: Readonly<Record<string, JsonSchema>>
  readonly required?: readonly string[]
  readonly items?: JsonSchema
  readonly oneOf?: readonly JsonSchema[]
}

/**
 * The selector parameters, in DSH's catalog order, as its compiler emits them (TOOL:404-487; TOOLS:686-751): a nested
 * object states `additionalProperties` and carries its own `required`; the key order is type, description,
 * additionalProperties, properties, required.
 */
const SELECTOR_PARAMETERS: Readonly<Record<string, JsonSchema>> = {
  every_seconds: {
    type: 'number',
    description: `Fixed-rate interval in whole seconds, at least ${MIN_EVERY_INTERVAL_SECONDS}, aligned to the creation time; changing it with schedule_update re-aligns it to the save time.`,
  },
  daily: {
    type: 'object',
    description: 'Every day at a local time.',
    additionalProperties: false,
    properties: {
      time: { type: 'string', description: 'HH:mm:ss with optional 1-3 fractional digits, for example 23:00:00.' },
      time_zone: { type: 'string', description: TIME_ZONE_DESCRIPTION },
    },
    required: ['time', 'time_zone'],
  },
  weekly: {
    type: 'object',
    description: 'On the given weekdays at a local time.',
    additionalProperties: false,
    properties: {
      time: { type: 'string', description: 'HH:mm:ss with optional 1-3 fractional digits, for example 09:00:00.' },
      time_zone: { type: 'string', description: TIME_ZONE_DESCRIPTION },
      weekdays: { type: 'array', description: 'ISO weekdays, Monday 1 through Sunday 7, without repetitions.', items: { type: 'integer' } },
    },
    required: ['time', 'time_zone', 'weekdays'],
  },
  cron: {
    type: 'object',
    description: 'Five-field Vixie cron expression in a time zone.',
    additionalProperties: false,
    properties: {
      expression: {
        type: 'string',
        description: 'minute hour day-of-month month day-of-week, for example "*/15 9-17 * * 1-5". When both day fields are restricted, a date matches if either one matches.',
      },
      time_zone: { type: 'string', description: TIME_ZONE_DESCRIPTION },
    },
    required: ['expression', 'time_zone'],
  },
  at: {
    oneOf: [
      { type: 'string' },
      {
        type: 'object',
        additionalProperties: false,
        properties: { date: { type: 'string' }, time: { type: 'string' }, time_zone: { type: 'string' } },
        required: ['date', 'time', 'time_zone'],
      },
    ],
    description: 'Absolute target: an RFC 3339 date-time with offset, or a local date, time, and IANA time_zone.',
  },
}

/** Root schemas: an **open** object — no root `additionalProperties` (TOOLS:802-811) — so the tool refuses unknown keys itself. */
export const CREATE_PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'Reminder content to present when the target becomes due.' },
    title: { type: 'string', description: CREATE_TITLE_DESCRIPTION },
    after_seconds: { type: 'number', description: 'Delay in whole seconds.' },
    ...SELECTOR_PARAMETERS,
  },
  required: ['prompt', 'title'],
}

export const LIST_PARAMETERS: JsonSchema = { type: 'object', properties: {} }

export const UPDATE_PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Schedule id returned by schedule_list.' },
    title: { type: 'string', description: 'New task name; follow the schedule_create title rules.' },
    prompt: { type: 'string', description: 'New reminder content.' },
    ...SELECTOR_PARAMETERS,
  },
  required: ['id'],
}

export const DELETE_PARAMETERS: JsonSchema = {
  type: 'object',
  properties: { id: { type: 'string', description: 'Exact schedule id.' } },
  required: ['id'],
}

const diagnosticPath = (path: string): string => (path === '' ? 'arguments' : path)
const propertyPath = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`)

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate arguments against a schema with DSH's diagnostics (TOOLS:380-521): for an object, missing required
 * properties first, then each declared property's own violations in declaration order, then undeclared keys when
 * `additionalProperties` is false; a `oneOf` must match exactly one branch.
 */
export function validateArgs(schema: JsonSchema, value: unknown, path = ''): string[] {
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((branch) => validateArgs(branch, value, path).length === 0).length
    return matches === 1 ? [] : [`"${diagnosticPath(path)}" must match exactly one oneOf branch (matched ${matches})`]
  }
  switch (schema.type) {
    case 'object': {
      if (!isPlainRecord(value)) return [`"${diagnosticPath(path)}" must be an object`]
      const properties = schema.properties ?? {}
      const violations: string[] = []
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) violations.push(`missing required property "${propertyPath(path, key)}"`)
      }
      for (const [key, child] of Object.entries(properties)) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) continue
        violations.push(...validateArgs(child, value[key], propertyPath(path, key)))
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(properties, key)) violations.push(`"${propertyPath(path, key)}" is not a declared property (additionalProperties: false)`)
        }
      }
      return violations
    }
    case 'array': {
      if (!Array.isArray(value)) return [`"${diagnosticPath(path)}" must be an array`]
      const items = schema.items
      return items === undefined ? [] : (value as unknown[]).flatMap((entry, index) => validateArgs(items, entry, `${path}[${index}]`))
    }
    case 'string':
      return typeof value === 'string' ? [] : [`"${diagnosticPath(path)}" must be a string`]
    case 'number':
      if (typeof value !== 'number') return [`"${diagnosticPath(path)}" must be a number`]
      return Number.isFinite(value) ? [] : [`"${diagnosticPath(path)}" must be a finite JSON number`]
    case 'integer':
      return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) ? [] : [`"${diagnosticPath(path)}" must be an integer`]
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`"${diagnosticPath(path)}" must be a boolean`]
    case 'null':
      return value === null ? [] : [`"${diagnosticPath(path)}" must be null`]
    default:
      return []
  }
}

/** A refusal or failure DSH returns as its value. */
interface CodedValue {
  readonly code: string
  readonly message: string
}

/** The stable value for a failure not safe to expose (TOOL:279-284). */
const INTERNAL_ERROR: CodedValue = { code: 'internal_error', message: 'The schedule operation failed.' }

/** The refusal every tool gives a delegated child (TOOL:299-305). */
const SUBAGENT_CALLER: CodedValue = { code: 'subagent_session', message: 'A delegated subagent cannot use reminders.' }

const CREATE_KEYS = new Set(['prompt', 'title', 'after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron'])
const UPDATE_KEYS = new Set(['id', 'title', 'prompt', 'at', 'every_seconds', 'daily', 'weekly', 'cron'])

/** Translate invalid input; withhold anything else behind `internal_error` (TOOL:286-291). */
function operationError(error: unknown): CodedValue {
  return error instanceof ScheduleInputError ? { code: error.code, message: error.message } : INTERNAL_ERROR
}

/** A DSH value as heddle's result: the JSON the model reads, and the value itself for a caller that wants it. */
function rendered(value: unknown): ToolResult {
  return { output: JSON.stringify(value), data: { schedule: value } }
}

/** DSH's schema failure (TOOLS:812-821, 866-869), as heddle's error. */
function invalidArguments(violations: readonly string[]): ToolResult {
  return { output: '', error: { code: 'INVALID_ARGS', message: `invalid arguments: ${violations.join('; ')}` } }
}

/** The fixed-rate rule the tools check before the service sees it (TOOL:307-317). */
function invalidInterval(everySeconds: unknown): CodedValue | undefined {
  if (everySeconds === undefined) return undefined
  if (typeof everySeconds !== 'number' || !Number.isSafeInteger(everySeconds)) return { code: 'invalid_rule', message: 'every_seconds must be a safe integer.' }
  if (everySeconds < MIN_EVERY_INTERVAL_SECONDS) return { code: 'frequency_too_high', message: `every_seconds must be at least ${MIN_EVERY_INTERVAL_SECONDS}.` }
  return undefined
}

/** The create constraints the open root cannot express, in DSH's order (TOOL:319-341). */
function validateCreateArgs(args: Record<string, unknown>): CodedValue | undefined {
  const selectors = ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron'].filter((key) => args[key] !== undefined).length
  if (Object.keys(args).some((key) => !CREATE_KEYS.has(key)) || selectors !== 1) {
    return { code: 'invalid_selector', message: 'schedule_create accepts exactly one of after_seconds, at, every_seconds, daily, weekly, or cron.' }
  }
  const prompt = args.prompt as string
  const title = args.title as string
  if (prompt.trim().length === 0) return { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' }
  if (title.trim().length === 0) return { code: 'invalid_prompt', message: REQUIRED_TITLE_MESSAGE }
  if (title.trim().length > MAX_TITLE_LENGTH) return { code: 'invalid_prompt', message: `title must be at most ${MAX_TITLE_LENGTH} characters.` }
  const after = args.after_seconds
  if (after !== undefined && (typeof after !== 'number' || !Number.isSafeInteger(after) || after <= 0)) {
    return { code: 'invalid_rule', message: 'after_seconds must be a positive safe integer.' }
  }
  return invalidInterval(args.every_seconds)
}

/** The update constraints, in DSH's order (TOOL:343-376). */
function validateUpdateArgs(args: Record<string, unknown>): CodedValue | undefined {
  const selectors = ['at', 'every_seconds', 'daily', 'weekly', 'cron'].filter((key) => args[key] !== undefined).length
  if (Object.keys(args).some((key) => !UPDATE_KEYS.has(key)) || selectors > 1) {
    return { code: 'invalid_selector', message: 'schedule_update accepts at most one of at, every_seconds, daily, weekly, or cron.' }
  }
  const id = args.id as string
  if (id.length === 0 || id.trim() !== id) return { code: 'invalid_rule', message: 'schedule_update id must be non-empty without surrounding whitespace.' }
  if (selectors === 0 && args.title === undefined && args.prompt === undefined) {
    return { code: 'invalid_selector', message: 'schedule_update needs a new title, prompt, or one of at, every_seconds, daily, weekly, or cron.' }
  }
  const title = args.title as string | undefined
  const prompt = args.prompt as string | undefined
  if (title !== undefined && title.trim().length === 0) return { code: 'invalid_prompt', message: REQUIRED_TITLE_MESSAGE }
  if (title !== undefined && title.trim().length > MAX_TITLE_LENGTH) return { code: 'invalid_prompt', message: `title must be at most ${MAX_TITLE_LENGTH} characters.` }
  if (prompt !== undefined && prompt.trim().length === 0) return { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' }
  return invalidInterval(args.every_seconds)
}

/** The one timing replacement an update carries (TOOL:378-399). */
function timingChangeFrom(args: Record<string, unknown>): Record<string, unknown> | undefined {
  if (args.at !== undefined) return { kind: 'at', at: args.at }
  if (args.every_seconds !== undefined) return { kind: 'every', every_seconds: args.every_seconds }
  if (args.daily !== undefined) return { kind: 'daily', daily: args.daily }
  if (args.weekly !== undefined) return { kind: 'weekly', weekly: args.weekly }
  if (args.cron !== undefined) return { kind: 'cron', cron: args.cron }
  return undefined
}

export interface ScheduleToolOptions {
  /**
   * The delegation depth of a session: above 0 is a delegated child, which cannot use reminders. Heddle records it in
   * the session's metadata (`delegationDepth`), which is DSH's `delegationDepthOf(agent)`.
   */
  readonly delegationDepth: (sessionId: string) => number
}

/** The four reminder tools, bound to one schedule service. */
export function scheduleTools(service: ScheduleService, options: ScheduleToolOptions): ToolDefinition[] {
  /** The calling session, or the value that refuses the call: none is DSH's "no calling agent". */
  const caller = (context: ToolRunContext): { readonly sessionId: string } | { readonly refusal: CodedValue } => {
    if (context.session === undefined) return { refusal: INTERNAL_ERROR }
    if (options.delegationDepth(context.session.id) > 0) return { refusal: SUBAGENT_CALLER }
    return { sessionId: context.session.id }
  }

  return [
    {
      spec: { name: 'schedule_create', description: CREATE_DESCRIPTION, parameters: CREATE_PARAMETERS as Record<string, unknown> },
      run: async (args, context) => {
        const violations = validateArgs(CREATE_PARAMETERS, args)
        if (violations.length > 0) return invalidArguments(violations)
        const resolved = caller(context)
        if ('refusal' in resolved) return rendered(resolved.refusal)
        const invalid = validateCreateArgs(args)
        if (invalid !== undefined) return rendered(invalid)
        if (context.signal?.aborted === true) return rendered(INTERNAL_ERROR)
        try {
          const record = await service.create(resolved.sessionId, args, context.signal)
          return rendered(scheduleView(record, service.now()))
        } catch (error) {
          return rendered(operationError(error))
        }
      },
    },
    {
      spec: { name: 'schedule_list', description: LIST_DESCRIPTION, parameters: LIST_PARAMETERS as Record<string, unknown> },
      run: async (args, context) => {
        const violations = validateArgs(LIST_PARAMETERS, args)
        if (violations.length > 0) return invalidArguments(violations)
        const resolved = caller(context)
        if ('refusal' in resolved) return rendered(resolved.refusal)
        if (context.signal?.aborted === true) return rendered(INTERNAL_ERROR)
        try {
          const records = await service.list({ sessionId: resolved.sessionId })
          const now = service.now()
          return rendered(records.map((record) => scheduleView(record, now)))
        } catch (error) {
          return rendered(operationError(error))
        }
      },
    },
    {
      spec: { name: 'schedule_delete', description: DELETE_DESCRIPTION, parameters: DELETE_PARAMETERS as Record<string, unknown> },
      run: async (args, context) => {
        const violations = validateArgs(DELETE_PARAMETERS, args)
        if (violations.length > 0) return invalidArguments(violations)
        /** The id is checked before the caller, as DSH does (TOOL:581-590). */
        const id = args.id as string
        if (id.length === 0 || id.trim() !== id) return rendered({ code: 'invalid_rule', message: 'schedule_delete id must be non-empty without surrounding whitespace.' })
        const resolved = caller(context)
        if ('refusal' in resolved) return rendered(resolved.refusal)
        if (context.signal?.aborted === true) return rendered(INTERNAL_ERROR)
        try {
          return rendered(await service.delete({ sessionId: resolved.sessionId, id }, context.signal))
        } catch (error) {
          return rendered(operationError(error))
        }
      },
    },
    {
      spec: { name: 'schedule_update', description: UPDATE_DESCRIPTION, parameters: UPDATE_PARAMETERS as Record<string, unknown> },
      run: async (args, context) => {
        const violations = validateArgs(UPDATE_PARAMETERS, args)
        if (violations.length > 0) return invalidArguments(violations)
        const resolved = caller(context)
        if ('refusal' in resolved) return rendered(resolved.refusal)
        const invalid = validateUpdateArgs(args)
        if (invalid !== undefined) return rendered(invalid)
        if (context.signal?.aborted === true) return rendered(INTERNAL_ERROR)
        const id = args.id as string
        try {
          const sessionId = resolved.sessionId
          const expected = (await service.list({ sessionId })).find((record) => record.id === id)
          if (expected === undefined) {
            const ended = (await service.catalog()).some((entry) => entry.sessionId === sessionId && entry.id === id)
            return rendered({ id, updated: false, code: ended ? 'schedule_ended' : 'schedule_not_found' })
          }
          const change = timingChangeFrom(args)
          const result = await service.update(
            {
              sessionId,
              id,
              expected,
              ...(change === undefined ? {} : { change }),
              ...(args.title === undefined ? {} : { title: args.title }),
              ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
            },
            context.signal,
          )
          return rendered('record' in result ? scheduleView(result.record, service.now()) : result)
        } catch (error) {
          return rendered(operationError(error))
        }
      },
    },
  ]
}
