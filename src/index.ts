/**
 * dsh-rsi — recursive self-improvement for DeepSeek Harness, after RSIAgent
 * (Zhu et al., 2026, arXiv:2609.15364).
 *
 * The main agent is the Actor. It reuses Actor-owned durable memory, submits
 * finished work to an independent, effect-isolated Verifier sub-agent, and
 * turns each terminal verdict into memory through a distill → reconcile →
 * atomic-commit learning phase whose state is folded from the session log.
 * `rsi_explore` runs the Curriculum-driven Phase 1 (broad waves) and Phase 2
 * (deep, target-conditioned) lineages with fresh role sub-agents.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type ToolRestriction } from '@deepseek-ai/dsh-tools'
import { access, lstat, mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { Config } from './config.ts'
import { captureTree, shapeGate } from './engine/fixtures.ts'
import { runBroadExploration, runDeepExploration, type EngineConfig } from './engine/lineage.ts'
import { formatLeads, inspect } from './engine/steps.ts'
import type { EngineEvent, RoleKind, RoleRoute, TransportPolicy } from './engine/types.ts'
import { MemoryConflictError, MemoryFrozenError, MemoryQuarantineError, type MemoryDraft, type MemoryStore } from './memory/store.ts'
import {
  actorProtocol,
  disagreementMessage,
  distillationMessage,
  formatInventory,
  memoryPreamble,
  reconciliationMessage,
  stallContinuation,
  toolStepContinuation,
  truncatedContinuation,
  unverifiedMessage,
} from './roles/actor.ts'
import { verifierSystem } from './roles/verifier.ts'
import { CLOSED } from './host/channel.ts'
import { WorkspaceCheckpoint } from './host/checkpoint.ts'
import { workspaceState } from './host/git.ts'
import { applyRoleIsolation, decideIsolation, privatePathGuard, type GuardedExecution, type IsolationDecision } from './host/isolation.ts'
import { RoleRegistry, startPhase, type RoleContext } from './host/registry.ts'
import { runSealedEvaluation } from './host/sealed.ts'
import { dshHome, prepareWorkRoot, StoreRegistry } from './host/stores.ts'
import { SubagentRoleRuntime, supportsActivations, type SubagentConversation } from './host/subagent-runtime.ts'
import { applyTask, episodeFor, initTask, STATE_TOOLS, taskStateSchema, type TaskMeta, type TaskState } from './host/task-state.ts'

export { Config }

export const name = 'dsh-rsi'
export const inject = ['tools', 'systemPrompt', 'subagents', 'sessionProjections']

/** Recent user-authored request texts, folded from the session log. */
interface RequestsState {
  texts: string[]
  /** Total user requests folded so far; detects a new task after a PASS. */
  count: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'dsh-rsi/requests': RequestsState
    'dsh-rsi/task': TaskState
  }
}

/** Fold bound for recent requests; `verifier.taskMessages` selects from it. */
const REQUESTS_KEPT = 16

/** Tools that delegate to or message other agents; role contexts never get them. */
const DELEGATION_TOOLS = ['subagent', 'subagent_fork', 'workflow', 'send_message', 'interrupt_agent', 'list_agents']

/** Tools that address another agent by id; a role context accepts input only from the harness. */
const MESSAGING_TOOLS = new Set(['send_message', 'interrupt_agent'])

/** Reserved transport tools a tool filter may not name. */
const TRANSPORT_TOOLS = new Set(['run_code'])

export const RSI_TOOLS = [
  'rsi_memory_list',
  'rsi_memory_read',
  'rsi_memory_search',
  'rsi_memory_write',
  'rsi_memory_delete',
  'rsi_memory_commit',
  'rsi_submit',
  'rsi_learn',
  'rsi_explore',
  'rsi_handoff',
  'rsi_notes',
] as const

const PROTOCOL_SECTION_ORDER = 2950
const MEMORY_CONTEXT_ORDER = 130

function requestsOf(event: SessionEvent, state: RequestsState): RequestsState {
  if (event.type !== 'user/message' || event.data.source.kind !== 'user') return state
  const text = event.data.content.map(block => (block.type === 'text' ? block.text : '')).join('').trim()
  if (text === '') return state
  return { texts: [...state.texts, text].slice(-REQUESTS_KEPT), count: state.count + 1 }
}

function requireAgent(agent: Agent | undefined, tool: string): Agent {
  if (!agent) throw new Error(`${tool} requires an owning agent session`)
  return agent
}

function isSubagent(agent: Agent | undefined): boolean {
  return agent?.session.header.origin === 'subagent'
}

/** Optional services typed structurally, so the plugin loads on hosts that do not compose them. */
function service<T>(ctx: Context, key: string): T | undefined {
  return (ctx as unknown as { get(name: string): unknown }).get(key) as T | undefined
}

/** dsh aborts a turn with a plain cause object, which a thrown value would render as "[object Object]". */
function throwIfCancelled(signal: AbortSignal, what: string): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(`${what} was cancelled`)
}

/** A role route as it will run: empty fields inherit the agent's live route, like dsh child options. */
export function effectiveRoute(agent: Agent, route: { provider?: string, model?: string }): { provider: string, model: string } {
  const live = agent.session.requestHeader()?.config
  const parentProvider = live?.provider ?? agent.options.provider ?? ''
  const parentModel = live?.model ?? agent.options.model ?? ''
  return { provider: route.provider || parentProvider, model: route.model || parentModel }
}

/** Interactive Verifier kept alive across revisions within one main-agent turn. */
interface LiveVerifier {
  conversation: SubagentConversation
  controller: AbortController
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('dsh-rsi')
  const roles = new RoleRegistry()
  const stores = new StoreRegistry(config)
  const verifiers = new Map<string, LiveVerifier>()
  const frozenByConfig = config.mode === 'frozen'
  const transport: TransportPolicy = { ...config.transport }
  const canReserveIds = supportsActivations(ctx.subagents)

