import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { runBroadExploration, runDeepExploration, type EngineConfig } from '../src/engine/lineage.ts'
import { InfraError, type EngineEvent } from '../src/engine/types.ts'
import { MemoryStore } from '../src/memory/store.ts'
import { FakeRuntime, writeMemory } from './fake-runtime.ts'

const config: EngineConfig = {
  maxWaveProjects: 4,
  waveConcurrency: 2,
  broadProjectBudget: 10,
  deepPracticeBudget: 3,
  targetCycleBudget: 4,
  unverifiedRounds: 1,
  transportRetries: 1,
  branchRetries: 1,
  inventoryListed: 50,
  stopPolicy: 'curriculum_review',
}

let stateRoot: string
let store: MemoryStore
let events: EngineEvent[]

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-rsi-engine-'))
  store = new MemoryStore(join(stateRoot, 'store'), { maxFileBytes: 4096, maxTotalBytes: 65536, maxFiles: 64 }, { keepHistory: false })
  await store.init()
  events = []
})

const wave = (ids: string[]) => JSON.stringify({ decision: 'WAVE', rationale: 'explore the CLI', projects: ids.map(id => ({ id, instruction: `In <PROJECT_ROOT> create ${id}.txt containing ${id}.` })) })

describe('runBroadExploration', () => {
  it('runs a wave from one snapshot, then commits serially in authored order', async () => {
    let waves = 0
    const runtime = new FakeRuntime({
      curriculum: message => {
        expect(message).toContain('PHASE 1 BROAD EXPLORATION WAVE')
        return waves++ === 0 ? wave(['alpha', 'beta']) : '{"decision":"SATURATED","rationale":"coverage reached","projects":[]}'
      },
      actor: async (message, options, turn) => {
        const id = options.label.includes('alpha') ? 'alpha' : 'beta'
        if (turn === 0) {
          expect(message).toContain(`create ${id}.txt`)
          expect(message).not.toContain('<PROJECT_ROOT>')
          await writeFile(join(options.cwd, `${id}.txt`), id)
          return 'STATUS: SUBMIT\nwrote the file'
        }
        if (message.includes('MEMORY DISTILLATION')) {
          // Each branch distills against the latest canonical memory, including its sibling's commit.
          if (id === 'beta') expect(await readFile(join(options.memory.readDir!, 'alpha.md'), 'utf8')).toBe('alpha lesson')
          await writeMemory(store, options, `${id}.md`, `${id} lesson`)
          return 'draft ready'
        }
        return 'reconciled'
      },
      verifier: (message, options) => {
        expect(options.memory.access).toBe('none')
        expect(message).toContain('CREATED (1)')
        expect(message).not.toContain('STATUS: SUBMIT')
        return options.label.includes('alpha') ? 'checked the file\nVERDICT: PASS' : 'content mismatch\nVERDICT: FAIL'
      },
    })
    const result = await runBroadExploration({ runtime, store, config, observe: event => events.push(event) }, { lineage: 'l1', direction: 'a Linux CLI workspace', stateRoot })
    expect(result.termination).toBe('saturated')
    expect(result.projects.map(project => [project.id, project.verdict])).toEqual([['alpha', 'PASS'], ['beta', 'FAIL']])
    expect((await store.inventory()).map(entry => entry.path)).toEqual(['alpha.md', 'beta.md'])
    const journal = await store.journal()
    expect(journal.map(record => [record.episode, record.outcome])).toEqual([['l1-w1-alpha', 'PASS'], ['l1-w1-beta', 'FAIL']])
    expect(journal[1]!.treeBefore).toBe(journal[0]!.treeAfter)
    expect(runtime.closed).toBe(runtime.opened.length)
    // The second wave prompt carries the first wave's verbatim verifier reports and memory changes.
    const second = runtime.transcript.filter(entry => entry.label.endsWith('curriculum'))[1]!.message
    expect(second).toContain('content mismatch')
    expect(second).toContain('MEMORY CHANGES: created beta.md')
  })

  it('blocks the whole wave when a branch never reaches a verdict', async () => {
    const runtime = new FakeRuntime({
      curriculum: () => wave(['good', 'broken']),
      actor: async (message, options, turn) => {
        if (turn === 0) return 'STATUS: SUBMIT\nok'
        await writeMemory(store, options, 'x.md', 'never committed')
        return 'done'
      },
      verifier: (_message, options) => (options.label.includes('broken') ? 'I could not decide.' : 'VERDICT: PASS'),
    })
    await expect(runBroadExploration({ runtime, store, config, observe: event => events.push(event) }, { lineage: 'l2', direction: 'd', stateRoot }))
      .rejects.toBeInstanceOf(InfraError)
    expect(await store.inventory()).toEqual([])
    expect(events.some(event => event.type === 'PROJECT_RESTARTED_UNSCORED')).toBe(true)
    expect(events.some(event => event.type === 'WAVE_BLOCKED')).toBe(true)
  })

  it('rolls back Verifier effects on the candidate', async () => {
    const runtime = new FakeRuntime({
      curriculum: (_m, _o, turn) => (turn === 0 ? wave(['only']) : '{"decision":"STALLED","rationale":"nothing left","projects":[]}'),
      actor: async (_message, options, turn) => {
        if (turn === 0) {
          await writeFile(join(options.cwd, 'only.txt'), 'only')
          return 'STATUS: SUBMIT'
        }
        if (turn === 1) expect(await readFile(join(options.cwd, 'only.txt'), 'utf8')).toBe('only')
        return 'ok'
      },
      verifier: async (_message, options) => {
        await writeFile(join(options.cwd, 'only.txt'), 'tampered')
        return 'VERDICT: PASS'
      },
    })
    const result = await runBroadExploration({ runtime, store, config, observe: event => events.push(event) }, { lineage: 'l3', direction: 'd', stateRoot })
    expect(result.termination).toBe('stalled')
    expect(events.some(event => event.type === 'VERIFIER_EFFECTS_ROLLED_BACK')).toBe(true)
  })

  it('asks the same Curriculum context to republish a malformed envelope', async () => {
    const runtime = new FakeRuntime({
      curriculum: (message, _o, turn) => {
        if (turn === 0) return 'let me think about it'
        expect(message).toContain('TRANSPORT CONTINUATION')
        return '{"decision":"SATURATED","rationale":"enough","projects":[]}'
      },
      actor: () => 'unused',
      verifier: () => 'unused',
    })
    const result = await runBroadExploration({ runtime, store, config, observe: () => {} }, { lineage: 'l4', direction: 'd', stateRoot })
    expect(result).toMatchObject({ termination: 'saturated', waves: 0 })
  })
})

