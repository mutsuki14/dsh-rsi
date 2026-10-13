import { randomUUID } from 'node:crypto'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import {
  InfraError,
  type EngineObserver,
  type OpenRoleOptions,
  type RoleConversation,
  type RoleReply,
  type RoleRoute,
  type RoleRuntime,
} from '../engine/types.ts'
import type { MemoryStore } from '../memory/store.ts'
import { HandoffChannel } from './channel.ts'
import type { RoleContext, RoleRegistry } from './registry.ts'

export interface SubagentRoleRuntimeOptions {
  subagents: SubagentRuntime
  /** Exact live Agent that owns every role child (the caller of the tool). */
  parent: Agent
  provider: string
  registry: RoleRegistry
  store: MemoryStore
  toolFilter: (role: OpenRoleOptions['role']) => ToolRestriction
  agentOptions: (route: RoleRoute) => AgentOptions | undefined
  /** Actor-private paths a role's file tools must not touch. */
  hidden: (role: OpenRoleOptions['role']) => string[]
  /** Whether Verifier children are pinned read-only at creation. */
  readOnlyVerifier: boolean
  /** Cancels every context this runtime opened. */
  signal: AbortSignal
  /** Upper bound on waiting for a closed context's turn to settle before disposing it. */
  closeTimeoutMs: number
  observe: EngineObserver
}

/** The part of a started child the conversation owns, on every supported dsh version. */
interface ManagedChild {
  readonly childId: SessionId
  readonly result: Promise<SubagentResult>
  dispose(): Promise<void>
}

interface ChildTask {
  readonly cwd?: string
  readonly prompt: ContentBlock[]
  readonly parent: Agent
  readonly persona?: string
  readonly toolFilter?: ToolRestriction
  readonly agentOptions?: AgentOptions
}

/** dsh >= 0.2.1-alpha.2: managed activations with a reserved child id and an initial directory. */
interface ActivationApi {
  startActivation(spec: { provider: string, label: string, childId?: SessionId, delivery: 'parent' | 'caller', signal: AbortSignal, request: ChildTask }): Promise<ManagedChild>
}

/** dsh 0.2.0-rc.x: one-shot runs; the provider mints the child id and the child inherits the parent directory. */
interface OneShotApi {
  start(name: string, request: Omit<ChildTask, 'cwd'> & { label?: string, signal: AbortSignal }): Promise<{ readonly id: SessionId, readonly result: Promise<SubagentResult>, dispose(): Promise<void> }>
}

/** Whether this host can start a role child with a reserved id in a chosen directory. */
export function supportsActivations(subagents: SubagentRuntime): boolean {
  return typeof (subagents as unknown as Partial<ActivationApi>).startActivation === 'function'
}

export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => (block.type === 'text' ? block.text : '')).join('').trim()
}

/**
 * Runs role contexts as dsh sub-agents (caller delivery, fresh context). A
 * context is one long child turn whose successive messages travel through the
 * parked `rsi_handoff` call; a segment that ends without a handoff is steered
 * back into the same turn by the plugin's `agent/turn-stopping` listener.
 */
export class SubagentRoleRuntime implements RoleRuntime {
  constructor(readonly options: SubagentRoleRuntimeOptions) {}

  async open(options: OpenRoleOptions): Promise<SubagentConversation> {
    return new SubagentConversation(this.options, options)
  }
}

export class SubagentConversation implements RoleConversation {
  readonly #channel = new HandoffChannel()
  #child: ManagedChild | undefined
  #scope: RoleContext | undefined
  #settled: Promise<void> | undefined
  #closed = false

  constructor(readonly runtime: SubagentRoleRuntimeOptions, readonly role: OpenRoleOptions) {}

  get childId(): SessionId | undefined {
    return this.#child?.childId
  }

