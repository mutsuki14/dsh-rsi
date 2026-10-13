/**
 * dsh-rsi — recursive self-improvement for DeepSeek Harness, after RSIAgent
 * (Zhu et al., 2026, arXiv:2609.15364).
 *
 * The main agent is the Actor. It reuses Actor-owned durable memory, submits
 * finished work to an independent Verifier sub-agent, and turns each terminal
 * verdict into memory through a distill → reconcile → atomic-commit learning
 * phase. `rsi_explore` runs the Curriculum-driven Phase 1 (broad waves) and
 * Phase 2 (deep, target-conditioned) lineages with fresh role sub-agents.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-working-directory'
import { defineTool, type ToolRestriction } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import { z } from 'zod'
import { Config } from './config.ts'
import { runBroadExploration, runDeepExploration, type EngineConfig } from './engine/lineage.ts'
import { inspect } from './engine/steps.ts'
import type { EngineEvent, RoleKind } from './engine/types.ts'
import type { MemoryDraft, MemoryStore, TerminalOutcome } from './memory/store.ts'
import type { Verdict } from './protocol/tokens.ts'
import {
  actorProtocol,
  disagreementMessage,
  distillationMessage,
  formatInventory,
  memoryPreamble,
  reconciliationMessage,
  unverifiedMessage,
} from './roles/actor.ts'
import { verifierSystem } from './roles/verifier.ts'
import { workspaceState } from './host/git.ts'
import { RoleRegistry, type RoleContext } from './host/registry.ts'
import { StoreRegistry } from './host/stores.ts'
import { SubagentRoleRuntime } from './host/subagent-runtime.ts'

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
  }
}

/** Fold bound for recent requests; `verifier.taskMessages` selects from it. */
const REQUESTS_KEPT = 16

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
] as const

const PROTOCOL_SECTION_ORDER = 2950
const MEMORY_CONTEXT_ORDER = 130