describe('runDeepExploration', () => {
  it('learns from a target FAIL, practices, and retries the unchanged target until PASS with readiness', async () => {
    let targetAttempts = 0
    const curriculumTurns: string[] = []
    const runtime = new FakeRuntime({
      curriculum: message => {
        curriculumTurns.push(message)
        if (curriculumTurns.length === 1) {
          expect(message).toContain('ACTOR LEARNING DIAGNOSIS')
          expect(message).toContain('diagnosis: unsure about the delimiter')
          return 'DECISION: PROJECT\nIn <PROJECT_ROOT> parse a semicolon-delimited CSV.'
        }
        return 'DECISION: READY_FOR_TARGET\npractice transferred'
      },
      actor: async (message, options, turn) => {
        if (turn === 0) {
          if (message.includes('TARGET ATTEMPT')) targetAttempts++
          return 'STATUS: SUBMIT'
        }
        if (message.includes('MEMORY DISTILLATION')) {
          await writeMemory(store, options, `${options.label.replace(/[^a-z0-9]+/gi, '_')}.md`, 'lesson')
          return 'ok'
        }
        if (message.includes('LEARNING DIAGNOSIS')) return 'diagnosis: unsure about the delimiter'
        return 'ok'
      },
      verifier: (message, options) => {
        if (options.label.includes('target#1')) return 'wrong delimiter\nVERDICT: FAIL'
        return 'VERDICT: PASS'
      },
    })
    const result = await runDeepExploration({ runtime, store, config, observe: event => events.push(event) }, { lineage: 'd1', target: 'In <PROJECT_ROOT> convert data.csv to JSON.', stateRoot })
    expect(result).toMatchObject({ termination: 'verifier_pass_curriculum_ready', targetCycles: 2, practiceProjects: 1, verdict: 'PASS' })
    expect(targetAttempts).toBe(2)
    expect((await store.journal()).map(record => record.kind)).toEqual(['target', 'practice', 'target'])
  })

  it('stops right after PASS and its memory commit under the verifier_pass policy', async () => {
    const runtime = new FakeRuntime({
      curriculum: () => { throw new Error('the Curriculum must not run') },
      actor: (_m, _o, turn) => (turn === 0 ? 'STATUS: SUBMIT' : 'ok'),
      verifier: () => 'VERDICT: PASS',
    })
    const result = await runDeepExploration({ runtime, store, config: { ...config, stopPolicy: 'verifier_pass' }, observe: () => {} }, { lineage: 'd2', target: 'In <PROJECT_ROOT> do it.', stateRoot })
    expect(result).toMatchObject({ termination: 'verifier_pass', targetCycles: 1 })
    expect(await store.journal()).toHaveLength(1)
  })

  it('gives a STALLED lineage one final target test', async () => {
    const runtime = new FakeRuntime({
      curriculum: () => 'DECISION: STALLED\nno productive hypothesis',
      actor: (_m, _o, turn) => (turn === 0 ? 'STATUS: SUBMIT' : 'ok'),
      verifier: () => 'VERDICT: FAIL',
    })
    const result = await runDeepExploration({ runtime, store, config, observe: () => {} }, { lineage: 'd3', target: 'In <PROJECT_ROOT> do it.', stateRoot })
    expect(result).toMatchObject({ termination: 'curriculum_stalled_final_target_test', targetCycles: 2, verdict: 'FAIL' })
  })

  it('collects reproducible leads after UNVERIFIED in the same Verifier context', async () => {
    let verifierTurns = 0
    const runtime = new FakeRuntime({
      curriculum: () => 'DECISION: STALLED',
      actor: (message, _o, turn) => {
        if (turn === 0) return 'STATUS: SUBMIT'
        if (message.includes('could not CONFIRM')) return 'STATUS: SUBMIT\nlead: run `python check.py`'
        return 'ok'
      },
      verifier: message => {
        verifierTurns++
        if (verifierTurns === 1) return 'VERDICT: UNVERIFIED'
        expect(message).toContain('candidate generation 2')
        expect(message).toContain('lead: run `python check.py`')
        return 'VERDICT: PASS'
      },
    })
    const result = await runDeepExploration({ runtime, store, config: { ...config, stopPolicy: 'verifier_pass' }, observe: () => {} }, { lineage: 'd4', target: 'In <PROJECT_ROOT> do it.', stateRoot })
    expect(result).toMatchObject({ termination: 'verifier_pass', verdict: 'PASS' })
    expect(runtime.opened.filter(options => options.role === 'verifier')).toHaveLength(1)
  })
})