  async send(message: string): Promise<RoleReply> {
    if (this.#closed) throw new InfraError(`${this.role.label}: the role context is closed`)
    if (this.#child === undefined) await this.#start(message)
    else if (!this.#channel.respond(message)) {
      // RSIAgent never continues in a lossy copy: a context that ended is infrastructure.
      throw new InfraError(`${this.role.label}: the role context ended its turn and cannot receive further messages`)
    }
    const event = await this.#channel.next()
    return event.kind === 'handoff' ? { text: event.text, actions: event.actions } : { text: event.output, actions: event.actions }
  }

  /** Ends the context: a parked handoff concludes the child's turn without another model call. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (this.#scope) this.#scope.closing = true
    const child = this.#child
    if (!child) return
    const parked = this.#channel.hasPendingHandoff
    this.#channel.close()
    try {
      if (parked && this.#settled) {
        const timeout = new Promise<'timeout'>(resolve => {
          const timer = setTimeout(() => resolve('timeout'), this.runtime.closeTimeoutMs)
          timer.unref?.()
        })
        if ((await Promise.race([this.#settled.then(() => 'settled' as const), timeout])) === 'timeout') {
          this.runtime.observe({ type: 'ROLE_CONTEXT_CLOSE_TIMEOUT', label: this.role.label })
        }
      }
    } finally {
      await this.#dispose(child)
    }
  }

  /** Hard stop for cancellation: the child is disposed wherever it is. */
  async abort(): Promise<void> {
    this.#closed = true
    if (this.#scope) this.#scope.closing = true
    this.#channel.close()
    if (this.#child) await this.#dispose(this.#child)
  }

  async #dispose(child: ManagedChild): Promise<void> {
    this.runtime.registry.delete(child.childId)
    await child.dispose().catch((error: unknown) => {
      this.runtime.observe({ type: 'ROLE_CONTEXT_DISPOSE_FAILED', label: this.role.label, error: String(error) })
    })
  }

  async #start(prompt: string): Promise<void> {
    const route = this.role.route ?? this.role.role
    const agentOptions = this.runtime.agentOptions(route)
    const scope: RoleContext = {
      role: this.role.role,
      label: this.role.label,
      binding: this.role.memory,
      channel: this.#channel,
      store: this.runtime.store,
      ...(this.role.notesFile === undefined ? {} : { notesFile: this.role.notesFile }),
      hidden: this.runtime.hidden(this.role.role),
      readOnly: this.role.role === 'verifier' && this.runtime.readOnlyVerifier,
      closing: false,
      sinceHandoff: 0,
      sinceStop: 0,
      actionlessStops: 0,
      stops: 0,
    }
    this.#scope = scope
    const task = {
      parent: this.runtime.parent,
      persona: this.role.system,
      toolFilter: this.runtime.toolFilter(this.role.role),
      ...(agentOptions === undefined ? {} : { agentOptions }),
    }
    const api = this.runtime.subagents as unknown as Partial<ActivationApi & OneShotApi>
    let childId: SessionId | undefined
    try {
      if (typeof api.startActivation === 'function') {
        childId = brandString<SessionId>(randomUUID())
        // Register before activation so creation hooks and the child's first tool call find their scope.
        this.runtime.registry.set(childId, scope)
        this.#child = await api.startActivation({
          provider: this.runtime.provider,
          label: this.role.label,
          childId,
          delivery: 'caller',
          signal: this.runtime.signal,
          request: { ...task, cwd: this.role.cwd, prompt: [{ type: 'text', text: prompt }] },
        })
      } else if (typeof api.start === 'function') {
        if (scope.readOnly) throw new Error('this dsh version cannot reserve a child id, so the Verifier cannot be sandboxed at creation')
        // No initial-directory option on this host: the child starts in the parent's directory.
        const located = `WORKING DIRECTORY: ${this.role.cwd}\nYour tools start in a different directory. Run every command inside that directory (cd into it first) or use absolute paths.\n\n${prompt}`
        const run = await this.runtime.registry.track(api.start(this.runtime.provider, {
          ...task,
          label: this.role.label,
          signal: this.runtime.signal,
          prompt: [{ type: 'text', text: located }],
        }))
        childId = run.id
        this.runtime.registry.set(childId, scope)
        this.#child = { childId, result: run.result, dispose: () => run.dispose() }
      } else {
        throw new Error('ctx.subagents offers neither startActivation (dsh >= 0.2.1) nor start (dsh 0.2.0)')
      }
    } catch (error) {
      if (childId) this.runtime.registry.delete(childId)
      this.#closed = true
      throw new InfraError(`${this.role.label}: sub-agent start failed: ${String(error)}`)
    }
    this.runtime.observe({ type: 'ROLE_CONTEXT_STARTED', label: this.role.label, role: this.role.role, childId })
    const child = this.#child
    const channel = this.#channel
    const onAbort = () => {
      void this.abort()
    }
    if (this.runtime.signal.aborted) onAbort()
    else this.runtime.signal.addEventListener('abort', onAbort, { once: true })
    this.#settled = child.result.then(
      (result: SubagentResult) => {
        if (result.stopReason === 'completed') channel.end(textOf(result.output), scope.sinceHandoff)
        else channel.fail(new InfraError(`${this.role.label}: sub-agent stopped (${result.stopReason})${result.diagnostic ? `: ${result.diagnostic}` : ''}`))
      },
      (error: unknown) => channel.fail(new InfraError(`${this.role.label}: sub-agent failed: ${String(error)}`)),
    ).finally(() => this.runtime.signal.removeEventListener('abort', onAbort))
  }
}