/** Interactive Actor state for one main agent, a derived cache over its tool results. */
interface TaskState {
  generation: number
  reports: string[]
  /** User-request count when the latest verdict was published. */
  requestCount: number
  verdict?: Verdict
  report?: string
  learning?: { draft: MemoryDraft, stage: 'distill' | 'reconcile', outcome: TerminalOutcome }
}

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

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('dsh-rsi')
  const roles = new RoleRegistry()
  const stores = new StoreRegistry(config)
  const tasks = new Map<string, TaskState>()
  const frozenByConfig = config.mode === 'frozen'

  const taskOf = (agent: Agent): TaskState => {
    let state = tasks.get(agent.id)
    if (!state) {
      state = { generation: 0, reports: [], requestCount: 0 }
      tasks.set(agent.id, state)
    }
    return state
  }

  const frozen = async (store: MemoryStore): Promise<boolean> => frozenByConfig || (await store.isFrozen())

  // ---------------------------------------------------------------- prompt
  ctx.sessionProjections.register<'dsh-rsi/requests', RequestsState>({
    key: 'dsh-rsi/requests',
    stateSchema: z.object({ texts: z.array(z.string()), count: z.number().int().nonnegative() }),
    init: () => ({ texts: [], count: 0 }),
    apply: (state, event) => requestsOf(event, state),
    stateVersion: 2,
  })

  ctx.systemPrompt.section({
    name: 'dsh-rsi:protocol',
    order: PROTOCOL_SECTION_ORDER,
    interpolate: false,
    text: context => (context.agent === undefined || isSubagent(context.agent) ? '' : actorProtocol(config.mode, config.verifier.allowUnverified)),
  })

  ctx.systemPrompt.context({
    name: 'dsh-rsi:memory',
    order: MEMORY_CONTEXT_ORDER,
    interpolate: false,
    text: context => {
      if (context.agent === undefined || isSubagent(context.agent)) return ''
      const inventory = stores.inventory(stores.stateRoot(stores.projectDir(context.agent)))
      return inventory === undefined ? '' : memoryPreamble(inventory, config.promptInventory)
    },
  })

  // Open the project's store before the first assembly so the inventory context is ready.
  ctx.on('agent/created', async ({ agent }) => {
    if (isSubagent(agent)) return undefined
    try {
      await stores.forAgent(agent)
    } catch (error) {
      logger.warn('could not open RSI memory for %s: %s', agent.id, error)
    }
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const learning = tasks.get(agent.id)?.learning
    tasks.delete(agent.id)
    // An unpromoted draft never becomes memory; drop its working copy with the session.
    if (learning) void stores.forAgent(agent).then(store => store.discardDraft(learning.draft.episode)).catch(() => undefined)
  })

  // ---------------------------------------------------------------- memory views
  interface MemoryView {
    store: MemoryStore
    dir: string
    draft?: MemoryDraft
    role?: RoleContext
  }

  const viewOf = async (agent: Agent, tool: string): Promise<MemoryView> => {
    const role = roles.get(agent.id)
    if (role) {
      if (role.binding.access === 'none') throw new Error(`${tool}: memory is not available in the ${role.role} context`)
      const dir = role.binding.readDir ?? role.store.canonicalDir
      return role.binding.access === 'draft' && role.binding.draft
        ? { store: role.store, dir, draft: role.binding.draft, role }
        : { store: role.store, dir, role }
    }
    const store = await stores.forAgent(agent)
    const learning = tasks.get(agent.id)?.learning
    return learning ? { store, dir: learning.draft.dir, draft: learning.draft } : { store, dir: store.canonicalDir }
  }

  const writableView = async (agent: Agent, tool: string): Promise<MemoryView & { draft: MemoryDraft }> => {
    const view = await viewOf(agent, tool)
    if (!view.draft) {
      throw new Error(`${tool}: durable memory is read-only while you work. It changes only in a learning phase after an independent verdict${view.role ? '' : ' (rsi_submit, then rsi_learn)'}.`)
    }
    return view as MemoryView & { draft: MemoryDraft }
  }

  const text = (value: string) => [{ type: 'text' as const, text: value }]

  ctx.tools.register(defineTool({
    name: 'rsi_memory_list',
    description: 'List your durable experience memory (names and sizes). During a learning phase this shows the draft being edited.',
    parameters: {
      prefix: { type: 'string', description: 'Only list paths starting with this prefix.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const view = await viewOf(requireAgent(exec.agent, 'rsi_memory_list'), 'rsi_memory_list')
      const manifest = view.draft ? await view.store.draftManifest(view.draft) : await manifestOfDir(view)
      const entries = Object.entries(manifest)
        .filter(([path]) => args.prefix === undefined || path.startsWith(args.prefix))
        .map(([path, entry]) => ({ path, bytes: entry.bytes }))
      const scope = view.draft ? 'learning draft' : 'durable memory (read-only)'
      return entries.length === 0 ? `${scope}: no files` : `${scope}: ${entries.length} files\n${formatInventory(entries)}`
    },
  }))

  const manifestOfDir = async (view: MemoryView) =>
    view.dir === view.store.canonicalDir ? view.store.manifest() : view.store.manifestAt(view.dir)

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
      const view = await viewOf(requireAgent(exec.agent, 'rsi_memory_read'), 'rsi_memory_read')
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
      const view = await viewOf(requireAgent(exec.agent, 'rsi_memory_search'), 'rsi_memory_search')
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
      const view = await writableView(requireAgent(exec.agent, 'rsi_memory_write'), 'rsi_memory_write')
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
      const view = await writableView(requireAgent(exec.agent, 'rsi_memory_delete'), 'rsi_memory_delete')
      return (await view.store.deleteDraft(view.draft, args.path)) ? `draft: deleted ${args.path}` : `draft: ${args.path} does not exist`
    },
  }))

  // ---------------------------------------------------------------- interactive Actor protocol
  const interactiveOnly = (agent: Agent, tool: string) => {
    if (roles.get(agent.id)) throw new Error(`${tool} is not available inside an RSI role context; use rsi_handoff`)
  }

  const toolFilter = (role: RoleKind): ToolRestriction => {
    const known = (names: readonly string[]) => names.filter(toolName => ctx.tools.get(toolName) !== undefined)
    switch (role) {
      case 'actor':
        return { deny: ['rsi_submit', 'rsi_learn', 'rsi_memory_commit', 'rsi_explore'] }
      case 'curriculum':
        return { deny: ['rsi_submit', 'rsi_learn', 'rsi_memory_commit', 'rsi_explore', 'rsi_memory_write', 'rsi_memory_delete'] }
      case 'verifier':
        return { deny: [...RSI_TOOLS.filter(toolName => toolName !== 'rsi_handoff'), ...known(config.verifier.denyTools)] }
      default: {
        const unreachable: never = role
        throw new Error(`unknown role ${String(unreachable)}`)
      }
    }
  }

  const agentOptions = (role: RoleKind) => {
    const route = config.roles[role]
    if (!route.provider && !route.model) return undefined
    return { ...(route.provider ? { provider: route.provider } : {}), ...(route.model ? { model: route.model } : {}) }
  }

  const runtimeFor = (parent: Agent, store: MemoryStore, signal: AbortSignal, observe: (event: EngineEvent) => void) =>
    new SubagentRoleRuntime({
      subagents: ctx.subagents,
      parent,
      provider: config.subagentProvider,
      registry: roles,
      store,
      toolFilter,
      agentOptions,
      signal,
      observe,
    })

  const authoritativeTask = (agent: Agent): string => {
    const texts = ctx.sessionProjections.stateOf(agent.session, 'dsh-rsi/requests')?.texts ?? []
    const recent = texts.slice(-config.verifier.taskMessages)
    if (recent.length === 0) return '(no user request was found in this session)'
    if (recent.length === 1) return recent[0]!
    return recent
      .map((request, index) => `[user message ${index + 1} of ${recent.length}${index === recent.length - 1 ? ', latest' : ''}]\n${request}`)
      .join('\n\n')
  }

  ctx.tools.register(defineTool({
    name: 'rsi_submit',
    description: 'Submit the current task for independent verification. A fresh Verifier Agent inspects the live result against the user\'s verbatim request without seeing your reasoning or memory, and returns PASS, FAIL, or UNVERIFIED with a report.',
    parameters: {
      evidence_leads: {
        type: 'string',
        description: 'Only after UNVERIFIED: reproducible evidence leads (exact commands or paths) the Verifier can re-run itself. Never a narrative of your own work.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          verdict: { type: 'string' },
          report: { type: 'string' },
          guidance: { type: 'string' },
        },
      },
      render: (_args, value) => text(`VERDICT: ${value.verdict ?? '?'}\n\n${value.guidance ?? ''}`),
    },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent, 'rsi_submit')
      interactiveOnly(agent, 'rsi_submit')
      let state = taskOf(agent)
      if (state.learning) throw new Error('a learning phase is open; finish it with rsi_memory_commit before submitting again')
      const requests = ctx.sessionProjections.stateOf(agent.session, 'dsh-rsi/requests')?.count ?? 0
      if (state.verdict === 'PASS' && requests > state.requestCount) {
        // A new user request after a verified task starts a new task: its Verifier inherits no reports.
        tasks.delete(agent.id)
        state = taskOf(agent)
      }
      const store = await stores.forAgent(agent)
      const cwd = ctx.get('workingDirectory')?.get(agent.session) ?? stores.projectDir(agent)
      const stateRel = relative(cwd, stores.stateRoot(stores.projectDir(agent)))
      const exclude = stateRel !== '' && !stateRel.startsWith('..') && !isAbsolute(stateRel) ? [stateRel] : []
      const before = await workspaceState(cwd, exclude)
      const leads = state.verdict === 'UNVERIFIED' ? args.evidence_leads : undefined
      state.generation++
      const runtime = runtimeFor(agent, store, exec.signal, event => logger.debug('%o', event))
      const verifier = await runtime.open({
        role: 'verifier',
        label: `rsi verifier #${state.generation}`,
        system: verifierSystem(config.verifier.allowUnverified),
        cwd,
        memory: { access: 'none' },
      })
      let result
      try {
        result = await inspect(verifier, {
          task: authoritativeTask(agent),
          generation: state.generation,
          mechanicalContext: before.summary,
          leads,
          priorReports: state.reports,
          allowUnverified: config.verifier.allowUnverified,
          retries: config.verifier.transportRetries,
          signal: exec.signal,
        })
      } finally {
        await verifier.close()
      }
      if (result.kind === 'infra') throw new Error(`verification is unavailable: ${result.reason}. This is an infrastructure failure, not a verdict.`)
      const after = before.tracked ? await workspaceState(cwd, exclude) : before
      const tamper = before.tracked && after.digest !== before.digest
        ? '\n\nHARNESS NOTE: the working tree changed during verification; inspect it before continuing.'
        : ''
      state.verdict = result.verdict
      state.report = result.report
      state.reports.push(result.report)
      state.requestCount = requests
      const learn = config.mode === 'learn' && !(await frozen(store))
      let guidance: string
      switch (result.verdict) {
        case 'PASS':
          guidance = `The independent Verifier verified the task. Report:\n---\n${result.report.trim()}\n---${learn ? '\nNext: call rsi_learn to distill this experience into durable memory.' : ''}`
          break
        case 'FAIL':
          guidance = `${disagreementMessage(result.report)}${learn ? '\nIf you decide to stop repairing, call rsi_learn: a FAIL still teaches.' : ''}`
          break
        case 'UNVERIFIED':
          guidance = `${unverifiedMessage(result.report)}\nPass the leads as evidence_leads when you call rsi_submit again.`
          break
        default: {
          const unreachable: never = result.verdict
          throw new Error(`unknown verdict ${String(unreachable)}`)
        }
      }
      return { verdict: result.verdict, report: result.report, guidance: guidance + tamper }
    },
    presentCall: () => ({ card: 'generic', title: 'RSI verification', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'rsi_learn',
    description: 'Open the learning phase after a terminal verdict (PASS, or FAIL when you stop repairing): distill this experience into a memory draft, then rsi_memory_commit.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(_args, exec) {
      const agent = requireAgent(exec.agent, 'rsi_learn')
      interactiveOnly(agent, 'rsi_learn')
      const store = await stores.forAgent(agent)
      if (await frozen(store)) throw new Error('memory is frozen for test-time reuse; no learning phase exists')
      const state = taskOf(agent)
      if (state.learning) return 'A learning phase is already open. Continue editing the draft, then call rsi_memory_commit.'
      if (state.verdict !== 'PASS' && state.verdict !== 'FAIL') {
        throw new Error('rsi_learn needs a terminal Verifier verdict first: call rsi_submit (UNVERIFIED is not terminal)')
      }
      const draft = await store.openDraft(`task-${randomUUID()}`)
      state.learning = { draft, stage: 'distill', outcome: state.verdict }
      return distillationMessage(state.verdict, state.report ?? '', 'actor')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'rsi_memory_commit',
    description: 'Learning phase: the first call asks you to reconcile the whole draft; the second call promotes it atomically to durable memory.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(_args, exec) {
      const agent = requireAgent(exec.agent, 'rsi_memory_commit')
      interactiveOnly(agent, 'rsi_memory_commit')
      const state = taskOf(agent)
      const learning = state.learning
      if (!learning) throw new Error('no learning phase is open; call rsi_learn after a terminal verdict')
      if (learning.stage === 'distill') {
        learning.stage = 'reconcile'
        return reconciliationMessage('actor')
      }
      const store = await stores.forAgent(agent)
      try {
        const record = await store.commit(learning.draft, { kind: 'task', outcome: learning.outcome })
        await stores.refresh(store)
        tasks.delete(agent.id)
        return `Memory promoted (${record.outcome} experience). created: ${record.created.join(', ') || '-'}; modified: ${record.modified.join(', ') || '-'}; deleted: ${record.deleted.join(', ') || '-'}. Tree ${record.treeAfter.slice(0, 12)}, ${record.files} files.`
      } catch (error) {
        tasks.delete(agent.id)
        await store.discardDraft(learning.draft.episode)
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
      const role = roles.get(agent.id)
      if (!role) throw new Error('rsi_handoff is only available inside RSI role contexts')
      return role.channel.handoff(args.text, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'RSI handoff', kind: 'other' }),
  }))

  // ---------------------------------------------------------------- exploration lineages
  const engineConfig: EngineConfig = {
    ...config.exploration,
    transportRetries: config.verifier.transportRetries,
    inventoryListed: config.promptInventory,
  }

  ctx.tools.register(defineTool({
    name: 'rsi_explore',
    description: 'Run a recursive self-improvement lineage with fresh role sub-agents (long-running; blocks until it settles). phase "broad": a Curriculum Agent authors waves of practice projects within the direction; each is executed by a fresh Actor, judged by a fresh Verifier, then distilled into memory. phase "deep": attempt a target with a fresh Actor, learn from the verdict, and practice what the Curriculum chooses until it judges the target ready. Use only when the user asks to explore, practice, or self-improve.',
    parameters: {
      phase: { type: 'string', required: true, enum: ['broad', 'deep'], description: 'broad = Phase 1 environment exploration; deep = Phase 2 target-conditioned practice.' },
      direction: {
        type: 'string',
        required: true,
        description: 'broad: the environment and task distribution to explore. deep: the immutable target task. Write it so each project root can be named by the literal placeholder <PROJECT_ROOT>.',
      },
      lineage: { type: 'string', description: 'Lineage id (lowercase letters, digits, - or _); defaults to a generated id.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => text(JSON.stringify(value, null, 2)) },
    async execute(args, exec) {
      const agent = requireAgent(exec.agent, 'rsi_explore')
      interactiveOnly(agent, 'rsi_explore')
      const store = await stores.forAgent(agent)
      if (await frozen(store)) throw new Error('memory is frozen for test-time reuse; exploration would change it')
      const lineage = args.lineage ?? `${args.phase}-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(lineage)) throw new Error('lineage must match [a-z0-9][a-z0-9_-]{0,63}')
      const observe = (event: EngineEvent) => logger.info('%s %o', event.type, event)
      const deps = { runtime: runtimeFor(agent, store, exec.signal, observe), store, config: engineConfig, observe, signal: exec.signal }
      const stateRoot = stores.stateRoot(stores.projectDir(agent))
      try {
        const result = args.phase === 'broad'
          ? await runBroadExploration(deps, { lineage, direction: args.direction, stateRoot })
          : await runDeepExploration(deps, { lineage, target: args.direction, stateRoot })
        return JSON.parse(JSON.stringify(result))
      } finally {
        await stores.refresh(store)
      }
    },
    presentCall: args => ({ card: 'generic', title: `RSI ${args.phase} exploration`, kind: 'other', rawInput: args.direction }),
  }))

  // ---------------------------------------------------------------- commands
  ctx.inject(['commands'], commandCtx => {
    const status = async (agent: Agent) => {
      const store = await stores.forAgent(agent)
      const inventory = await store.inventory()
      const journal = await store.journal()
      const recent = journal.slice(-5).map(record => `  ${record.ts}  ${record.kind}/${record.outcome}  ${record.episode}  +${record.created.length} ~${record.modified.length} -${record.deleted.length}`)
      return [
        `RSI memory: ${store.root}`,
        `mode: ${config.mode}${(await store.isFrozen()) ? ' (frozen marker present)' : ''}`,
        `files: ${inventory.length}, bytes: ${inventory.reduce((sum, entry) => sum + entry.bytes, 0)}, tree: ${(await store.treeHash()).slice(0, 16)}`,
        `commits: ${journal.length}`,
        ...(recent.length > 0 ? ['recent:', ...recent] : []),
      ].join('\n')
    }
    commandCtx.commands.register({
      name: 'rsi',
      description: 'Show RSI memory status: inventory size, tree hash, mode, and recent commits.',
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
  })
}