  const frozen = async (store: MemoryStore): Promise<boolean> => frozenByConfig || (await store.frozen())
  const cwdOf = (session: Session): string =>
    service<{ get(session: Session): string }>(ctx, 'workingDirectory')?.get(session) ?? session.header.cwd ?? process.cwd()
  const isolation = (cwd: string): Promise<IsolationDecision> => decideIsolation(ctx, config.verifier.isolation, canReserveIds, cwd)
  const requireIsolation = async (cwd: string): Promise<IsolationDecision> => {
    const decision = await isolation(cwd)
    if (decision.mode === 'sandbox' && decision.unavailable) {
      throw new Error(`Verifier isolation "sandbox" is unavailable: ${decision.unavailable}. Set verifier.isolation to "rollback" or "auto". This is an infrastructure failure, not a verdict.`)
    }
    return decision
  }

  const closeVerifier = async (agentId: string): Promise<void> => {
    const live = verifiers.get(agentId)
    if (!live) return
    verifiers.delete(agentId)
    await live.conversation.close()
    live.controller.abort()
  }

  ctx.effect(() => () => {
    for (const live of verifiers.values()) {
      void live.conversation.abort()
      live.controller.abort()
    }
    verifiers.clear()
  })

  // ---------------------------------------------------------------- session-derived state
  ctx.sessionProjections.register<'dsh-rsi/requests', RequestsState>({
    key: 'dsh-rsi/requests',
    stateSchema: z.object({ texts: z.array(z.string()), count: z.number().int().nonnegative() }),
    init: () => ({ texts: [], count: 0 }),
    apply: (state, event) => requestsOf(event, state),
    stateVersion: 2,
  })
  ctx.sessionProjections.register<'dsh-rsi/task', TaskState>({
    key: 'dsh-rsi/task',
    stateSchema: taskStateSchema,
    init: header => initTask(header),
    apply: (state, event) => applyTask(state, event),
    stateVersion: 2,
  })
  const taskOf = (agent: Agent): TaskState => ctx.sessionProjections.stateOf(agent.session, 'dsh-rsi/task') ?? initTask(agent.session.header)
  const requestsOfAgent = (agent: Agent): RequestsState => ctx.sessionProjections.stateOf(agent.session, 'dsh-rsi/requests') ?? { texts: [], count: 0 }

  // ---------------------------------------------------------------- prompt
  ctx.systemPrompt.section({
    name: 'dsh-rsi:protocol',
    order: PROTOCOL_SECTION_ORDER,
    interpolate: false,
    text: context => (context.agent === undefined || isSubagent(context.agent) ? '' : actorProtocol(config.mode, config.verifier.allowUnverified)),
  })
  const memoryContext = {
    name: 'dsh-rsi:memory',
    order: MEMORY_CONTEXT_ORDER,
    interpolate: false,
    text: (context: { agent?: Agent }) => {
      if (context.agent === undefined || isSubagent(context.agent)) return ''
      const inventory = stores.inventory(stores.memoryRoot(stores.projectDir(context.agent)))
      return inventory === undefined ? '' : memoryPreamble(inventory, config.promptInventory)
    },
  }
  ctx.systemPrompt.context(memoryContext)

