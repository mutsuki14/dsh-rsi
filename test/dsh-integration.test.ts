/**
 * Full-loop integration against the real DeepSeek Harness runtime: agent loop,
 * tool runtime, system prompt, session projections, sub-agent manager and the
 * in-process `spawn` provider. Only the model is scripted; it is routed per
 * session so the main Actor, Verifier, practice Actor, and Curriculum each
 * follow their own script through real `rsi_*` tool calls.
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
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
  if (system.includes('independent Verifier Agent')) return 'verifier'
  if (system.includes('You are the Curriculum Agent')) return 'curriculum'
  if (system.includes('You are an Actor Agent in a recursive self-improvement lineage')) return 'actor'
  throw new Error(`unrouted system prompt: ${system.slice(0, 200)}`)
}

class RouterAdapter extends LlmAdapter {
  readonly calls = new Map<string, number>()
  readonly requests: Array<{ role: Role, session: string, options: GenerateOptions }> = []

  constructor(readonly scripts: Record<Role, Script>) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  readonly errors: unknown[] = []

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
}

let workspace: string
let contexts: Context[] = []

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'dsh-rsi-it-')))
})

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await rm(workspace, { recursive: true, force: true })
})

async function harness(adapter: RouterAdapter, config: Partial<Rsi.Config> = {}): Promise<{ ctx: Context, main: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlSessionPersistence, { root: join(workspace, '.sessions') })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SpawnInProcess, { providerName: 'spawn' })
  // Cordis validates the row against the exported schema and fills its defaults.
  await ctx.plugin(Rsi, config as Rsi.Config)
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
        if (call === 0) {
          const prompt = lastMessage(options)
          expect(prompt).toContain('Create hello.txt saying hello')
          expect(prompt).toContain('CANDIDATE VERIFICATION')
          return toolCall('v0', 'rsi_handoff', { text: 'Read hello.txt: it contains "hello".\nVERDICT: PASS' })
        }
        expect(lastMessage(options)).toContain('RSI CONTEXT COMPLETE')
        return textResponse('closing')
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
    expect(results[0]!.text).toContain('VERDICT: PASS')
    expect(results[1]!.text).toContain('MEMORY DISTILLATION')
    expect(results[3]!.text).toContain('MEMORY RECONCILIATION')
    expect(results[4]!.text).toContain('Memory promoted (PASS experience)')
    expect(await readFile(join(workspace, '.dsh-rsi', 'memory', 'procedures', 'hello.md'), 'utf8')).toContain('greeting file')

    const main0 = adapter.requests.find(request => request.role === 'main')!.options
    expect(systemOf(main0)).toContain('Recursive self-improvement protocol (dsh-rsi)')
    const verifierTools = adapter.requests.find(request => request.role === 'verifier')!.options.tools!.map(tool => tool.name)
    expect(verifierTools).toContain('rsi_handoff')
    expect(verifierTools).not.toContain('rsi_memory_read')
    expect(verifierTools).not.toContain('rsi_submit')
    // The Verifier never received the main Actor's own conversation.
    const verifierRequest = JSON.stringify(adapter.requests.find(request => request.role === 'verifier')!.options.messages)
    expect(verifierRequest).not.toContain('Recursive self-improvement protocol')
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

  it('runs a Phase 1 broad wave with Curriculum, practice Actor, and Verifier sub-agents', async () => {
    let curriculumHandoffs = 0
    const adapter = new RouterAdapter({
      main: (options, call) => {
        if (call === 0) return toolCall('e0', 'rsi_explore', { phase: 'broad', direction: 'A POSIX shell workspace; practice small file tasks.', lineage: 'it-broad' })
        expect(lastMessage(options)).toContain('saturated')
        return textResponse('Exploration finished.')
      },
      curriculum: (options, call) => {
        if (call > 0 && lastMessage(options).includes('RSI CONTEXT COMPLETE')) return textResponse('bye')
        curriculumHandoffs++
        if (curriculumHandoffs === 1) {
          return toolCall(`c${call}`, 'rsi_handoff', { text: JSON.stringify({ decision: 'WAVE', rationale: 'probe file creation', projects: [{ id: 'greet', instruction: 'In <PROJECT_ROOT> create greet.txt containing hi.' }] }) })
        }
        expect(lastMessage(options)).toContain('TERMINAL OUTCOME: PASS')
        return toolCall(`c${call}`, 'rsi_handoff', { text: '{"decision":"SATURATED","rationale":"one probe suffices for this test","projects":[]}' })
      },
      actor: (options, call) => {
        const last = lastMessage(options)
        if (last.includes('RSI CONTEXT COMPLETE')) return textResponse('bye')
        if (call === 0) {
          expect(last).toContain('ACTOR AGENT — NEW PROJECT')
          expect(last).not.toContain('<PROJECT_ROOT>')
          return toolCall('a0', 'rsi_handoff', { text: 'STATUS: SUBMIT\nCreated greet.txt.' })
        }
        if (last.includes('MEMORY DISTILLATION')) return toolCall(`a${call}`, 'rsi_memory_write', { path: 'lessons/greet.md', content: 'File tasks: verify content bytes.' })
        if (last.includes('draft: wrote')) return toolCall(`a${call}`, 'rsi_handoff', { text: 'Draft ready.' })
        if (last.includes('MEMORY RECONCILIATION')) return toolCall(`a${call}`, 'rsi_handoff', { text: 'Reconciled.' })
        throw new Error(`unexpected actor turn: ${last.slice(0, 200)}`)
      },
      verifier: (options, call) => {
        if (lastMessage(options).includes('RSI CONTEXT COMPLETE')) return textResponse('bye')
        return toolCall(`v${call}`, 'rsi_handoff', { text: 'greet.txt holds the required text.\nVERDICT: PASS' })
      },
    })
    const { ctx, main } = await harness(adapter)
    await ask(ctx, main, 'Explore this shell workspace and improve yourself.')

    expect(adapter.errors).toEqual([])
    const [result] = toolResults(main)
    expect(result).toMatchObject({ name: 'rsi_explore', isError: false })
    const parsed = JSON.parse(result!.text) as { termination: string, projects: Array<{ id: string, verdict: string }> }
    expect(parsed.termination).toBe('saturated')
    expect(parsed.projects.map(project => [project.id, project.verdict])).toEqual([['greet', 'PASS']])
    expect(await readFile(join(workspace, '.dsh-rsi', 'memory', 'lessons', 'greet.md'), 'utf8')).toContain('verify content bytes')
    const journal = (await readFile(join(workspace, '.dsh-rsi', 'journal.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string, episode: string })
    expect(journal).toEqual([expect.objectContaining({ kind: 'practice', episode: 'it-broad-w1-greet' })])
  })
})
