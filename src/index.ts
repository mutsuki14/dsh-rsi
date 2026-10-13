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
  unverifiedMessage,
} from './roles/actor.ts'
import { verifierSystem } from './roles/verifier.ts'
import { CLOSED } from './host/channel.ts'
import { WorkspaceCheckpoint } from './host/checkpoint.ts'
import { workspaceState } from './host/git.ts'
import { applyRoleIsolation, decideIsolation, type IsolationDecision } from './host/isolation.ts'
import { RoleRegistry, type RoleContext } from './host/registry.ts'
import { runSealedEvaluation } from './host/sealed.ts'
import { dshHome, StoreRegistry } from './host/stores.ts'
import { SubagentRoleRuntime, supportsActivations, type SubagentConversation } from './host/subagent-runtime.ts'
import { applyTask, episodeFor, initTask, taskStateSchema, type TaskMeta, type TaskState } from './host/task-state.ts'

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

  const frozen = async (store: MemoryStore): Promise<boolean> => frozenByConfig || (await store.isFrozen())
  const cwdOf = (session: Session): string =>
    service<{ get(session: Session): string }>(ctx, 'workingDirectory')?.get(session) ?? session.header.cwd ?? process.cwd()
  const isolation = (): IsolationDecision => decideIsolation(ctx, config.verifier.isolation, canReserveIds)
  const requireIsolation = (): IsolationDecision => {
    const decision = isolation()
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
    stateVersion: 1,
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
      applyRoleIsolation(agent, role, cwdOf)
      return undefined
    }
    if (isSubagent(agent)) return undefined
    try {
      await stores.forAgent(agent)
    } catch (error) {
      logger.warn('could not open RSI memory for %s: %s', agent.id, error)
    }
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => {
    // Drafts survive disposal: the session can be resumed and its learning phase continued.
    void closeVerifier(agent.id)
  })
  ctx.on('session/event', (session, event) => {
    // Backstop for turns that end without turn-stopping (errors, aborts): no Verifier outlives its turn.
    if (event.type === 'turn/end' && verifiers.has(session.id)) void closeVerifier(session.id)
  })
  ctx.on('tools/result', exec => {
    const role = exec.agent ? roles.get(exec.agent.id) : undefined
    if (role && exec.name !== 'rsi_handoff') {
      role.sinceHandoff++
      role.sinceStop++
    }
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const role = roles.get(agent.id)
    if (!role) {
      // Hosts wait for children at the turn boundary; the interactive Verifier never outlives the turn.
      if (!isSubagent(agent)) await closeVerifier(agent.id)
      return
    }
    if (role.closing || role.channel.closed || role.channel.ended) return
    // RSIAgent same-context continuation: a segment that ended without a handoff resumes in the same context.
    role.stops++
    role.actionlessStops = role.sinceStop === 0 ? role.actionlessStops + 1 : 0
    role.sinceStop = 0
    if (role.actionlessStops >= transport.actionlessLimit || role.stops > transport.ceiling) return
    agent.steer(createUserMessage({ content: [{ type: 'text', text: stallContinuation() }], source: { kind: 'user' } }))
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
  const interactiveOnly = async (agent: Agent, tool: string, signal: AbortSignal) => {
    if (await roleOf(agent, signal)) throw new Error(`${tool} is not available inside an RSI role context; use rsi_handoff`)
  }

  const known = (names: readonly string[]) => names.filter(toolName => ctx.tools.get(toolName) !== undefined)
  const toolFilter = (role: RoleKind): ToolRestriction => {
    const common = ['rsi_submit', 'rsi_learn', 'rsi_memory_commit', 'rsi_explore', ...known(DELEGATION_TOOLS)]
    switch (role) {
      case 'actor':
        return { deny: [...common, 'rsi_notes'] }
      case 'curriculum':
        return {
          deny: [
            ...common,
            'rsi_memory_write',
            'rsi_memory_delete',
            ...(config.exploration.curriculumMemoryAccess === 'none' ? ['rsi_memory_list', 'rsi_memory_read', 'rsi_memory_search'] : []),
          ],
        }
      case 'verifier':
        return { deny: [...new Set([...RSI_TOOLS.filter(toolName => toolName !== 'rsi_handoff'), ...known(DELEGATION_TOOLS), ...known(config.verifier.denyTools)])] }
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

  /** Actor-private state a Verifier's file tools must not touch. */
  const hiddenFor = (store: MemoryStore) => (role: RoleKind): string[] =>
    role === 'verifier' ? [store.root, join(dshHome(), 'sessions')] : []

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
      await interactiveOnly(agent, 'rsi_submit', exec.signal)
      const task = taskOf(agent)
      if (task.learning && task.learning.owner === agent.id) throw new Error('a learning phase is open; finish it with rsi_memory_commit before submitting again')
      const decision = requireIsolation()
      const store = await stores.forAgent(agent)
      const requests = requestsOfAgent(agent).count
      const newTask = task.verdict === 'PASS' && requests > task.requestCount
      if (newTask) await closeVerifier(agent.id)
      const generation = (newTask ? 0 : task.generation) + 1
      const cwd = cwdOf(agent.session)
      const excludes = harnessPaths(cwd, agent, store)
      const before = await workspaceState(cwd, excludes)
      const checkpoint = await WorkspaceCheckpoint.take(cwd, excludes, { maxBytes: config.verifier.checkpointMaxBytes, maxFiles: config.verifier.checkpointMaxFiles })

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
      const conversation = live.conversation
      const onAbort = () => {
        verifiers.delete(agent.id)
        void conversation.abort()
      }
      exec.signal.addEventListener('abort', onAbort, { once: true })
      let result
      let changed: string[] = []
      try {
        result = await inspect(conversation, {
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
        exec.signal.removeEventListener('abort', onAbort)
        changed = await checkpoint.restore()
        await checkpoint.dispose()
      }
      if (result.kind === 'infra') {
        await closeVerifier(agent.id)
        throw new Error(`verification is unavailable: ${result.reason}. This is an infrastructure failure, not a verdict.`)
      }
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
      return stateResult(guidance + note, { rsi: 1, op: 'submit', newTask, generation, verdict: result.verdict, requestCount: requests, report: ref })
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
      await interactiveOnly(agent, 'rsi_learn', exec.signal)
      const store = await stores.forAgent(agent)
      if (await frozen(store)) throw new Error('memory is frozen for test-time reuse; no learning phase exists')
      const task = taskOf(agent)
      if (task.verdict !== 'PASS' && task.verdict !== 'FAIL') {
        throw new Error('rsi_learn needs a terminal Verifier verdict first: call rsi_submit (UNVERIFIED is not terminal)')
      }
      if (task.verdictSeq === null) throw new Error('rsi_learn needs a recorded verdict')
      if (task.closedVerdictSeq === task.verdictSeq) throw new Error('the learning phase for this verdict already ended; durable memory was not changed')
      const episode = episodeFor(agent.id, task.verdictSeq)
      if (await store.findCommit(episode)) {
        return stateResult('This experience was already promoted to durable memory; there is nothing left to learn from it.', { rsi: 1, op: 'commit', episode })
      }
      // The attempt is over: the Verifier context ends before learning starts.
      await closeVerifier(agent.id)
      await store.openDraft(episode)
      const last = task.reports.at(-1)
      const report = (last && (await store.getReport(last.sha256))) ?? '(the final report is in your history above)'
      return stateResult(distillationMessage(task.verdict, report, 'actor'), {
        rsi: 1,
        op: 'learn',
        learning: { episode, owner: agent.id, stage: 'distill', outcome: task.verdict, verdictSeq: task.verdictSeq },
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
      await interactiveOnly(agent, 'rsi_memory_commit', exec.signal)
      const learning = taskOf(agent).learning
      if (!learning) throw new Error('no learning phase is open; call rsi_learn after a terminal verdict')
      if (learning.owner !== agent.id) throw new Error('the open learning phase belongs to another session; call rsi_learn to open this session\'s own')
      const store = await stores.forAgent(agent)
      if (await store.findCommit(learning.episode)) {
        await stores.refresh(store)
        return stateResult('This learning phase was already promoted to durable memory.', { rsi: 1, op: 'commit', episode: learning.episode })
      }
      if (learning.stage === 'distill') return stateResult(reconciliationMessage('actor'), { rsi: 1, op: 'reconcile', episode: learning.episode })
      const draft = await store.reopenDraft(learning.episode)
      if (!draft) {
        return stateResult('The learning draft no longer exists, so nothing was promoted. Call rsi_learn to redo the learning phase against the current memory.', { rsi: 1, op: 'close', episode: learning.episode, terminal: false })
      }
      try {
        const record = await store.commit(draft, { kind: 'task', outcome: learning.outcome })
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
        if (error instanceof MemoryQuarantineError || error instanceof MemoryFrozenError) {
          await store.discardDraft(learning.episode)
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
      const actions = role.sinceHandoff
      role.sinceHandoff = 0
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
      const decision = requireIsolation()
      const lineage = args.lineage ?? `${args.phase}-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(lineage)) throw new Error('lineage must match [a-z0-9][a-z0-9_-]{0,63}')
      const projectDir = stores.projectDir(agent)
      const paths = { workspace: join(stores.stateRoot(projectDir), 'lineages', lineage), private: join(store.root, 'lineages', lineage) }
      if (await access(join(paths.private, 'result.json')).then(() => true, () => false)) throw new Error(`lineage ${lineage} already finished; choose a new lineage id`)

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

      const escalation = Boolean(config.roles.escalation.provider || config.roles.escalation.model)
      const engineConfig: EngineConfig = {
        ...config.exploration,
        inventoryListed: config.promptInventory,
        transport,
        verifierMechanics: decision.mode,
        escalation,
        crossModelVerifier: escalation
          && (config.roles.escalation.provider ?? '') === (config.roles.verifier.provider ?? '')
          && (config.roles.escalation.model ?? '') === (config.roles.verifier.model ?? ''),
      }
      const observe = (event: EngineEvent) => logger.info('%s %o', event.type, event)
      const deps = { runtime: runtimeFor(agent, store, exec.signal, observe, decision.mode === 'sandbox'), store, config: engineConfig, observe, signal: exec.signal }
      try {
        const result = args.phase === 'broad'
          ? await runBroadExploration(deps, { lineage, direction: args.direction, paths })
          : await runDeepExploration(deps, { lineage, target: args.direction, paths, ...(targetFixtures ? { targetFixtures } : {}) })
        return JSON.parse(JSON.stringify(result))
      } finally {
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
      const decision = isolation()
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