  // ---------------------------------------------------------------- agent lifecycle
  ctx.on('agent/created', async ({ agent }) => {
    const role = roles.get(agent.id)
    if (role) {
      // A failure here fails the child's creation: a Verifier is never started unconfined.
      applyRoleIsolation(agent, role)
      return undefined
    }
    if (isSubagent(agent)) return undefined
    // Agent creation waits briefly for the inventory, never for another process's store lock.
    const opening = stores.forAgent(agent).then(() => undefined, (error: unknown) => {
      logger.warn('could not open RSI memory for %s: %s', agent.id, error)
    })
    await Promise.race([opening, new Promise<void>(resolve => setTimeout(resolve, 5_000).unref?.())])
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => {
    // Drafts survive disposal: the session can be resumed and its learning phase continued.
    void closeVerifier(agent.id)
  })
  ctx.on('session/event', (session, event) => {
    // Backstop for turns that end without turn-stopping (errors, aborts): no Verifier outlives its turn.
    if (event.type === 'turn/end' && verifiers.has(session.id)) void closeVerifier(session.id)
    const role = roles.get(session.id)
    if (!role) return
    // Per-step facts of a role child, read from its own log.
    switch (event.type) {
      case 'step/start':
        role.stepKey = `${event.data.turn}:${event.data.step}`
        role.stepToolCalls = 0
        role.stepToolBlocks = 0
        break
      case 'assistant/message':
        role.lastText = event.data.message.content.map(block => (block.type === 'text' ? block.text : '')).join('').trim()
        role.stepToolBlocks = event.data.message.content.filter(block => block.type === 'tool-call').length
        break
      case 'tool/call':
        role.stepToolCalls++
        break
      default:
        break
    }
  })
  ctx.on('tools/result', exec => {
    const role = exec.agent ? roles.get(exec.agent.id) : undefined
    if (role && exec.name !== 'rsi_handoff') {
      role.sinceHandoff++
      role.sinceStop++
    }
  })
  // A role context takes input only from the harness: messages other agents address to it never enter a step.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const agent = (payload as { agent?: Agent }).agent
    if (decision.kind !== 'enter' || agent === undefined || !roles.get(agent.id)) return decision
    const messages = decision.messages.filter(message => (message.source as { kind: string }).kind !== 'agent-message')
    return messages.length === decision.messages.length ? decision : { ...decision, messages }
  })

  const say = (value: string) => createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } })
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    const role = roles.get(agent.id)
    if (!role) {
      // Hosts wait for children at the turn boundary; the interactive Verifier never outlives the turn.
      if (!isSubagent(agent)) await closeVerifier(agent.id)
      return
    }
    if (role.closing || role.channel.closed || role.channel.ended) return
    if (role.stepToolCalls > 0) {
      // A stop right after a step that ran tools comes from a sticky output-limit turn end, not a natural stop.
      agent.steer(say(toolStepContinuation()))
      return
    }
    // RSIAgent same-context continuation: a segment that ended without a handoff resumes in the same context.
    role.stops++
    role.actionlessStops = role.sinceStop === 0 ? role.actionlessStops + 1 : 0
    role.sinceStop = 0
    const reason = role.actionlessStops >= transport.actionlessLimit
      ? `${role.actionlessStops} consecutive segments ended without any action or handoff`
      : role.stops > transport.ceiling
        ? `the emergency ceiling of ${transport.ceiling} continuations was reached without a handoff`
        : undefined
    if (reason === undefined) {
      agent.steer(say(role.stepToolBlocks > 0 ? truncatedContinuation() : stallContinuation()))
      return
    }
    // The phase is transport infrastructure, as in RSIAgent, but the context lives on: hold the turn
    // here until the engine's next message (a forced inspection's learning, or the close).
    let next
    try {
      next = await role.channel.hold(role.lastText, role.sinceHandoff, reason, signal)
    } catch {
      return
    }
    if (next === CLOSED) return
    startPhase(role)
    agent.steer(say(next))
  })

  // Global guards keyed by role, installed once: they also cover children whose id becomes known only
  // after creation (dsh 0.2.0-rc), tools registered after a child started, and PTC sub-dispatches.
  const pathGuards = new WeakMap<RoleContext, (execution: GuardedExecution) => string | undefined>()
  const verifierAllowed = new Set([...config.verifier.allowTools, 'rsi_handoff', ...TRANSPORT_TOOLS])
  const verifierDenied = new Set(config.verifier.denyTools)
  const pendingGuard = () => privatePathGuard(roles.pendingHidden, cwdOf)
  ctx.tools.guard(execution => {
    const args = (execution.arguments ?? {}) as Record<string, unknown>
    if (MESSAGING_TOOLS.has(execution.name)) {
      const target = typeof args.agent_id === 'string' ? args.agent_id : typeof args.target === 'string' ? args.target : undefined
      if (target !== undefined && roles.isRoleId(target)) return 'That agent is an RSI role context; it accepts messages only from the harness.'
    }
    const agent = execution.agent
    if (!agent) return undefined
    const role = roles.get(agent.id)
    if (!role) {
      // An unreserved start whose id is not known yet: fail closed on every hidden root in flight.
      return isSubagent(agent) && roles.starting ? pendingGuard()(execution) : undefined
    }
    if (role.role === 'verifier' && (!verifierAllowed.has(execution.name) || verifierDenied.has(execution.name))) {
      return `${execution.name} is not available to the Verifier: it inspects with read, search, and confined execution tools only.`
    }
    if (role.hidden.length === 0) return undefined
    let guard = pathGuards.get(role)
    if (!guard) {
      guard = privatePathGuard(role.hidden, cwdOf)
      pathGuards.set(role, guard)
    }
    return guard(execution)
  })

  // ---------------------------------------------------------------- memory views
  interface MemoryView {
    store: MemoryStore
    dir: string
    draft?: MemoryDraft
    role?: RoleContext
  }

  const roleOf = (agent: Agent, signal: AbortSignal): Promise<RoleContext | undefined> => roles.resolve(agent, signal)

  /** The interactive learning draft this session owns, reopened from disk if needed. */
  const ownedDraft = async (agent: Agent, store: MemoryStore): Promise<MemoryDraft | undefined> => {
    const learning = taskOf(agent).learning
    if (!learning || learning.owner !== agent.id) return undefined
    return store.reopenDraft(learning.episode)
  }

  const viewOf = async (agent: Agent, tool: string, signal: AbortSignal): Promise<MemoryView> => {
    const role = await roleOf(agent, signal)
    if (role) {
      if (role.binding.access === 'none') throw new Error(`${tool}: memory is not available in the ${role.role} context`)
      const dir = role.binding.readDir ?? role.store.canonicalDir
      return role.binding.access === 'draft' && role.binding.draft
        ? { store: role.store, dir, draft: role.binding.draft, role }
        : { store: role.store, dir, role }
    }
    const store = await stores.forAgent(agent)
    const draft = await ownedDraft(agent, store)
    return draft ? { store, dir: draft.dir, draft } : { store, dir: store.canonicalDir }
  }

  const writableView = async (agent: Agent, tool: string, signal: AbortSignal): Promise<MemoryView & { draft: MemoryDraft }> => {
    const view = await viewOf(agent, tool, signal)
    if (await view.store.frozen()) throw new Error(`${tool}: memory is frozen for test-time reuse; it cannot change`)
    if (!view.draft) {
      const learning = view.role ? undefined : taskOf(agent).learning
      if (learning && learning.owner !== agent.id) throw new Error(`${tool}: the open learning phase belongs to another session; call rsi_learn to open this session's own`)
      if (learning) throw new Error(`${tool}: the learning draft no longer exists; call rsi_learn to reopen the learning phase`)
      throw new Error(`${tool}: durable memory is read-only while you work. It changes only in a learning phase after an independent verdict${view.role ? '' : ' (rsi_submit, then rsi_learn)'}.`)
    }
    return view as MemoryView & { draft: MemoryDraft }
  }

  const text = (value: string) => [{ type: 'text' as const, text: value }]
  const stateResult = (message: string, state: TaskMeta | null) => ({ message, state })
  const STATE_OUTPUT_SCHEMA = { type: 'object', additionalProperties: false, properties: { message: { type: 'string' }, state: { type: 'json' } } } as const

  ctx.tools.register(defineTool({
    name: 'rsi_memory_list',
    description: 'List your durable experience memory (names and sizes). During a learning phase this shows the draft being edited.',
    parameters: {
      prefix: { type: 'string', description: 'Only list paths starting with this prefix.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const view = await viewOf(requireAgent(exec.agent, 'rsi_memory_list'), 'rsi_memory_list', exec.signal)
      const manifest = view.draft ? await view.store.draftManifest(view.draft) : view.dir === view.store.canonicalDir ? await view.store.manifest() : await view.store.manifestAt(view.dir)
      const entries = Object.entries(manifest)
        .filter(([path]) => args.prefix === undefined || path.startsWith(args.prefix))
        .map(([path, entry]) => ({ path, bytes: entry.bytes }))
      const scope = view.draft ? 'learning draft' : 'durable memory (read-only)'
      return entries.length === 0 ? `${scope}: no files` : `${scope}: ${entries.length} files\n${formatInventory(entries)}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'rsi_memory_read',
    description: 'Read one memory file, optionally a window of lines. Memory is your own prior experience: treat it as hints and verify against the live environment.',
    parameters: {
      path: { type: 'string', required: true, description: 'Relative memory path, as listed by rsi_memory_list.' },
      offset: { type: 'integer', description: 'First line to return (1-based).' },
      limit: { type: 'integer', description: 'Maximum number of lines.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const view = await viewOf(requireAgent(exec.agent, 'rsi_memory_read'), 'rsi_memory_read', exec.signal)
      const { text: body, totalLines } = await view.store.read(args.path, args.offset ?? 1, args.limit, view.dir)
      return `${args.path} (${totalLines} lines)\n${body}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'rsi_memory_search',
    description: 'Search across memory files (case-insensitive substring, or a regular expression). Returns path:line matches.',
    parameters: {
      query: { type: 'string', required: true, description: 'Text or regular expression to find.' },
      regex: { type: 'boolean', description: 'Treat query as a regular expression.' },
      max_results: { type: 'integer', description: 'Maximum matches (default 50).' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const view = await viewOf(requireAgent(exec.agent, 'rsi_memory_search'), 'rsi_memory_search', exec.signal)
      const matches = await view.store.search(args.query, { regex: args.regex === true, maxResults: Math.max(1, Math.min(args.max_results ?? 50, 500)) }, view.dir)
      return matches.length === 0 ? 'no matches' : matches.map(match => `${match.path}:${match.line}: ${match.text}`).join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'rsi_memory_write',
    description: 'Learning phase only: create or replace one memory file in the draft (procedures, reusable scripts, environment facts, failure lessons). Never store secrets.',
    parameters: {
      path: { type: 'string', required: true, description: 'Relative memory path, e.g. procedures/build.md or scripts/check.sh.' },
      content: { type: 'string', required: true, description: 'Complete UTF-8 file content.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const view = await writableView(requireAgent(exec.agent, 'rsi_memory_write'), 'rsi_memory_write', exec.signal)
      await view.store.writeDraft(view.draft, args.path, args.content)
      return `draft: wrote ${args.path} (${Buffer.byteLength(args.content, 'utf8')} bytes)`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'rsi_memory_delete',
    description: 'Learning phase only: delete one memory file from the draft.',
    parameters: {
      path: { type: 'string', required: true, description: 'Relative memory path.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const view = await writableView(requireAgent(exec.agent, 'rsi_memory_delete'), 'rsi_memory_delete', exec.signal)
      return (await view.store.deleteDraft(view.draft, args.path)) ? `draft: deleted ${args.path}` : `draft: ${args.path} does not exist`
    },
  }))

  // ---------------------------------------------------------------- role runtime
  const interactiveOnly = async (agent: Agent, tool: string, signal: AbortSignal, parent?: unknown) => {
    if (await roleOf(agent, signal)) throw new Error(`${tool} is not available inside an RSI role context; use rsi_handoff`)
    // dsh 0.2.0 records no structured result for run_code sub-calls, so the task state would never see this call's outcome.
    if (parent !== undefined && !canReserveIds && STATE_TOOLS.includes(tool as typeof STATE_TOOLS[number])) {
      throw new Error(`${tool} must be called directly, not from run_code, on this dsh version (set DSH_TOOLS_MODE=native, or use dsh >= 0.2.1-alpha.2)`)
    }
  }

  /** Names the child will actually inherit: resolved in the parent's scope, so agent-preset tools count too. */
  const known = (names: readonly string[], parent: Agent) =>
    [...new Set(names)].filter(toolName => !TRANSPORT_TOOLS.has(toolName) && ctx.tools.get(toolName, parent) !== undefined)
  const toolFilter = (role: RoleKind, parent: Agent): ToolRestriction => {
    const common = known(['rsi_submit', 'rsi_learn', 'rsi_memory_commit', 'rsi_explore', ...DELEGATION_TOOLS], parent)
    switch (role) {
      case 'actor':
        return { deny: [...common, ...known(['rsi_notes'], parent)] }
      case 'curriculum':
        return {
          deny: [
            ...common,
            ...known([
              'rsi_memory_write',
              'rsi_memory_delete',
              ...(config.exploration.curriculumMemoryAccess === 'none' ? ['rsi_memory_list', 'rsi_memory_read', 'rsi_memory_search'] : []),
            ], parent),
          ],
        }
      case 'verifier': {
        // An allow-list: MCP tools and anything else acting outside the sandbox stay out (the guard backs this up).
        const allow = known([...config.verifier.allowTools, 'rsi_handoff'], parent)
        const deny = known([...RSI_TOOLS.filter(toolName => toolName !== 'rsi_handoff'), ...DELEGATION_TOOLS, ...config.verifier.denyTools], parent)
        return deny.length > 0 ? { allow, deny } : { allow }
      }
      default: {
        const unreachable: never = role
        throw new Error(`unknown role ${String(unreachable)}`)
      }
    }
  }

  const routeOptions = (route: RoleRoute) => {
    const chosen = config.roles[route]
    if (!chosen.provider && !chosen.model) return undefined
    return { ...(chosen.provider ? { provider: chosen.provider } : {}), ...(chosen.model ? { model: chosen.model } : {}) }
  }

  /** Actor-private state a Verifier's file tools must not touch: memory, session logs, and projection caches. */
  const hiddenFor = (store: MemoryStore) => (role: RoleKind): string[] =>
    role === 'verifier' ? [store.root, join(dshHome(), 'sessions'), join(dshHome(), 'storages')] : []

  const runtimeFor = (parent: Agent, store: MemoryStore, signal: AbortSignal, observe: (event: EngineEvent) => void, readOnlyVerifier: boolean) =>
    new SubagentRoleRuntime({
      subagents: ctx.subagents,
      parent,
      provider: config.subagentProvider,
      registry: roles,
      store,
      toolFilter,
      agentOptions: routeOptions,
      hidden: hiddenFor(store),
      readOnlyVerifier,
      signal,
      closeTimeoutMs: config.closeTimeoutMs,
      observe,
    })

  // ---------------------------------------------------------------- interactive Actor protocol
  const authoritativeTask = (agent: Agent): string => {
    const recent = requestsOfAgent(agent).texts.slice(-config.verifier.taskMessages)
    if (recent.length === 0) return '(no user request was found in this session)'
    if (recent.length === 1) return recent[0]!
    return recent
      .map((request, index) => `[user message ${index + 1} of ${recent.length}${index === recent.length - 1 ? ', latest' : ''}]\n${request}`)
      .join('\n\n')
  }

  /** Harness-owned paths under the candidate root, left out of capture and rollback. */
  const harnessPaths = (cwd: string, agent: Agent, store: MemoryStore): string[] => {
    const out: string[] = []
    for (const path of [stores.stateRoot(stores.projectDir(agent)), store.root]) {
      const rel = relative(cwd, path)
      if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) out.push(rel.split('\\').join('/'))
    }
    return out
  }

  ctx.tools.register(defineTool({
    name: 'rsi_submit',
    description: 'Submit the current task for independent verification. An effect-isolated Verifier Agent inspects the live result against the user\'s verbatim request without seeing your reasoning or memory, and returns PASS, FAIL, or UNVERIFIED with a report. Within one turn the same Verifier context inspects every revision.',
    parameters: {
      evidence_leads: {
        type: 'array',
        description: 'Only after UNVERIFIED: reproducible evidence leads. Each pairs a requirement with one exact read-only command the Verifier can re-run. Never a narrative of your own work.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            claim: { type: 'string', description: 'The requirement the probe demonstrates.' },
            probe: { type: 'string', description: 'One exact read-only shell command that prints PASS only when the claim holds.' },
          },
        },
      },
    },
    output: { schema: STATE_OUTPUT_SCHEMA, render: (_args, value) => text(value.message ?? ''), presentationMeta: (_args, value) => value.state ?? null },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent, 'rsi_submit')
      await interactiveOnly(agent, 'rsi_submit', exec.signal, exec.parent)
      const task = taskOf(agent)
      if (task.learning && task.learning.owner === agent.id) throw new Error('a learning phase is open; finish it with rsi_memory_commit before submitting again')
      const store = await stores.forAgent(agent)
      // The candidate is the session's project, not a transient working directory inside it.
      const cwd = stores.projectDir(agent)
      const decision = await requireIsolation(cwd)
      const requests = requestsOfAgent(agent).count
      const newTask = task.verdict === 'PASS' && requests > task.requestCount
      // A Verifier context that ended or failed between submissions cannot continue: start a fresh one.
      if (newTask || verifiers.get(agent.id)?.conversation.ended) await closeVerifier(agent.id)
      const generation = (newTask ? 0 : task.generation) + 1
      const excludes = harnessPaths(cwd, agent, store)
      throwIfCancelled(exec.signal, 'rsi_submit')
      const before = await workspaceState(cwd, excludes)
      let checkpoint: WorkspaceCheckpoint
      try {
        checkpoint = await WorkspaceCheckpoint.take(cwd, excludes, { maxBytes: config.verifier.checkpointMaxBytes, maxFiles: config.verifier.checkpointMaxFiles })
      } catch (error) {
        throw new Error(`the candidate could not be checkpointed (${String(error)}). This is an infrastructure failure, not a verdict.`)
      }

      let result
      let changed: string[] = []
      let onAbort: (() => void) | undefined
      try {
        throwIfCancelled(exec.signal, 'rsi_submit')
        let live = verifiers.get(agent.id)
        const fresh = live === undefined
        if (!live) {
          const controller = new AbortController()
          const runtime = runtimeFor(agent, store, controller.signal, event => logger.debug('%o', event), decision.mode === 'sandbox')
          live = {
            conversation: await runtime.open({
              role: 'verifier',
              label: `rsi verifier (${agent.id.slice(0, 8)})`,
              system: verifierSystem(config.verifier.allowUnverified, decision.mode),
              cwd,
              memory: { access: 'none' },
            }),
            controller,
          }
          verifiers.set(agent.id, live)
        }
        const priorReports: string[] = []
        if (fresh && !newTask) {
          for (const ref of task.reports) priorReports.push((await store.getReport(ref.sha256)) ?? `(report unavailable: generation ${ref.generation}, ${ref.verdict}, sha256 ${ref.sha256})`)
        }
        const leads = task.verdict === 'UNVERIFIED' && args.evidence_leads?.length
          ? formatLeads(args.evidence_leads.map(lead => ({ claim: lead.claim ?? '', probe: lead.probe ?? '' })).filter(lead => lead.probe.trim() !== ''))
          : undefined
        const current = live
        onAbort = () => {
          // A cancel reaches the child even while it is still starting.
          if (verifiers.get(agent.id) === current) verifiers.delete(agent.id)
          current.controller.abort()
          void current.conversation.abort()
        }
        exec.signal.addEventListener('abort', onAbort, { once: true })
        if (exec.signal.aborted) onAbort()
        result = await inspect(current.conversation, {
          task: authoritativeTask(agent),
          generation,
          mechanicalContext: before.summary,
          ...(leads ? { leads } : {}),
          ...(priorReports.length > 0 ? { priorReports } : {}),
          allowUnverified: config.verifier.allowUnverified,
          policy: transport,
          signal: exec.signal,
        })
      } catch (error) {
        await closeVerifier(agent.id)
        throw error
      } finally {
        if (onAbort) exec.signal.removeEventListener('abort', onAbort)
        try {
          changed = await checkpoint.restore()
        } finally {
          await checkpoint.dispose()
        }
      }
      throwIfCancelled(exec.signal, 'rsi_submit')
      if (result.kind === 'infra') {
        await closeVerifier(agent.id)
        throw new Error(`verification is unavailable: ${result.reason}. This is an infrastructure failure, not a verdict.`)
      }
      // A verdict published as the context's last words cannot be continued: the next submission opens a fresh one.
      if (verifiers.get(agent.id)?.conversation.ended) await closeVerifier(agent.id)
      const note = changed.length === 0
        ? ''
        : checkpoint.restores
          ? `\n\nHARNESS NOTE: ${changed.length} path(s) changed during the inspection and were restored: ${changed.slice(0, 20).join(', ')}${changed.length > 20 ? ', …' : ''}`
          : `\n\nHARNESS NOTE: ${changed.length} path(s) changed during the inspection; the workspace was too large to checkpoint, so inspect them: ${changed.slice(0, 20).join(', ')}`
      const ref = await store.putReport(result.report)
      const learn = config.mode === 'learn' && !(await frozen(store))
      let guidance: string
      switch (result.verdict) {
        case 'PASS':
          guidance = `VERDICT: PASS\n\nThe independent Verifier verified the task. Report:\n---\n${result.report.trim()}\n---${learn ? '\nNext: call rsi_learn to distill this experience into durable memory.' : ''}`
          break
        case 'FAIL':
          guidance = `VERDICT: FAIL\n\n${disagreementMessage(result.report)}${learn ? '\nIf you decide to stop repairing, call rsi_learn: a FAIL still teaches.' : ''}`
          break
        case 'UNVERIFIED':
          guidance = `VERDICT: UNVERIFIED\n\n${unverifiedMessage(result.report)}\nThen call rsi_submit again with evidence_leads.`
          break
        default: {
          const unreachable: never = result.verdict
          throw new Error(`unknown verdict ${String(unreachable)}`)
        }
      }
      return stateResult(guidance + note, { rsi: 1, op: 'submit', newTask, generation, verdict: result.verdict, requestCount: requests, report: ref, session: agent.id })
    },
    presentCall: () => ({ card: 'generic', title: 'RSI verification', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'rsi_learn',
    description: 'Open the learning phase after a terminal verdict (PASS, or FAIL when you stop repairing): distill this experience into a memory draft, then rsi_memory_commit.',
    parameters: {},
    output: { schema: STATE_OUTPUT_SCHEMA, render: (_args, value) => text(value.message ?? ''), presentationMeta: (_args, value) => value.state ?? null },
    async execute(_args, exec) {
      const agent = requireAgent(exec.agent, 'rsi_learn')
      await interactiveOnly(agent, 'rsi_learn', exec.signal, exec.parent)
      const store = await stores.forAgent(agent)
      if (await frozen(store)) throw new Error('memory is frozen for test-time reuse; no learning phase exists')
      const task = taskOf(agent)
      if (task.verdict !== 'PASS' && task.verdict !== 'FAIL') {
        throw new Error('rsi_learn needs a terminal Verifier verdict first: call rsi_submit (UNVERIFIED is not terminal)')
      }
      if (task.verdictSeq === null) throw new Error('rsi_learn needs a recorded verdict')
      if (task.closedVerdictSeq === task.verdictSeq) throw new Error('the learning phase for this verdict already ended; durable memory was not changed')
      const episode = episodeFor(agent.id, task.verdictSeq)
      // The verdict's origin is shared by the session that recorded it and every fork: it is learned once.
      const origin = episodeFor(task.verdictSession ?? agent.id, task.verdictSeq)
      for (const candidate of new Set([episode, origin])) {
        if (await store.findCommit(candidate)) {
          return stateResult('This experience was already promoted to durable memory; there is nothing left to learn from it.', { rsi: 1, op: 'commit', episode })
        }
        if (await store.isQuarantined(candidate)) throw new Error('the learning phase for this verdict already ended; durable memory was not changed')
      }
      // The attempt is over: the Verifier context ends before learning starts.
      await closeVerifier(agent.id)
      await store.openDraft(episode)
      const last = task.reports.at(-1)
      const report = (last && (await store.getReport(last.sha256))) ?? '(the final report is in your history above)'
      return stateResult(distillationMessage(task.verdict, report, 'actor', store.limits), {
        rsi: 1,
        op: 'learn',
        learning: { episode, owner: agent.id, stage: 'distill', outcome: task.verdict, verdictSeq: task.verdictSeq, stageStep: null },
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'rsi_memory_commit',
    description: 'Learning phase: the first call asks you to reconcile the whole draft; the second call promotes it atomically to durable memory.',
    parameters: {},
    output: { schema: STATE_OUTPUT_SCHEMA, render: (_args, value) => text(value.message ?? ''), presentationMeta: (_args, value) => value.state ?? null },
    async execute(_args, exec) {
      const agent = requireAgent(exec.agent, 'rsi_memory_commit')
      await interactiveOnly(agent, 'rsi_memory_commit', exec.signal, exec.parent)
      const task = taskOf(agent)
      const learning = task.learning
      if (!learning) throw new Error('no learning phase is open; call rsi_learn after a terminal verdict')
      const origin = episodeFor(task.verdictSession ?? agent.id, learning.verdictSeq)
      if (learning.owner !== agent.id) throw new Error('the open learning phase belongs to another session; call rsi_learn to open this session\'s own')
      const store = await stores.forAgent(agent)
      if ((await store.findCommit(learning.episode)) || (await store.findCommit(origin))) {
        await store.discardDraft(learning.episode)
        await stores.refresh(store)
        return stateResult('This learning phase was already promoted to durable memory.', { rsi: 1, op: 'commit', episode: learning.episode })
      }
      if (await frozen(store)) {
        // Test-time reuse never changes memory; the draft stays for a later learning phase.
        return stateResult('Memory is frozen for test-time reuse, so nothing was promoted. The draft is kept; after memory is unfrozen, call rsi_learn to continue this learning phase.', { rsi: 1, op: 'close', episode: learning.episode, terminal: false })
      }
      // Each stage's instructions must be read before the next stage: never in the same model step.
      if (learning.stageStep !== null && learning.stageStep === task.callStep) {
        throw new Error(`call rsi_memory_commit in a later message, after acting on the ${learning.stage === 'distill' ? 'distillation' : 'reconciliation'} instructions above`)
      }
      if (learning.stage === 'distill') return stateResult(reconciliationMessage('actor'), { rsi: 1, op: 'reconcile', episode: learning.episode })
      const draft = await store.reopenDraft(learning.episode)
      if (!draft) {
        if ((await store.isQuarantined(learning.episode)) || (await store.isQuarantined(origin))) {
          return stateResult('this learning phase could not be promoted; durable memory is unchanged', { rsi: 1, op: 'close', episode: learning.episode, terminal: true })
        }
        return stateResult('The learning draft no longer exists, so nothing was promoted. Call rsi_learn to redo the learning phase against the current memory.', { rsi: 1, op: 'close', episode: learning.episode, terminal: false })
      }
      try {
        const record = await store.commit(draft, { kind: 'task', outcome: learning.outcome, origin })
        await stores.refresh(store)
        return stateResult(
          `Memory promoted (${record.outcome} experience). created: ${record.created.join(', ') || '-'}; modified: ${record.modified.join(', ') || '-'}; deleted: ${record.deleted.join(', ') || '-'}. Tree ${record.treeAfter.slice(0, 12)}, ${record.files} files.`,
          { rsi: 1, op: 'commit', episode: learning.episode },
        )
      } catch (error) {
        if (error instanceof MemoryConflictError) {
          await store.discardDraft(learning.episode)
          return stateResult(`${error.message}. Nothing was promoted; call rsi_learn to redo the learning phase.`, { rsi: 1, op: 'close', episode: learning.episode, terminal: false })
        }
        if (error instanceof MemoryFrozenError) {
          return stateResult(`${error.message}. The draft is kept; after memory is unfrozen, call rsi_learn to continue this learning phase.`, { rsi: 1, op: 'close', episode: learning.episode, terminal: false })
        }
        if (error instanceof MemoryQuarantineError) {
          return stateResult(error.message, { rsi: 1, op: 'close', episode: learning.episode, terminal: true })
        }
        // Limits and I/O failures keep the draft open: trim or fix it, then commit again.
        throw error
      }
    },
  }))

  // ---------------------------------------------------------------- role channel
  ctx.tools.register(defineTool({
    name: 'rsi_handoff',
    description: 'Only for RSI role sub-agents started by rsi_explore or rsi_submit: deliver the handoff your instructions ask for. The result is the harness\'s next message to you. Never call this as the main agent.',
    parameters: {
      text: { type: 'string', required: true, description: 'The complete handoff text, exactly as your instructions require.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent, 'rsi_handoff')
      const role = await roleOf(agent, exec.signal)
      if (!role) throw new Error('rsi_handoff is only available inside RSI role contexts')
      // One handoff per model step: a second call in the same message would answer a message the role never read.
      if (role.stepKey !== '' && role.handoffStep === role.stepKey) {
        throw new Error('only one rsi_handoff per message: your previous handoff in this message was already delivered; read its reply above first')
      }
      role.handoffStep = role.stepKey
      const actions = role.sinceHandoff
      // Each handoff starts a new phase: both transport bounds apply per phase.
      startPhase(role)
      const next = await role.channel.handoff(args.text, actions, exec.signal)
      if (next === CLOSED) {
        exec.concludeTurn()
        return 'RSI CONTEXT COMPLETE. This context is finished; stop now.'
      }
      return next
    },
    presentCall: () => ({ card: 'generic', title: 'RSI handoff', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'rsi_notes',
    description: 'Curriculum Agent only: replace your private search notes, a recovery copy of your search state that is never shown to the Actor or Verifier.',
    parameters: {
      content: { type: 'string', required: true, description: 'The complete notes.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent, 'rsi_notes')
      const role = await roleOf(agent, exec.signal)
      if (!role || role.role !== 'curriculum' || !role.notesFile) throw new Error('rsi_notes is only available to the Curriculum Agent')
      await mkdir(dirname(role.notesFile), { recursive: true })
      await writeFile(role.notesFile, args.content, 'utf8')
      return `notes saved (${Buffer.byteLength(args.content, 'utf8')} bytes)`
    },
  }))

  // ---------------------------------------------------------------- exploration lineages
  ctx.tools.register(defineTool({
    name: 'rsi_explore',
    description: 'Run a recursive self-improvement lineage with fresh role sub-agents (long-running; blocks until it settles). phase "broad": a Curriculum Agent authors waves of practice projects with their input fixtures; each is executed by a fresh Actor, judged by a fresh effect-isolated Verifier, then distilled into memory. phase "deep": attempt a target with a fresh Actor, learn from the verdict, and practice what the Curriculum chooses until it judges the target ready. Use only when the user asks to explore, practice, or self-improve.',
    parameters: {
      phase: { type: 'string', required: true, enum: ['broad', 'deep'], description: 'broad = Phase 1 environment exploration; deep = Phase 2 target-conditioned practice.' },
      direction: {
        type: 'string',
        required: true,
        description: 'broad: the environment and task distribution to explore. deep: the immutable target task. Write it so each project root can be named by the literal placeholder <PROJECT_ROOT>.',
      },
      lineage: { type: 'string', description: 'Lineage id (lowercase letters, digits, - or _); defaults to a generated id.' },
      target_fixtures: { type: 'string', description: 'deep only: a directory inside the project whose files are replayed into every fresh target root (no symbolic links).' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => text(JSON.stringify(value, null, 2)) },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent, 'rsi_explore')
      await interactiveOnly(agent, 'rsi_explore', exec.signal)
      if (!canReserveIds) throw new Error('rsi_explore needs dsh >= 0.2.1-alpha.2: this dsh version cannot start a role sub-agent in its own project root')
      const store = await stores.forAgent(agent)
      if (await frozen(store)) throw new Error('memory is frozen for test-time reuse; exploration would change it')
      const projectDir = stores.projectDir(agent)
      const lineage = args.lineage ?? `${args.phase}-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(lineage)) throw new Error('lineage must match [a-z0-9][a-z0-9_-]{0,63}')
      const workRoot = stores.stateRoot(projectDir)
      await prepareWorkRoot(workRoot)
      const decision = await requireIsolation(workRoot)
      const paths = { workspace: join(stores.stateRoot(projectDir), 'lineages', lineage), private: join(store.root, 'lineages', lineage) }
      // Lineages are not resumable: a started id (finished or interrupted) is never reused, so its episodes stay unique.
      if (await access(join(paths.private, 'lineage.json')).then(() => true, () => false)) throw new Error(`lineage ${lineage} already exists; choose a new lineage id`)

      let targetFixtures
      if (args.target_fixtures !== undefined) {
        if (args.phase !== 'deep') throw new Error('target_fixtures applies only to phase "deep"')
        const source = resolve(projectDir, args.target_fixtures)
        const rel = relative(projectDir, source)
        if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || (await lstat(source)).isSymbolicLink()) throw new Error('target_fixtures must be a directory inside the project')
        const problem = await shapeGate(source)
        if (problem) throw new Error(`target_fixtures is not replayable: ${problem}`)
        targetFixtures = await captureTree(source, join(paths.private, 'target-fixtures'))
      }

      // Routes as they will run: empty fields inherit the calling agent's live route (RSIAgent compares effective models).
      const effective = (route: RoleRoute) => effectiveRoute(agent, config.roles[route])
      const sameRoute = (a: RoleRoute, b: RoleRoute) => effective(a).provider === effective(b).provider && effective(a).model === effective(b).model
      const escalation = Boolean(config.roles.escalation.provider || config.roles.escalation.model) && !sameRoute('escalation', 'actor')
      const engineConfig: EngineConfig = {
        ...config.exploration,
        inventoryListed: config.promptInventory,
        transport,
        verifierMechanics: decision.mode,
        escalation,
        crossModelVerifier: escalation && sameRoute('escalation', 'verifier'),
      }
      const observe = (event: EngineEvent) => logger.info('%s %o', event.type, event)
      // Every context the lineage opens is disposed when the tool settles, whatever path it takes.
      const controller = new AbortController()
      const forward = () => controller.abort(exec.signal.reason)
      if (exec.signal.aborted) forward()
      else exec.signal.addEventListener('abort', forward, { once: true })
      const deps = { runtime: runtimeFor(agent, store, controller.signal, observe, decision.mode === 'sandbox'), store, config: engineConfig, observe, signal: exec.signal }
      try {
        const result = args.phase === 'broad'
          ? await runBroadExploration(deps, { lineage, direction: args.direction, paths })
          : await runDeepExploration(deps, { lineage, target: args.direction, paths, ...(targetFixtures ? { targetFixtures } : {}) })
        return JSON.parse(JSON.stringify(result))
      } finally {
        exec.signal.removeEventListener('abort', forward)
        controller.abort()
        await stores.refresh(store)
      }
    },
    presentCall: args => ({ card: 'generic', title: `RSI ${args.phase} exploration`, kind: 'other', rawInput: args.direction }),
  }))

  // ---------------------------------------------------------------- commands (human-only; never model-visible)
  ctx.inject(['commands'], commandCtx => {
    const status = async (agent: Agent) => {
      const store = await stores.forAgent(agent)
      const inventory = await store.inventory()
      const journal = await store.journal()
      const task = taskOf(agent)
      const decision = await isolation(stores.projectDir(agent))
      const recent = journal.slice(-5).map(record => `  ${record.ts}  ${record.kind}/${record.outcome}  ${record.episode}  +${record.created.length} ~${record.modified.length} -${record.deleted.length}`)
      return [
        `RSI memory: ${store.root}`,
        `mode: ${config.mode}${(await store.isFrozen()) ? ' (frozen marker present)' : ''}`,
        `verifier isolation: ${decision.mode}${decision.unavailable ? ` (sandbox unavailable: ${decision.unavailable})` : ''}`,
        `files: ${inventory.length}, bytes: ${inventory.reduce((sum, entry) => sum + entry.bytes, 0)}, tree: ${(await store.treeHash()).slice(0, 16)}`,
        `commits: ${journal.length}`,
        `task: generation ${task.generation}, verdict ${task.verdict ?? '-'}${task.learning ? `, learning ${task.learning.stage} (${task.learning.episode})` : ''}`,
        ...(recent.length > 0 ? ['recent:', ...recent] : []),
      ].join('\n')
    }
    commandCtx.commands.register({
      name: 'rsi',
      description: 'Show RSI memory status: location, inventory size, tree hash, isolation, task state, and recent commits.',
      handler: async invocation => ({ kind: 'success', text: await status(invocation.agent) }),
    })
    commandCtx.commands.register({
      name: 'rsi-freeze',
      description: 'Freeze RSI memory for test-time reuse: it stays readable but no learning phase can change it.',
      handler: async invocation => {
        const store = await stores.forAgent(invocation.agent)
        const hash = await store.freeze()
        return { kind: 'success', text: `RSI memory frozen at tree ${hash.slice(0, 16)}.` }
      },
    })
    commandCtx.commands.register({
      name: 'rsi-unfreeze',
      description: 'Remove the RSI freeze marker so learning phases may update memory again.',
      handler: async invocation => {
        const store = await stores.forAgent(invocation.agent)
        if (await store.isFrozen()) await store.assertFrozenIntact()
        await store.unfreeze()
        return { kind: 'success', text: frozenByConfig ? 'Freeze marker removed, but config mode is still "frozen".' : 'RSI memory unfrozen.' }
      },
    })
    commandCtx.commands.register({
      name: 'rsi-eval',
      description: 'Sealed evaluation of a finished deep lineage with the configured evaluator: freezes memory, scores a copy of the final candidate, and shows the result only to you.',
      input: { hint: '<lineage id>' },
      handler: async invocation => {
        if (config.evaluation.command.length === 0) return { kind: 'error', text: 'No sealed evaluator is configured (evaluation.command).' }
        if (roles.size > 0 || verifiers.size > 0) return { kind: 'error', text: 'Role contexts are still running; evaluate only after every agent of the lineage has ended.' }
        const lineage = invocation.rawInput.trim()
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(lineage)) return { kind: 'error', text: 'Usage: /rsi-eval <lineage id>' }
        const store = await stores.forAgent(invocation.agent)
        try {
          const record = await runSealedEvaluation({
            lineage,
            lineageDir: join(store.root, 'lineages', lineage),
            resultsDir: join(store.root, 'sealed'),
            runId: new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 17),
            store,
            config: config.evaluation,
          })
          return {
            kind: 'success',
            text: `Sealed evaluation of ${lineage}: ${record.status}${record.score === undefined ? '' : `, score ${record.score}`} after ${record.attempts.length} attempt(s). Memory stays frozen (tree ${record.memoryTreeAfter.slice(0, 16)}, intact: ${record.frozenIntact}). Record: ${join(store.root, 'sealed', lineage, record.runId, 'evaluation.json')}`,
          }
        } catch (error) {
          return { kind: 'error', text: `Sealed evaluation failed (unscored): ${String(error)}` }
        }
      },
    })
  })
}
