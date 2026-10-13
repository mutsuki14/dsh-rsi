import { randomUUID } from 'node:crypto'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentActivation, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import { InfraError, type EngineObserver, type OpenRoleOptions, type RoleConversation, type RoleKind, type RoleRuntime } from '../engine/types.ts'
import type { MemoryStore } from '../memory/store.ts'
import { HandoffChannel } from './channel.ts'
import type { RoleRegistry } from './registry.ts'

export interface SubagentRoleRuntimeOptions {
  subagents: SubagentRuntime
  /** Exact live Agent that owns every role child (the caller of the tool). */
  parent: Agent
  provider: string
  registry: RoleRegistry
  store: MemoryStore
  toolFilter: (role: RoleKind) => ToolRestriction
  agentOptions: (role: RoleKind) => AgentOptions | undefined
  signal: AbortSignal
  observe: EngineObserver
}

export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => (block.type === 'text' ? block.text : '')).join('').trim()
}

const HANDOFF_CONTRACT = `HANDOFF CONTRACT. Deliver every handoff the instructions ask for by calling the rsi_handoff tool with the
complete handoff text, then keep working on whatever its result says. Do not end your turn yourself; the
harness ends this context when the lineage no longer needs it.`

export const CLOSING_MESSAGE = 'RSI CONTEXT COMPLETE. No further work is needed in this context. End your turn now without calling any tools.'

/**
 * Runs role contexts as dsh sub-agents (`ctx.subagents.startActivation`,
 * caller delivery, reserved child id). A context is one long child turn whose
 * successive messages travel through the parked `rsi_handoff` call.
 */
export class SubagentRoleRuntime implements RoleRuntime {
  constructor(readonly options: SubagentRoleRuntimeOptions) {}

  async open(options: OpenRoleOptions): Promise<RoleConversation> {
    return new SubagentConversation(this.options, options)
  }
}

class SubagentConversation implements RoleConversation {
  #channel = new HandoffChannel()
  #activation: SubagentActivation | undefined
  #childId: SessionId | undefined
  #transcript: Array<{ message: string, reply: string }> = []
  #closed = false

  constructor(readonly runtime: SubagentRoleRuntimeOptions, readonly role: OpenRoleOptions) {}

  async send(message: string): Promise<string> {
    if (this.#closed) throw new InfraError(`${this.role.label}: the role context is closed`)
    if (this.#activation === undefined) {
      await this.#start(`${HANDOFF_CONTRACT}\n\n${message}`)
    } else if (this.#channel.hasPendingHandoff) {
      this.#channel.respond(message)
    } else {
      // The child ended its own turn; continue in a fresh child that receives the logged exchange verbatim.
      this.runtime.observe({ type: 'ROLE_CONTEXT_REPLAYED', label: this.role.label, exchanges: this.#transcript.length })
      const replay = this.#transcript
        .map((entry, index) => `--- MESSAGE ${index + 1} ---\n${entry.message}\n--- YOUR HANDOFF ${index + 1} ---\n${entry.reply}`)
        .join('\n\n')
      await this.#start(`${HANDOFF_CONTRACT}\n\nYour previous context for this role ended early. Its complete exchange with the harness is replayed below; continue as the same role.\n\n${replay}\n\n--- NEXT MESSAGE ---\n${message}`)
    }
    const event = await this.#channel.next()
    const reply = event.kind === 'handoff' ? event.text : event.output
    this.#transcript.push({ message, reply })
    return reply
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const activation = this.#activation
    if (!activation) return
    this.#channel.respond(CLOSING_MESSAGE)
    try {
      await activation.result
    } catch (error) {
      // The context's work is already complete; a teardown failure is reported, not rethrown.
      this.runtime.observe({ type: 'ROLE_CONTEXT_CLOSE_FAILED', label: this.role.label, error: String(error) })
    } finally {
      if (this.#childId) this.runtime.registry.delete(this.#childId)
      await activation.dispose().catch((error: unknown) => {
        this.runtime.observe({ type: 'ROLE_CONTEXT_DISPOSE_FAILED', label: this.role.label, error: String(error) })
      })
    }
  }

  async #start(prompt: string): Promise<void> {
    if (this.#childId) this.runtime.registry.delete(this.#childId)
    this.#channel = new HandoffChannel()
    const childId = brandString<SessionId>(randomUUID())
    this.#childId = childId
    // Register before activation so the child's first tool call already finds its scope.
    this.runtime.registry.set(childId, {
      role: this.role.role,
      label: this.role.label,
      binding: this.role.memory,
      channel: this.#channel,
      store: this.runtime.store,
    })
    const agentOptions = this.runtime.agentOptions(this.role.role)
    const channel = this.#channel
    try {
      this.#activation = await this.runtime.subagents.startActivation({
        provider: this.runtime.provider,
        label: this.role.label,
        childId,
        delivery: 'caller',
        signal: this.runtime.signal,
        request: {
          cwd: this.role.cwd,
          prompt: [{ type: 'text', text: prompt }],
          parent: this.runtime.parent,
          persona: this.role.system,
          toolFilter: this.runtime.toolFilter(this.role.role),
          ...(agentOptions === undefined ? {} : { agentOptions }),
        },
      })
    } catch (error) {
      this.runtime.registry.delete(childId)
      throw new InfraError(`${this.role.label}: sub-agent start failed: ${String(error)}`)
    }
    this.runtime.observe({ type: 'ROLE_CONTEXT_STARTED', label: this.role.label, role: this.role.role, childId })
    const activation = this.#activation
    const onAbort = () => {
      void activation.dispose().catch(() => undefined)
    }
    this.runtime.signal.addEventListener('abort', onAbort, { once: true })
    void activation.result.finally(() => this.runtime.signal.removeEventListener('abort', onAbort)).catch(() => undefined)
    this.#activation.result.then(
      result => {
        if (result.stopReason === 'completed') channel.end(textOf(result.output))
        else channel.fail(new InfraError(`${this.role.label}: sub-agent stopped (${result.stopReason})${result.diagnostic ? `: ${result.diagnostic}` : ''}`))
      },
      (error: unknown) => channel.fail(new InfraError(`${this.role.label}: sub-agent failed: ${String(error)}`)),
    )
  }
}
