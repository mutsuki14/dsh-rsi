/**
 * Role guards on every supported dsh line (this file runs on 0.2.0-rc.2 as
 * well): the Verifier's file tools cannot reach Actor-private state even where
 * the child's id is known only after its creation hooks ran.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
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
const priorDshHome = process.env.DSH_HOME

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-rsi-guard-')))
  workspace = join(base, 'ws')
  memoryDir = join(base, 'memory-root')
  sessionsDir = join(base, 'sessions')
  process.env.DSH_HOME = join(base, 'dsh-home')
  await mkdir(workspace, { recursive: true })
})

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await rm(base, { recursive: true, force: true })
  if (priorDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = priorDshHome
})

/** The dsh core composition plus a stand-in `read` tool that would return any file's content. */
async function harness(adapter: RouterAdapter, config: Partial<Rsi.Config> = {}): Promise<{ ctx: Context, main: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  // dsh 0.2.1's sub-agent runtime needs the directory owner; 0.2.0's testkit ignores the option.
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true } as unknown as Parameters<typeof mountAgentLoopTestDependencies>[1])
  ctx.tools.register(defineTool({
    name: 'read',
    description: 'read a file',
    parameters: { file_path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async args => `FILE CONTENT OF ${args.file_path}`,
  }))
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


describe('role guards on every dsh line', () => {
  it('denies the Verifier\'s file tools any Actor-private path', async () => {
    await writeFile(join(workspace, 'hello.txt'), 'hello')
    let seen = ''
    const adapter = new RouterAdapter({
      main: (_options, call) => (call === 0 ? toolCall('m0', 'rsi_submit', {}) : textResponse('done')),
      verifier: (options, call) => {
        if (call === 0) return toolCall('v0', 'read', { file_path: join(memoryDir, 'journal.jsonl') })
        seen = lastMessage(options)
        return toolCall('v1', 'rsi_handoff', { text: 'hello.txt is right.\nVERDICT: PASS' })
      },
      actor: () => textResponse('unused'),
      curriculum: () => textResponse('unused'),
    })
    const { ctx, main } = await harness(adapter)
    await ask(ctx, main, 'Create hello.txt saying hello')
    expect(adapter.errors).toEqual([])
    expect(seen).toContain('private to the Actor Agent')
    expect(seen).not.toContain('FILE CONTENT OF')
    expect(toolResults(main)[0]!.text).toMatch(/^VERDICT: PASS/)
  })
})
