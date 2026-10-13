/**
 * Full-loop integration against the real DeepSeek Harness runtime: agent loop,
 * tool runtime, system prompt, session projections, sub-agent manager, the
 * in-process `spawn` provider, and (where stated) the real sandbox stack. Only
 * the model is scripted; it is routed per session so the main Actor, Verifier,
 * practice Actor, and Curriculum each follow their own script through real
 * `rsi_*` tool calls.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Rsi from '../src/index.ts'

type Role = 'main' | 'verifier' | 'actor' | 'curriculum'
type Script = (options: GenerateOptions, call: number) => StreamChunk[]

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCall(id: string, name: string, args: object): StreamChunk[] {
  const callId = ToolCallId(id)
  const json = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: json } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** The rendered system prompt, carried either as `system` or as the leading system-role message. */
function systemOf(options: GenerateOptions): string {
  return options.system ?? JSON.stringify(options.messages.find(message => message.role === 'system') ?? '')
}

/** Everything after the model's previous reply: the prompt or tool result plus any runtime-context snapshot. */
function lastMessage(options: GenerateOptions): string {
  const lastAssistant = options.messages.findLastIndex(message => message.role === 'assistant')
  return JSON.stringify(options.messages.slice(lastAssistant + 1))
}

function roleOf(system: string): Role {
  if (system.includes('You are an independent Verifier Agent inspecting')) return 'verifier'
  if (system.includes('You are the Curriculum Agent')) return 'curriculum'
  if (system.includes('You are an Actor Agent in a recursive self-improvement lineage')) return 'actor'
  throw new Error(`unrouted system prompt: ${system.slice(0, 200)}`)
}

class RouterAdapter extends LlmAdapter {
  readonly calls = new Map<string, number>()
  readonly requests: Array<{ role: Role, session: string, options: GenerateOptions }> = []
  readonly errors: unknown[] = []

  constructor(readonly scripts: Record<Role, Script>) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let chunks: StreamChunk[]
    try {
      const session = String(options.sessionId ?? '?')
      const role = session === 'main' ? 'main' : roleOf(systemOf(options))
      const call = this.calls.get(session) ?? 0
      this.calls.set(session, call + 1)
      this.requests.push({ role, session, options })
      chunks = this.scripts[role](options, call)
    } catch (error) {
      // Script assertions fail inside the harness; keep them for the test to rethrow.
      this.errors.push(error)
      throw error
    }
    for (const chunk of chunks) yield chunk
  }

  sessionsOf(role: Role): string[] {
    return [...new Set(this.requests.filter(request => request.role === role).map(request => request.session))]
  }
}

let base: string
let workspace: string
let memoryDir: string
let sessionsDir: string
const contexts: Context[] = []

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-rsi-it-')))
  workspace = join(base, 'ws')
  memoryDir = join(base, 'memory-root')
  sessionsDir = join(base, 'sessions')
  await mkdir(workspace, { recursive: true })
})

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await rm(base, { recursive: true, force: true })
})

