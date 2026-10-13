import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MemoryBinding, RoleKind } from '../engine/types.ts'
import type { MemoryStore } from '../memory/store.ts'
import type { HandoffChannel } from './channel.ts'

/** One live role context, keyed by its child session id. */
export interface RoleContext {
  role: RoleKind
  label: string
  binding: MemoryBinding
  channel: HandoffChannel
  store: MemoryStore
  /** File the Curriculum's rsi_notes tool maintains. */
  notesFile?: string
  /** Paths this role's file tools must not touch (Actor-private state). */
  hidden: string[]
  /** Pin the child to a read-only sandbox at creation (Verifier isolation). */
  readOnly: boolean
  /** Set once the engine closes the context: no more continuations. */
  closing: boolean
  /** Tool actions since the last handoff, reported with it (RSIAgent counts actionless segments). */
  sinceHandoff: number
  /** Tool actions since the last turn-stopping continuation. */
  sinceStop: number
  /** Consecutive segments of the current phase that ended without any action or handoff. */
  actionlessStops: number
  /** Continuations steered into the current phase. */
  stops: number
  /** `turn:step` of the step the child is in, from its own session log. */
  stepKey: string
  /** Tool calls the current step dispatched. */
  stepToolCalls: number
  /** Tool-call blocks in the current step's assistant message (more than dispatched: truncated). */
  stepToolBlocks: number
  /** Text of the child's latest assistant message. */
  lastText: string
  /** Step whose rsi_handoff was accepted last: one handoff per model step. */
  handoffStep: string | undefined
}

/** The per-step and per-phase counters of a fresh context. */
export function freshCounters(): Pick<RoleContext, 'sinceHandoff' | 'sinceStop' | 'actionlessStops' | 'stops' | 'stepKey' | 'stepToolCalls' | 'stepToolBlocks' | 'lastText' | 'handoffStep'> {
  return { sinceHandoff: 0, sinceStop: 0, actionlessStops: 0, stops: 0, stepKey: '', stepToolCalls: 0, stepToolBlocks: 0, lastText: '', handoffStep: undefined }
}

/** A new handoff phase: both transport bounds apply per phase, as in RSIAgent `_run_handoff_phase`. */
export function startPhase(role: RoleContext): void {
  role.sinceHandoff = 0
  role.sinceStop = 0
  role.actionlessStops = 0
  role.stops = 0
}

/**
 * Role contexts the plugin started. Tools consult it to scope memory access and
 * the handoff channel to the calling agent; prompt contributions consult it so
 * role children never receive the interactive Actor protocol.
 *
 * On dsh hosts without reserved child ids (0.2.0-rc.x `subagents.start`), a
 * child's id is known only after its start resolves; `resolve` waits for
 * in-flight starts before deciding that a sub-agent is not an RSI role, and
 * `pendingHidden` lets synchronous guards fail closed in that window.
 */
export class RoleRegistry {
  readonly #roles = new Map<string, RoleContext>()
  readonly #ever = new Set<string>()
  readonly #starting = new Map<Promise<unknown>, readonly string[]>()

  get(id: string): RoleContext | undefined {
    return this.#roles.get(id)
  }

  set(id: string, role: RoleContext): void {
    this.#roles.set(id, role)
    this.#ever.add(id)
  }

  delete(id: string): void {
    this.#roles.delete(id)
  }

  /** Whether `id` ever named a role context of this process (closed ones included). */
  isRoleId(id: string): boolean {
    return this.#ever.has(id)
  }

  get size(): number {
    return this.#roles.size
  }

  /** Whether a start whose child id is still unknown is in flight. */
  get starting(): boolean {
    return this.#starting.size > 0
  }

  /** Hidden roots of every in-flight unreserved start. */
  get pendingHidden(): string[] {
    return [...new Set([...this.#starting.values()].flat())]
  }

  /** Tracks one start whose child id is unknown until it settles. */
  track<T>(start: Promise<T>, hidden: readonly string[] = []): Promise<T> {
    this.#starting.set(start, hidden)
    void start.finally(() => this.#starting.delete(start)).catch(() => undefined)
    return start
  }

  /** The role of `agent`, waiting (cancellably) for unreserved starts when it is an unregistered sub-agent. */
  async resolve(agent: Agent, signal: AbortSignal): Promise<RoleContext | undefined> {
    const known = this.#roles.get(agent.id)
    if (known || agent.session.header.origin !== 'subagent' || this.#starting.size === 0) return known
    const aborted = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    await Promise.race([Promise.allSettled([...this.#starting.keys()]), aborted])
    signal.throwIfAborted()
    return this.#roles.get(agent.id)
  }
}
