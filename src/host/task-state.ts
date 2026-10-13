import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { Verdict } from '../protocol/tokens.ts'

/**
 * Interactive Actor state, folded from the session log (dsh: the log is the
 * only source of truth; plugin memory is a derived cache). The interactive
 * tools carry their structured outcome as versioned `presentationMeta`, which
 * dsh persists on `tool/result` as `meta`; failures never carry meta, so a
 * failed or cancelled call never advances the state.
 */

export const STATE_TOOLS = ['rsi_submit', 'rsi_learn', 'rsi_memory_commit'] as const
type StateTool = typeof STATE_TOOLS[number]

const verdictSchema = z.enum(['PASS', 'FAIL', 'UNVERIFIED'])
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)

const reportRefSchema = z.object({
  generation: z.number().int().positive(),
  verdict: verdictSchema,
  sha256: sha256Schema,
  bytes: z.number().int().nonnegative(),
})

const learningSchema = z.object({
  episode: z.string().min(1),
  /** Session that opened the draft; a fork never writes into its parent's draft. */
  owner: z.string().min(1),
  stage: z.enum(['distill', 'reconcile']),
  outcome: z.enum(['PASS', 'FAIL']),
  verdictSeq: z.number().int().nonnegative(),
  /** `turn:step` whose result entered the current stage; the next stage needs a later model step. */
  stageStep: z.string().nullable().default(null),
})

export type ReportRef = z.infer<typeof reportRefSchema>
export type LearningRef = z.infer<typeof learningSchema>

export const taskStateSchema = z.object({
  enabled: z.boolean(),
  pending: z.record(z.string(), z.string()),
  generation: z.number().int().nonnegative(),
  reports: z.array(reportRefSchema),
  verdict: verdictSchema.nullable(),
  verdictSeq: z.number().int().nonnegative().nullable(),
  /** Session that recorded the verdict: a fork learns under the episode its origin would use. */
  verdictSession: z.string().nullable(),
  requestCount: z.number().int().nonnegative(),
  learning: learningSchema.nullable(),
  /** Verdict whose learning ended terminally (quarantined): no second learning phase for it. */
  closedVerdictSeq: z.number().int().nonnegative().nullable(),
  /** `turn:step` of the latest model tool call (the step a tool call now executing belongs to). */
  callStep: z.string().nullable(),
})

export type TaskState = z.infer<typeof taskStateSchema>

export const metaSchema = z.discriminatedUnion('op', [
  z.object({
    rsi: z.literal(1),
    op: z.literal('submit'),
    newTask: z.boolean(),
    generation: z.number().int().positive(),
    verdict: verdictSchema,
    requestCount: z.number().int().nonnegative(),
    report: z.object({ sha256: sha256Schema, bytes: z.number().int().nonnegative() }),
    session: z.string().min(1).optional(),
  }),
  z.object({ rsi: z.literal(1), op: z.literal('learn'), learning: learningSchema }),
  z.object({ rsi: z.literal(1), op: z.literal('reconcile'), episode: z.string().min(1) }),
  z.object({ rsi: z.literal(1), op: z.literal('commit'), episode: z.string().min(1) }),
  z.object({ rsi: z.literal(1), op: z.literal('close'), episode: z.string().min(1), terminal: z.boolean() }),
])

export type TaskMeta = z.infer<typeof metaSchema>

export function initTask(header: SessionHeader): TaskState {
  return {
    enabled: header.origin !== 'subagent',
    pending: {},
    generation: 0,
    reports: [],
    verdict: null,
    verdictSeq: null,
    verdictSession: null,
    requestCount: 0,
    learning: null,
    closedVerdictSeq: null,
    callStep: null,
  }
}

function isStateTool(name: string): name is StateTool {
  return (STATE_TOOLS as readonly string[]).includes(name)
}

function settle(state: TaskState, seq: number, rawMeta: unknown, step: string | null): TaskState {
  const parsed = metaSchema.safeParse(rawMeta)
  if (!parsed.success) return state
  const meta = parsed.data
  switch (meta.op) {
    case 'submit': {
      const reports = meta.newTask ? [] : state.reports
      return {
        ...state,
        generation: meta.generation,
        reports: [...reports, { generation: meta.generation, verdict: meta.verdict, sha256: meta.report.sha256, bytes: meta.report.bytes }],
        verdict: meta.verdict,
        verdictSeq: seq,
        verdictSession: meta.session ?? null,
        requestCount: meta.requestCount,
      }
    }
    case 'learn':
      return { ...state, learning: { ...meta.learning, stageStep: step } }
    case 'reconcile':
      return state.learning?.episode === meta.episode ? { ...state, learning: { ...state.learning, stage: 'reconcile', stageStep: step } } : state
    case 'commit':
      // A promoted experience completes the task: the next submission starts a new Verifier lineage.
      return { ...state, generation: 0, reports: [], verdict: null, verdictSeq: null, verdictSession: null, learning: null, closedVerdictSeq: null }
    case 'close':
      return {
        ...state,
        learning: state.learning?.episode === meta.episode ? null : state.learning,
        closedVerdictSeq: meta.terminal ? state.verdictSeq : state.closedVerdictSeq,
      }
    default: {
      const unreachable: never = meta
      return unreachable
    }
  }
}

/** Pure fold; returns the same reference for events it ignores. */
export function applyTask(state: TaskState, event: SessionEvent): TaskState {
  if (!state.enabled) return state
  switch (event.type) {
    case 'tool/call': {
      const callStep = `${event.data.turn}:${event.data.step}`
      if (isStateTool(event.data.name)) return { ...state, callStep, pending: { ...state.pending, [event.data.callId]: event.data.name } }
      return state.callStep === callStep ? state : { ...state, callStep }
    }
    case 'tool/result': {
      // Compaction re-appends pruned copies as replacements; only the original append settles a call.
      if (event.surfaceOp !== 'append') return state
      const callId = event.data.message.toolCallId
      if (state.pending[callId] === undefined) return state
      const { [callId]: _settled, ...pending } = state.pending
      const next = { ...state, pending }
      return event.data.message.isError === true || event.data.meta === undefined ? next : settle(next, event.seq, event.data.meta, `${event.data.turn}:${event.data.step}`)
    }
    case 'tool/ptc-dispatch': {
      // dsh 0.2.0 records no meta on PTC sub-dispatches; there the fold simply sees none.
      const meta = (event.data as { meta?: unknown }).meta
      // A sub-dispatch belongs to the step of its run_code call, the latest model tool call.
      return isStateTool(event.data.name) && !event.data.isError && meta !== undefined ? settle(state, event.seq, meta, state.callStep) : state
    }
    case 'turn/end':
      return Object.keys(state.pending).length === 0 ? state : { ...state, pending: {} }
    default:
      return state
  }
}

/** Deterministic episode id: a retried or cancelled rsi_learn reuses the same draft. */
export function episodeFor(sessionId: string, verdictSeq: number): string {
  return `task-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}-${verdictSeq}`
}