/** The dsh core composition a profile provides, without process confinement. */
async function harness(adapter: RouterAdapter, config: Partial<Rsi.Config> = {}): Promise<{ ctx: Context, main: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlSessionPersistence, { root: sessionsDir })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
  // Cordis validates the row against the exported schema and fills its defaults.
  await ctx.plugin(Rsi, { memoryDir, ...config } as Rsi.Config)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const main = await ctx.agentLoop.create(SessionId('main'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
  return { ctx, main }
}

/** The headless profile's file and process stack: workspace-write sandbox, fs and bash tools, approvals. */
async function sandboxedHarness(adapter: RouterAdapter, config: Partial<Rsi.Config> = {}): Promise<{ ctx: Context, main: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(LocalSandboxProvider)
  await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  await ctx.plugin(WorkingDirectory, { defaultDirectory: workspace })
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ShellEnv, {})
  await ctx.plugin(SandboxBashExecutor, {})
  await ctx.plugin(ToolBash, {})
  await ctx.plugin(ToolFs, {})
  await ctx.plugin(ApprovalService, {})
  await ctx.plugin(JsonlSessionPersistence, { root: sessionsDir })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
  await ctx.plugin(Rsi, { memoryDir, ...config } as Rsi.Config)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const main = await ctx.agentLoop.create(SessionId('main'), { provider: 'mock', model: 'mock' }, { cwd: workspace })
  return { ctx, main }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

async function ask(ctx: Context, agent: Agent, text: string): Promise<void> {
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
}

function toolResults(agent: Agent): Array<{ name: string, text: string, isError: boolean }> {
  const log = agent.session.snapshotEvents()
  const names = new Map<string, string>()
  for (const event of log) if (event.type === 'tool/call') names.set(String(event.data.callId), event.data.name)
  return log
    .filter((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result')
    .map(event => ({
      name: names.get(String(event.data.message.toolCallId)) ?? '?',
      text: event.data.message.content.map(block => (block.type === 'text' ? block.text : '')).join(''),
      isError: event.data.message.isError === true,
    }))
}

const memoryFile = (...path: string[]) => join(memoryDir, 'memory', ...path)

describe('dsh-rsi inside the real harness', () => {
  it('runs submit → independent Verifier → learn → reconcile → commit for the main Actor', async () => {
    await writeFile(join(workspace, 'hello.txt'), 'hello')
    const adapter = new RouterAdapter({
      main: (_options, call) => {
        switch (call) {
          case 0: return toolCall('m0', 'rsi_submit', {})
          case 1: return toolCall('m1', 'rsi_learn', {})
          case 2: return toolCall('m2', 'rsi_memory_write', { path: 'procedures/hello.md', content: 'Write the greeting file at the workspace root.' })
          case 3: return toolCall('m3', 'rsi_memory_commit', {})
          case 4: return toolCall('m4', 'rsi_memory_commit', {})
          default: return textResponse('Done and learned.')
        }
      },
      verifier: (options, call) => {
        expect(call).toBe(0)
        const prompt = lastMessage(options)
        expect(prompt).toContain('Create hello.txt saying hello')
        expect(prompt).toContain('CANDIDATE VERIFICATION')
        return toolCall('v0', 'rsi_handoff', { text: 'Read hello.txt: it contains "hello".\nVERDICT: PASS' })
      },
      actor: () => { throw new Error('no practice Actor in this flow') },
      curriculum: () => { throw new Error('no Curriculum in this flow') },
    })
    const { ctx, main } = await harness(adapter)
    await ask(ctx, main, 'Create hello.txt saying hello')
    expect(adapter.errors).toEqual([])

    const results = toolResults(main)
    expect(results.map(result => [result.name, result.isError])).toEqual([
      ['rsi_submit', false],
      ['rsi_learn', false],
      ['rsi_memory_write', false],
      ['rsi_memory_commit', false],
      ['rsi_memory_commit', false],
    ])
    expect(results[0]!.text).toMatch(/^VERDICT: PASS/)
    expect(results[1]!.text).toContain('MEMORY DISTILLATION')
    expect(results[3]!.text).toContain('MEMORY RECONCILIATION')
    expect(results[4]!.text).toContain('Memory promoted (PASS experience)')
    // Durable memory lives outside the workspace; the candidate never contains it.
    expect(await readFile(memoryFile('procedures', 'hello.md'), 'utf8')).toContain('greeting file')
    expect(existsSync(join(workspace, '.dsh-rsi'))).toBe(false)
    // A closed context ends its turn on the parked handoff: exactly one Verifier model call.
    expect(adapter.calls.get(adapter.sessionsOf('verifier')[0]!)).toBe(1)

    const main0 = adapter.requests.find(request => request.role === 'main')!.options
    expect(systemOf(main0)).toContain('Recursive self-improvement protocol (dsh-rsi)')
    const verifierTools = adapter.requests.find(request => request.role === 'verifier')!.options.tools!.map(tool => tool.name)
    expect(verifierTools).toContain('rsi_handoff')
    expect(verifierTools.filter(name => name.startsWith('rsi_'))).toEqual(['rsi_handoff'])
    const verifierRequest = JSON.stringify(adapter.requests.find(request => request.role === 'verifier')!.options.messages)
    expect(verifierRequest).not.toContain('Recursive self-improvement protocol')
    expect(verifierRequest).not.toContain('YOUR MEMORY')
  })

  it('refuses memory writes outside a learning phase', async () => {
    const adapter = new RouterAdapter({
      main: (_options, call) => (call === 0 ? toolCall('w0', 'rsi_memory_write', { path: 'x.md', content: 'sneak' }) : textResponse('ok')),
      verifier: () => textResponse('unused'),
      actor: () => textResponse('unused'),
      curriculum: () => textResponse('unused'),
    })
    const { ctx, main } = await harness(adapter)
    await ask(ctx, main, 'remember x')
    const [result] = toolResults(main)
    expect(result).toMatchObject({ name: 'rsi_memory_write', isError: true })
    expect(result!.text).toContain('read-only while you work')
  })

  it('keeps one live Verifier context within a turn, carries its reports across turns, and starts fresh for a new task', async () => {
    const inspections: Array<{ session: string, prompt: string }> = []
    const adapter = new RouterAdapter({
      main: (_options, call) => {
        switch (call) {
          case 0: return toolCall('t0', 'rsi_submit', {})
          case 1: return toolCall('t1', 'rsi_submit', {})
          case 2: return textResponse('Still failing; asking the user.')
          case 3: return toolCall('t3', 'rsi_submit', {})
          case 4: return textResponse('Task A verified.')
          case 5: return toolCall('t5', 'rsi_submit', {})
          default: return textResponse('Task B verified.')
        }
      },
      verifier: options => {
        const prompt = lastMessage(options)
        inspections.push({ session: String(options.sessionId), prompt })
        const n = inspections.length
        if (n <= 2) return toolCall(`v${n}`, 'rsi_handoff', { text: `README.md is missing the usage section (#${n}).\nVERDICT: FAIL` })
        return toolCall(`v${n}`, 'rsi_handoff', { text: 'All requirements hold.\nVERDICT: PASS' })
      },
      actor: () => textResponse('unused'),
      curriculum: () => textResponse('unused'),
    })
    const { ctx, main } = await harness(adapter)
    await ask(ctx, main, 'Task A: add a usage section to README.md')
    await ask(ctx, main, 'Please try again')
    await ask(ctx, main, 'Task B: add a license badge')
    expect(adapter.errors).toEqual([])

    expect(toolResults(main).map(result => result.text.split('\n')[0])).toEqual(['VERDICT: FAIL', 'VERDICT: FAIL', 'VERDICT: PASS', 'VERDICT: PASS'])
    // Same turn: the same live context inspects generation 2, its own evidence already in context.
    expect(inspections[1]!.session).toBe(inspections[0]!.session)
    expect(inspections[1]!.prompt).toContain('candidate generation 2')
    expect(inspections[1]!.prompt).not.toContain('YOUR PRIOR PUBLISHED REPORTS')
    // Next turn: a fresh context continues the role from its own published reports.
    expect(inspections[2]!.session).not.toBe(inspections[0]!.session)
    expect(inspections[2]!.prompt).toContain('candidate generation 3')
    expect(inspections[2]!.prompt).toContain('YOUR PRIOR PUBLISHED REPORTS')
    expect(inspections[2]!.prompt).toContain('missing the usage section (#2)')
    // New task after PASS: a new Verifier lineage with no inherited reports.
    expect(inspections[3]!.prompt).toContain('candidate generation 1')
    expect(inspections[3]!.prompt).not.toContain('missing the usage section')
    expect(inspections[3]!.prompt).toContain('Task B: add a license badge')
    // No Verifier is left running after the turns ended: nothing for the host to join.
    expect(await ctx.subagents.waitForChildren(main)).toBe(false)
  })

  it('continues a role context that ended its turn without a handoff, in the same context', async () => {
    const adapter = new RouterAdapter({
      main: (_options, call) => (call === 0 ? toolCall('c0', 'rsi_submit', {}) : textResponse('done')),
      verifier: (options, call) => {
        if (call === 0) return textResponse('Checked everything.\nVERDICT: PASS')
        expect(lastMessage(options)).toContain('SAME-CONTEXT CONTINUATION')
        return toolCall('h1', 'rsi_handoff', { text: 'Checked everything.\nVERDICT: PASS' })
      },
      actor: () => textResponse('unused'),
      curriculum: () => textResponse('unused'),
    })
    const { ctx, main } = await harness(adapter)
    await ask(ctx, main, 'check it')
    expect(adapter.errors).toEqual([])
    expect(toolResults(main)[0]!.text).toMatch(/^VERDICT: PASS/)
    expect(adapter.sessionsOf('verifier')).toHaveLength(1)
  })

  it('treats a Verifier that stays actionless as unscored infrastructure, never a verdict', async () => {
    const adapter = new RouterAdapter({
      main: (_options, call) => (call === 0 ? toolCall('c0', 'rsi_submit', {}) : textResponse('done')),
      verifier: () => textResponse('I am not sure what to do.'),
      actor: () => textResponse('unused'),
      curriculum: () => textResponse('unused'),
    })
    const { ctx, main } = await harness(adapter)
    await ask(ctx, main, 'check it')
    const [result] = toolResults(main)
    expect(result).toMatchObject({ name: 'rsi_submit', isError: true })
    expect(result!.text).toContain('infrastructure failure, not a verdict')
    expect(adapter.calls.get(adapter.sessionsOf('verifier')[0]!)).toBe(3)
  })

  it('restores candidate files a Verifier changed when isolation is rollback', async () => {
    await writeFile(join(workspace, 'app.txt'), 'original')
    const adapter = new RouterAdapter({
      main: (_options, call) => (call === 0 ? toolCall('r0', 'rsi_submit', {}) : textResponse('done')),
      verifier: () => {
        // Stands in for an inspection command that mutated the candidate.
        writeFileSync(join(workspace, 'app.txt'), 'mutated by the verifier')
        writeFileSync(join(workspace, 'stray.tmp'), 'debris')
        return toolCall('v0', 'rsi_handoff', { text: 'VERDICT: PASS' })
      },
      actor: () => textResponse('unused'),
      curriculum: () => textResponse('unused'),
    })
    const { ctx, main } = await harness(adapter, { verifier: { isolation: 'rollback' } as Rsi.Config['verifier'] })
    await ask(ctx, main, 'check app.txt')
    expect(await readFile(join(workspace, 'app.txt'), 'utf8')).toBe('original')
    expect(existsSync(join(workspace, 'stray.tmp'))).toBe(false)
    expect(toolResults(main)[0]!.text).toContain('2 path(s) changed during the inspection and were restored: app.txt, stray.tmp')
  })

  it('confines a sandboxed Verifier: read-only processes and files, hidden Actor memory, parent unaffected', async () => {
    await writeFile(join(workspace, 'a.txt'), 'candidate')
    mkdirSync(join(memoryDir, 'memory'), { recursive: true })
    writeFileSync(join(memoryDir, 'memory', 'secret.md'), 'ACTOR-PRIVATE')
    const verifierResults: string[] = []
    const adapter = new RouterAdapter({
      main: (_options, call) => {
        if (call === 0) return toolCall('p0', 'bash', { description: 'parent write', command: `echo parent > ${join(workspace, 'parent.txt')}` })
        if (call === 1) return toolCall('p1', 'rsi_submit', {})
        return textResponse('done')
      },
      verifier: (options, call) => {
        if (call > 0) verifierResults.push(lastMessage(options))
        switch (call) {
          case 0: return toolCall('b0', 'bash', { description: 'try to write', command: `echo pwned > ${join(workspace, 'a.txt')}` })
          case 1: return toolCall('b1', 'read', { file_path: join(memoryDir, 'memory', 'secret.md') })
          case 2: return toolCall('b2', 'bash', { description: 'try tmp', command: 'echo t > /tmp/dsh-rsi-verifier-probe; echo rc=$?' })
          default: return toolCall('b3', 'rsi_handoff', { text: 'a.txt holds the candidate text.\nVERDICT: PASS' })
        }
      },
      actor: () => textResponse('unused'),
      curriculum: () => textResponse('unused'),
    })
    const { ctx, main } = await sandboxedHarness(adapter)
    await ask(ctx, main, 'make a.txt hold the candidate text')
    expect(adapter.errors).toEqual([])
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('candidate')
    expect(await readFile(join(workspace, 'parent.txt'), 'utf8')).toBe('parent\n')
    expect(verifierResults[0]).toMatch(/denied|Permission denied|Read-only/i)
    expect(verifierResults[1]).toContain('private to the Actor Agent')
    expect(verifierResults[1]).not.toContain('ACTOR-PRIVATE')
    expect(verifierResults[2]).toMatch(/denied|Permission denied|Read-only|rc=1|rc=2/i)
    expect(existsSync('/tmp/dsh-rsi-verifier-probe')).toBe(false)
    const submit = toolResults(main).find(result => result.name === 'rsi_submit')!
    expect(submit.text).toMatch(/^VERDICT: PASS/)
    expect(submit.text).not.toContain('HARNESS NOTE')
    const verifierTools = adapter.requests.find(request => request.role === 'verifier')!.options.tools!.map(tool => tool.name)
    expect(verifierTools).not.toContain('write')
    expect(verifierTools).not.toContain('edit')
  })

  it('rebuilds the learning phase from the session log after a restart', async () => {
    await writeFile(join(workspace, 'hello.txt'), 'hello')
    const first = new RouterAdapter({
      main: (_options, call) => {
        switch (call) {
          case 0: return toolCall('a0', 'rsi_submit', {})
          case 1: return toolCall('a1', 'rsi_learn', {})
          case 2: return toolCall('a2', 'rsi_memory_write', { path: 'lessons/restart.md', content: 'drafted before the restart' })
          default: return textResponse('pausing')
        }
      },
      verifier: () => toolCall('v0', 'rsi_handoff', { text: 'VERDICT: PASS' }),
      actor: () => textResponse('unused'),
      curriculum: () => textResponse('unused'),
    })
    const one = await harness(first)
    await ask(one.ctx, one.main, 'Create hello.txt saying hello')
    await one.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(one.ctx), 1)

    const second = new RouterAdapter({
      main: (_options, call) => {
        switch (call) {
          case 0: return toolCall('b0', 'rsi_memory_commit', {})
          case 1: return toolCall('b1', 'rsi_memory_commit', {})
          default: return textResponse('learned')
        }
      },
      verifier: () => textResponse('unused'),
      actor: () => textResponse('unused'),
      curriculum: () => textResponse('unused'),
    })
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(JsonlSessionPersistence, { root: sessionsDir })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
    await ctx.plugin(Rsi, { memoryDir } as Rsi.Config)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], second)
    const { agent: resumed } = await ctx.agents.resume({ resumeSessionId: SessionId('main'), agentOptions: { provider: 'mock', model: 'mock' } })
    await ask(ctx, resumed, 'continue the learning phase')
    expect(second.errors).toEqual([])
    const results = toolResults(resumed).slice(-2)
    expect(results.map(result => result.isError)).toEqual([false, false])
    expect(results[0]!.text).toContain('MEMORY RECONCILIATION')
    expect(results[1]!.text).toContain('Memory promoted (PASS experience)')
    expect(await readFile(memoryFile('lessons', 'restart.md'), 'utf8')).toBe('drafted before the restart')
  })

  it('runs a Phase 1 broad wave with Curriculum fixtures, practice Actor, and Verifier sub-agents', async () => {
    let curriculumHandoffs = 0
    const adapter = new RouterAdapter({
      main: (options, call) => {
        if (call === 0) return toolCall('e0', 'rsi_explore', { phase: 'broad', direction: 'A POSIX shell workspace; practice small file tasks.', lineage: 'it-broad' })
        expect(lastMessage(options)).toContain('saturated')
        return textResponse('Exploration finished.')
      },
      curriculum: (options, call) => {
        const last = lastMessage(options)
        curriculumHandoffs++
        if (curriculumHandoffs === 1) {
          const root = /create one nonempty fixture tree per project at:\\n\s+(\S+)\/<id>/.exec(last)![1]!
          mkdirSync(join(root, 'greet'), { recursive: true })
          writeFileSync(join(root, 'greet', 'name.txt'), 'world')
          return toolCall(`c${call}`, 'rsi_handoff', { text: JSON.stringify({ decision: 'WAVE', rationale: 'probe file creation', projects: [{ id: 'greet', instruction: 'In <PROJECT_ROOT> create greet.txt saying hi to the name in name.txt.' }] }) })
        }
        expect(last).toContain('TERMINAL OUTCOME: PASS')
        return toolCall(`c${call}`, 'rsi_handoff', { text: '{"decision":"SATURATED","rationale":"one probe suffices for this test","projects":[]}' })
      },
      actor: (options, call) => {
        const last = lastMessage(options)
        if (call === 0) {
          expect(last).toContain('ACTOR AGENT — NEW PROJECT')
          expect(last).not.toContain('<PROJECT_ROOT>')
          const root = /PROJECT ROOT: (\S+)/.exec(last)![1]!.replace(/\\n.*$/, '')
          expect(existsSync(join(root, 'name.txt'))).toBe(true)
          writeFileSync(join(root, 'greet.txt'), 'hi world')
          return toolCall('a0', 'rsi_handoff', { text: 'STATUS: SUBMIT\nCreated greet.txt.' })
        }
        if (last.includes('MEMORY DISTILLATION')) return toolCall(`a${call}`, 'rsi_memory_write', { path: 'lessons/greet.md', content: 'File tasks: verify content bytes.' })
        if (last.includes('draft: wrote')) return toolCall(`a${call}`, 'rsi_handoff', { text: 'Draft ready.' })
        if (last.includes('MEMORY RECONCILIATION')) return toolCall(`a${call}`, 'rsi_handoff', { text: 'Reconciled.' })
        throw new Error(`unexpected actor turn: ${last.slice(0, 200)}`)
      },
      verifier: (_options, call) => toolCall(`v${call}`, 'rsi_handoff', { text: 'greet.txt holds the required text.\nVERDICT: PASS' }),
    })
    const { ctx, main } = await harness(adapter)
    await ask(ctx, main, 'Explore this shell workspace and improve yourself.')
    expect(adapter.errors).toEqual([])

    const [result] = toolResults(main)
    expect(result).toMatchObject({ name: 'rsi_explore', isError: false })
    const parsed = JSON.parse(result!.text) as { termination: string, projects: Array<{ id: string, verdict: string }>, officialEvaluatorCalls: number }
    expect(parsed).toMatchObject({ termination: 'saturated', officialEvaluatorCalls: 0 })
    expect(parsed.projects.map(project => [project.id, project.verdict])).toEqual([['greet', 'PASS']])
    expect(await readFile(memoryFile('lessons', 'greet.md'), 'utf8')).toContain('verify content bytes')
    const journal = (await readFile(join(memoryDir, 'journal.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string, episode: string })
    expect(journal).toEqual([expect.objectContaining({ kind: 'practice', episode: 'it-broad-w1-greet' })])
    // Role children never get delegation or interactive RSI tools.
    const actorTools = adapter.requests.find(request => request.role === 'actor')!.options.tools!.map(tool => tool.name)
    expect(actorTools).not.toContain('rsi_submit')
    expect(actorTools).not.toContain('rsi_explore')
    expect(await ctx.subagents.waitForChildren(main)).toBe(false)
  })
})
