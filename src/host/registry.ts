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
  /** Consecutive segments that ended without any action or handoff. */
  actionlessStops: number
  /** Continuations steered into this context. */
  stops: number
}

/**
 * Role contexts the plugin started. Tools consult it to scope memory access and
 * the handoff channel to the calling agent; prompt contributions consult it so
 * role children never receive the interactive Actor protocol.
 *
 * On dsh hosts without reserved child ids (0.2.0-rc.x `subagents.start`), a
 * child's id is known only after its start resolves; `resolve` waits for
 * in-flight starts before deciding that a sub-agent is not an RSI role.
 */
export class RoleRegistry {
  readonly #roles = new Map<string, RoleContext>()
  readonly #starting = new Set<Promise<unknown>>()

  get(id: string): RoleContext | undefined {
    return this.#roles.get(id)
  }

  set(id: string, role: RoleContext): void {
    this.#roles.set(id, role)
  }

  delete(id: string): void {
    this.#roles.delete(id)
  }

  get size(): number {
    return this.#roles.size
  }

  /** Tracks one start whose child id is unknown until it settles. */
  track<T>(start: Promise<T>): Promise<T> {
    this.#starting.add(start)
    void start.finally(() => this.#starting.delete(start)).catch(() => undefined)
    return start
  }

  /** The role of `agent`, waiting (cancellably) for unreserved starts when it is an unregistered sub-agent. */
  async resolve(agent: Agent, signal: AbortSignal): Promise<RoleContext | undefined> {
    const known = this.#roles.get(agent.id)
    if (known || agent.session.header.origin !== 'subagent' || this.#starting.size === 0) return known
    const aborted = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    await Promise.race([Promise.allSettled([...this.#starting]), aborted])
    signal.throwIfAborted()
    return this.#roles.get(agent.id)
  }
}
