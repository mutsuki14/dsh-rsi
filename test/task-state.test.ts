import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { applyTask, initTask, type TaskMeta, type TaskState } from '../src/host/task-state.ts'

const header = { id: 's', origin: undefined } as unknown as SessionHeader
const sha = 'a'.repeat(64)
let seq = 0

function call(callId: string, name: string): SessionEvent {
  return { type: 'tool/call', seq: seq++, data: { turn: 1, step: 1, callId, name, arguments: '{}' } } as unknown as SessionEvent
}

function result(callId: string, meta: TaskMeta | undefined, options: { isError?: boolean, surfaceOp?: unknown } = {}): SessionEvent {
  return {
    type: 'tool/result',
    seq: seq++,
    surfaceOp: options.surfaceOp ?? 'append',
    data: {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: callId, content: [], ...(options.isError ? { isError: true } : {}) },
      ...(meta === undefined ? {} : { meta }),
    },
  } as unknown as SessionEvent
}

function fold(events: SessionEvent[], state: TaskState = initTask(header)): TaskState {
  return events.reduce(applyTask, state)
}

const submit = (generation: number, verdict: 'PASS' | 'FAIL' | 'UNVERIFIED', newTask = false, requestCount = 1): TaskMeta =>
  ({ rsi: 1, op: 'submit', newTask, generation, verdict, requestCount, report: { sha256: sha, bytes: 10 } })

describe('task projection', () => {
  it('folds submissions, learning stages, and the commit that completes a task', () => {
    const state = fold([
      call('c1', 'rsi_submit'), result('c1', submit(1, 'FAIL')),
      call('c2', 'rsi_submit'), result('c2', submit(2, 'PASS')),
    ])
    expect(state).toMatchObject({ generation: 2, verdict: 'PASS', reports: [{ generation: 1, verdict: 'FAIL' }, { generation: 2, verdict: 'PASS' }] })
    const learning = { episode: 'task-s-3', owner: 's', stage: 'distill' as const, outcome: 'PASS' as const, verdictSeq: state.verdictSeq!, stageStep: null }
    const learned = fold([
      call('c3', 'rsi_learn'), result('c3', { rsi: 1, op: 'learn', learning }),
      call('c4', 'rsi_memory_commit'), result('c4', { rsi: 1, op: 'reconcile', episode: 'task-s-3' }),
    ], state)
    expect(learned.learning).toMatchObject({ stage: 'reconcile' })
    const done = fold([call('c5', 'rsi_memory_commit'), result('c5', { rsi: 1, op: 'commit', episode: 'task-s-3' })], learned)
    expect(done).toMatchObject({ generation: 0, reports: [], verdict: null, learning: null })
  })

  it('ignores failed, cancelled, foreign, and replacement results', () => {
    const start = fold([call('c1', 'rsi_submit'), result('c1', submit(1, 'PASS'))])
    expect(fold([call('x', 'rsi_submit'), result('x', undefined, { isError: true })], start)).toMatchObject({ generation: 1, verdict: 'PASS', pending: {} })
    expect(fold([call('y', 'read'), result('y', submit(9, 'FAIL'))], start)).toMatchObject({ generation: 1 })
    expect(fold([call('z', 'rsi_submit'), result('z', submit(9, 'FAIL'), { surfaceOp: { op: 'replace' } })], start)).toMatchObject({ generation: 1 })
    expect(fold([result('c1', submit(9, 'FAIL'))], start)).toBe(start)
  })

  it('resets the Verifier lineage for a new task and remembers a terminal close', () => {
    const state = fold([
      call('c1', 'rsi_submit'), result('c1', submit(1, 'PASS')),
      call('c2', 'rsi_submit'), result('c2', submit(1, 'FAIL', true, 2)),
    ])
    expect(state.reports).toHaveLength(1)
    const closed = fold([call('c3', 'rsi_memory_commit'), result('c3', { rsi: 1, op: 'close', episode: 'e', terminal: true })], state)
    expect(closed.closedVerdictSeq).toBe(state.verdictSeq)
  })

  it('is disabled for sub-agent sessions', () => {
    const child = initTask({ id: 'c', origin: 'subagent' } as unknown as SessionHeader)
    expect(fold([call('c1', 'rsi_submit'), result('c1', submit(1, 'PASS'))], child)).toBe(child)
  })
})
