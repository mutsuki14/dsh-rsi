import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { runBroadExploration, runDeepExploration, type EngineConfig, type EnginePaths } from '../src/engine/lineage.ts'
import { InfraError, type EngineEvent, type OpenRoleOptions } from '../src/engine/types.ts'
import { MemoryStore } from '../src/memory/store.ts'
import { FakeRuntime, writeMemory } from './fake-runtime.ts'

const config: EngineConfig = {
  waveCeiling: 8,
  waveConcurrency: 2,
  broadProjectBudget: 10,
  deepPracticeBudget: 3,
  targetCycleBudget: 6,
  unverifiedRounds: 2,
  targetResumes: 1,
  branchRetries: 1,
  inventoryListed: 50,
  stopPolicy: 'curriculum_review',
  curriculumMemoryAccess: 'read_only',
  transport: { actionlessLimit: 3, ceiling: 12 },
  verifierMechanics: 'sandbox',
  escalation: false,
  crossModelVerifier: false,
}

let base: string
let store: MemoryStore
let events: EngineEvent[]
let paths: (lineage: string) => EnginePaths

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'dsh-rsi-engine-'))
  store = new MemoryStore(join(base, 'private'), { maxFileBytes: 4096, maxTotalBytes: 65536, maxFiles: 64 }, { keepHistory: false })
  await store.init()
  events = []
  paths = lineage => ({ workspace: join(base, 'workspace', 'lineages', lineage), private: join(base, 'private', 'lineages', lineage) })
})

/** The wave authoring root the charter names. */
function waveRootOf(message: string): string {
  const match = /create one nonempty fixture tree per project at:\n\s+(\S+)\/<id>/.exec(message)
  if (!match) throw new Error('no wave root in charter')
  return match[1]!
}

function fixtureRootOf(message: string): string {
  const match = /(\S+\/practice-p\d{3}\/authoring)/.exec(message)
  if (!match) throw new Error('no fixture root in charter')
  return match[1]!
}

async function fixture(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
}

const wave = (ids: string[]) => JSON.stringify({ decision: 'WAVE', rationale: 'explore the CLI', projects: ids.map(id => ({ id, instruction: `In <PROJECT_ROOT> transform input.txt into ${id}.out.` })) })
const deps = (runtime: FakeRuntime, overrides: Partial<EngineConfig> = {}) => ({ runtime, store, config: { ...config, ...overrides }, observe: (event: EngineEvent) => events.push(event) })

describe('runBroadExploration', () => {
  it('replays Curriculum fixtures, runs a wave from one snapshot, then commits serially in authored order', async () => {
    const lineage = 'l1'
    let curriculumTurn = 0
    const runtime = new FakeRuntime({
      curriculum: async message => {
        curriculumTurn++
        if (curriculumTurn === 1) {
          expect(message).toContain('PERSISTENT PHASE-1 PARALLEL SEARCH')
          expect(message).toContain('(empty — this is the first search turn)')
          const root = waveRootOf(message)
          // Stands in for the Curriculum's rsi_notes tool call.
          await writeFile(join(paths(lineage).private, 'curriculum_notes.md'), 'hypothesis: input parsing is the bottleneck')
          await fixture(join(root, 'alpha'), { 'input.txt': 'a' })
          await fixture(join(root, 'beta'), { 'input.txt': 'b', 'refs/spec.md': 'spec' })
          return wave(['alpha', 'beta'])
        }
        // The next charter carries only the latest wave, rendered RSIAgent-style, plus the private notes.
        expect(message).toContain('WAVE 1 CURRICULUM RATIONALE:\nexplore the CLI')
        expect(message).toContain('MEMORY CHANGES:\n{\n  "created": [\n    "alpha.md"')
        expect(message).toContain('content mismatch')
        expect(message).toContain('hypothesis: input parsing is the bottleneck')
        return '{"decision":"SATURATED","rationale":"coverage reached","projects":[]}'
      },
      actor: async (message, options, turn) => {
        const id = options.label.includes('alpha') ? 'alpha' : 'beta'
        if (turn === 0) {
          expect(message).toContain(`transform input.txt into ${id}.out`)
          expect(message).not.toContain('<PROJECT_ROOT>')
          expect(message).toContain('GENERIC RUNTIME OWNERSHIP BOUNDARY')
          // The fixture was replayed byte-for-byte into the fresh project root.
          expect(await readFile(join(options.cwd, 'input.txt'), 'utf8')).toBe(id === 'alpha' ? 'a' : 'b')
          await writeFile(join(options.cwd, `${id}.out`), id)
          return 'STATUS: SUBMIT\ndone'
        }
        if (message.includes('MEMORY DISTILLATION')) {
          // Each branch distills against the latest canonical memory, including its sibling's commit.
          if (id === 'beta') expect(await readFile(join(options.memory.readDir!, 'alpha.md'), 'utf8')).toBe('alpha lesson')
          await writeMemory(store, options, `${id}.md`, `${id} lesson`)
          return 'draft ready'
        }
        expect(message).not.toContain('LEARNING DIAGNOSIS')
        return 'reconciled'
      },
      verifier: (message, options) => {
        expect(options.memory.access).toBe('none')
        expect(message).toContain('CREATED (1)')
        expect(message).not.toContain('original-fixtures')
        return options.label.includes('alpha') ? 'checked the output\nVERDICT: PASS' : 'content mismatch\nVERDICT: FAIL'
      },
    })
    const result = await runBroadExploration(deps(runtime), { lineage, direction: 'a Linux CLI workspace', paths: paths(lineage) })
    expect(result).toMatchObject({ termination: 'saturated', waves: 1, officialEvaluatorCalls: 0, officialEvaluatorFeedbackEnteredLearning: false })
    expect(result.projects.map(project => [project.id, project.verdict])).toEqual([['alpha', 'PASS'], ['beta', 'FAIL']])
    expect((await store.journal()).map(record => record.episode)).toEqual(['l1-w1-alpha', 'l1-w1-beta'])
    // Captured fixtures stay private; the authoring tree is gone so branches never share a mutable copy.
    expect(await readdir(join(paths(lineage).private, 'wave-001', 'projects', 'beta', 'fixtures', 'tree', 'refs'))).toEqual(['spec.md'])
    expect(await readdir(join(paths(lineage).workspace, 'wave-001'))).toEqual(['alpha', 'beta'])
    expect(runtime.opened.find(options => options.role === 'curriculum')?.notesFile).toBe(join(paths(lineage).private, 'curriculum_notes.md'))
    expect(runtime.closed).toBe(runtime.opened.length)
  })

  it('keeps draft fixtures and continues the same Curriculum context when a declared tree is missing', async () => {
    const replies: string[] = []
    const runtime = new FakeRuntime({
      curriculum: async (message, _options, turn) => {
        if (turn === 0) return wave(['only'])
        if (turn === 1) {
          expect(message).toContain('SAME-CONTEXT WAVE CONTINUATION')
          expect(message).toContain('the fixture tree for project "only" is not replayable')
          await fixture(join(waveRootOf(replies[0]!), 'only'), { 'input.txt': 'x' })
          return wave(['only'])
        }
        return '{"decision":"STALLED","rationale":"enough","projects":[]}'
      },
      actor: (_m, _o, turn) => (turn === 0 ? 'STATUS: SUBMIT' : 'ok'),
      verifier: () => 'VERDICT: PASS',
    })
    // The continuation does not repeat the wave root, so remember it from the first charter.
    const original = runtime.scripts.curriculum
    runtime.scripts.curriculum = async (message, options, turn) => {
      if (turn === 0) replies.push(message)
      return original(message, options, turn)
    }
    const result = await runBroadExploration(deps(runtime), { lineage: 'l2', direction: 'd', paths: paths('l2') })
    expect(result).toMatchObject({ termination: 'stalled', waves: 1 })
  })

  it('blocks the whole wave, commits nothing, and records an unscored infra result', async () => {
    const runtime = new FakeRuntime({
      curriculum: async message => {
        const root = waveRootOf(message)
        await fixture(join(root, 'good'), { 'input.txt': 'g' })
        await fixture(join(root, 'broken'), { 'input.txt': 'b' })
        return wave(['good', 'broken'])
      },
      actor: (_m, _o, turn) => (turn === 0 ? 'STATUS: SUBMIT\nok' : 'done'),
      // The broken branch's Verifier never publishes a verdict and never acts.
      verifier: (_message, options) => (options.label.includes('broken') ? { text: 'I could not decide.', actions: 0 } : 'VERDICT: PASS'),
    })
    await expect(runBroadExploration(deps(runtime), { lineage: 'l3', direction: 'd', paths: paths('l3') })).rejects.toBeInstanceOf(InfraError)
    expect(await store.inventory()).toEqual([])
    expect(events.some(event => event.type === 'PROJECT_RESTARTED_UNSCORED')).toBe(true)
    expect(events.some(event => event.type === 'WAVE_BLOCKED')).toBe(true)
    const record = JSON.parse(await readFile(join(paths('l3').private, 'result.json'), 'utf8')) as { termination: string }
    expect(record.termination).toBe('infra')
    // The failed attempt is kept for recovery rather than deleted.
    expect(await readdir(join(paths('l3').workspace, 'wave-001', 'broken', 'infra_attempts'))).toEqual(['attempt_001'])
  })

  it('rolls back Verifier effects on the candidate', async () => {
    const runtime = new FakeRuntime({
      curriculum: async (message, _o, turn) => {
        if (turn > 0) return '{"decision":"STALLED","rationale":"nothing left","projects":[]}'
        await fixture(join(waveRootOf(message), 'only'), { 'input.txt': 'in' })
        return wave(['only'])
      },
      actor: async (_message, options, turn) => {
        if (turn === 0) {
          await writeFile(join(options.cwd, 'only.out'), 'only')
          return 'STATUS: SUBMIT'
        }
        if (turn === 1) expect(await readFile(join(options.cwd, 'only.out'), 'utf8')).toBe('only')
        return 'ok'
      },
      verifier: async (_message, options) => {
        await writeFile(join(options.cwd, 'only.out'), 'tampered')
        return 'VERDICT: PASS'
      },
    })
    const result = await runBroadExploration(deps(runtime), { lineage: 'l4', direction: 'd', paths: paths('l4') })
    expect(result.termination).toBe('stalled')
    expect(events.some(event => event.type === 'VERIFIER_EFFECTS_ROLLED_BACK')).toBe(true)
  })

  it('refuses an emptied project root as a transport issue and continues the same Actor', async () => {
    const actorMessages: string[] = []
    const runtime = new FakeRuntime({
      curriculum: async (message, _o, turn) => {
        if (turn > 0) return '{"decision":"STALLED","rationale":"done","projects":[]}'
        await fixture(join(waveRootOf(message), 'p'), { 'input.txt': 'in' })
        return wave(['p'])
      },
      actor: async (message, options, turn) => {
        actorMessages.push(message)
        if (turn === 0) {
          await rm(join(options.cwd, 'input.txt'))
          return 'STATUS: SUBMIT'
        }
        if (turn === 1) {
          await writeFile(join(options.cwd, 'p.out'), 'x')
          return 'STATUS: SUBMIT'
        }
        return 'ok'
      },
      verifier: () => 'VERDICT: FAIL',
    })
    await runBroadExploration(deps(runtime), { lineage: 'l5', direction: 'd', paths: paths('l5') })
    expect(actorMessages[1]).toContain('SAME-CONTEXT TRANSPORT CONTINUATION')
    expect(actorMessages[1]).toContain('must stay nonempty')
  })
})

describe('runDeepExploration', () => {
  it('learns from a target FAIL, practices on fixtures with an evidence round, and retries the unchanged target', async () => {
    const actorMessages = new Map<string, string[]>()
    const verifierMessages: string[] = []
    let curriculumTurn = 0
    const runtime = new FakeRuntime({
      curriculum: async message => {
        curriculumTurn++
        if (curriculumTurn === 1) {
          expect(message).toContain('Phase-2 target attempt 1\n\nORIGINAL REQUEST (verbatim):')
          expect(message).toContain('ACTOR LEARNING DIAGNOSIS (verbatim):\ndiagnosis: unsure about the delimiter')
          await fixture(fixtureRootOf(message), { 'data.csv': 'a;b\n1;2\n' })
          return 'DECISION: PROJECT\nIn <PROJECT_ROOT> convert data.csv (semicolon-delimited) to data.json.'
        }
        expect(message).toContain('- Phase-2 practice project p001: PASS')
        return 'DECISION: READY_FOR_TARGET\npractice transferred'
      },
      actor: async (message, options) => {
        const log = actorMessages.get(options.label) ?? []
        log.push(message)
        actorMessages.set(options.label, log)
        if (message.includes('TARGET ATTEMPT') || message.includes('NEW PROJECT')) {
          if (message.includes('NEW PROJECT')) expect(await readFile(join(options.cwd, 'data.csv'), 'utf8')).toContain('a;b')
          await writeFile(join(options.cwd, 'out.json'), '{}')
          return 'STATUS: SUBMIT'
        }
        if (message.includes('could not CONFIRM')) return 'STATUS: SUBMIT\nnarrative that must not travel\nCLAIM: json valid\nPROBE: python3 -m json.tool out.json && echo PASS'
        if (message.includes('MEMORY DISTILLATION')) {
          await writeMemory(store, options, `${options.label.replace(/[^a-z0-9]+/gi, '_')}.md`, 'lesson')
          return 'ok'
        }
        if (message.includes('LEARNING DIAGNOSIS')) return 'diagnosis: unsure about the delimiter'
        return 'ok'
      },
      verifier: (message, options) => {
        verifierMessages.push(message)
        if (options.label.includes('target#1')) return 'wrong delimiter\nVERDICT: FAIL'
        if (options.label.includes('p001') && !message.includes('LEAD 1')) {
          expect(message).toContain('pre-Actor project fixtures at')
          return 'cannot tell yet\nVERDICT: UNVERIFIED'
        }
        return 'VERDICT: PASS'
      },
    })
    const result = await runDeepExploration(deps(runtime), { lineage: 'd1', target: 'In <PROJECT_ROOT> convert data.csv to JSON.', paths: paths('d1') })
    expect(result).toMatchObject({ termination: 'verifier_pass_curriculum_ready', targetCycles: 2, practiceProjects: 1, verdict: 'PASS', officialEvaluatorCalls: 0 })
    expect(result.candidateRoot).toBe(join(paths('d1').workspace, 'target-002', 'project'))
    expect((await store.journal()).map(record => record.kind)).toEqual(['target', 'practice', 'target'])
    // Only the CLAIM/PROBE pairs reached the Verifier, as NOT_RUN leads.
    const withLeads = verifierMessages.find(message => message.includes('LEAD 1'))!
    expect(withLeads).toContain('python3 -m json.tool out.json && echo PASS')
    expect(withLeads).toContain('Harness execution classification: NOT_RUN')
    expect(withLeads).not.toContain('narrative that must not travel')
    // Learning order: distill → reconcile → diagnosis, then the harness commits.
    const practice = [...actorMessages.entries()].find(([label]) => label.includes('p001'))![1]
    const stages = practice.map(message => (message.includes('DISTILLATION') ? 'distill' : message.includes('RECONCILIATION') ? 'reconcile' : message.includes('LEARNING DIAGNOSIS') ? 'diagnosis' : '')).filter(Boolean)
    expect(stages).toEqual(['distill', 'reconcile', 'diagnosis'])
    // The original-fixture view is removed after verification.
    expect(await readdir(join(paths('d1').workspace, 'practice-p001'))).toEqual(['project'])
  })

  it('stops right after PASS and its memory commit under the verifier_pass policy', async () => {
    const runtime = new FakeRuntime({
      curriculum: () => { throw new Error('the Curriculum must not run') },
      actor: async (_m, options, turn) => {
        if (turn === 0) await writeFile(join(options.cwd, 'x'), 'x')
        return turn === 0 ? 'STATUS: SUBMIT' : 'ok'
      },
      verifier: () => 'VERDICT: PASS',
    })
    const result = await runDeepExploration(deps(runtime, { stopPolicy: 'verifier_pass' }), { lineage: 'd2', target: 'In <PROJECT_ROOT> do it.', paths: paths('d2') })
    expect(result).toMatchObject({ termination: 'verifier_pass', targetCycles: 1 })
    expect(await store.journal()).toHaveLength(1)
  })

  it('gives a STALLED lineage one final target test', async () => {
    const runtime = new FakeRuntime({
      curriculum: () => 'DECISION: STALLED\nno productive hypothesis',
      actor: async (_m, options, turn) => {
        if (turn === 0) await writeFile(join(options.cwd, 'x'), 'x')
        return turn === 0 ? 'STATUS: SUBMIT' : 'ok'
      },
      verifier: () => 'VERDICT: FAIL',
    })
    const result = await runDeepExploration(deps(runtime), { lineage: 'd3', target: 'In <PROJECT_ROOT> do it.', paths: paths('d3') })
    expect(result).toMatchObject({ termination: 'curriculum_stalled_final_target_test', targetCycles: 2, verdict: 'FAIL' })
  })

  it('resumes a stalled target attempt with a fresh Actor on the escalation route and a swapped Verifier', async () => {
    const opened: OpenRoleOptions[] = []
    let firstActorTurns = 0
    const runtime = new FakeRuntime({
      curriculum: () => 'DECISION: STALLED',
      actor: async (message, options, turn) => {
        if (!options.label.includes('resume')) {
          firstActorTurns++
          if (turn === 0) await writeFile(join(options.cwd, 'partial.txt'), 'half')
          // Never publishes a handoff and stops acting: the attempt stalls.
          return { text: 'thinking…', actions: turn === 0 ? 1 : 0 }
        }
        if (turn === 0) {
          expect(message).toContain('a previous attempt already worked on this task')
          expect(message).toContain('still unclear')
          return 'STATUS: SUBMIT'
        }
        return message.includes('LEARNING DIAGNOSIS') ? 'diag' : 'ok'
      },
      verifier: (message, options) => {
        if (options.route !== 'actor') return 'still unclear\nVERDICT: UNVERIFIED'
        // The swapped-in Verifier is told it takes over, and sees the earlier context's reports.
        expect(message).toContain('You are a fresh Verifier context on a different model')
        expect(message).toContain('PUBLISHED REPORTS OF THE EARLIER VERIFIER CONTEXT')
        return 'VERDICT: PASS'
      },
    })
    const original = runtime.open.bind(runtime)
    runtime.open = async options => {
      opened.push(options)
      return original(options)
    }
    const result = await runDeepExploration(
      deps(runtime, { stopPolicy: 'verifier_pass', escalation: true, crossModelVerifier: true }),
      { lineage: 'd4', target: 'In <PROJECT_ROOT> do it.', paths: paths('d4') },
    )
    expect(result).toMatchObject({ termination: 'verifier_pass', verdict: 'PASS' })
    // One acting segment, then three consecutive actionless ones end the segment as stalled.
    expect(firstActorTurns).toBe(4)
    expect(opened.filter(options => options.role === 'actor').map(options => options.route ?? 'actor')).toEqual(['actor', 'escalation'])
    expect(opened.filter(options => options.role === 'verifier').map(options => options.route ?? 'verifier')).toEqual(['verifier', 'actor'])
    expect(events.some(event => event.type === 'TARGET_RESUMED')).toBe(true)
  })

  it('runs a final fresh target test when the practice budget runs out', async () => {
    let curriculumTurn = 0
    const runtime = new FakeRuntime({
      curriculum: async message => {
        curriculumTurn++
        await fixture(fixtureRootOf(message), { 'in.txt': 'x' })
        return 'DECISION: PROJECT\nIn <PROJECT_ROOT> practice more.'
      },
      actor: async (_m, options, turn) => {
        if (turn === 0) await writeFile(join(options.cwd, 'o'), 'o')
        return turn === 0 ? 'STATUS: SUBMIT' : 'ok'
      },
      verifier: () => 'VERDICT: FAIL',
    })
    const result = await runDeepExploration(deps(runtime, { deepPracticeBudget: 1 }), { lineage: 'd5', target: 'In <PROJECT_ROOT> do it.', paths: paths('d5') })
    expect(result).toMatchObject({ termination: 'budget_exhausted', targetCycles: 2, practiceProjects: 1, verdict: 'FAIL' })
    expect(curriculumTurn).toBe(1)
  })

  it('replays target fixtures into every fresh target root', async () => {
    const source = join(base, 'target-src')
    await fixture(source, { 'data/input.csv': 'x,y' })
    const { captureTree } = await import('../src/engine/fixtures.ts')
    const targetFixtures = await captureTree(source, join(base, 'capture'))
    const runtime = new FakeRuntime({
      curriculum: () => 'DECISION: STALLED',
      actor: async (_m, options, turn) => {
        if (turn === 0) expect(await readFile(join(options.cwd, 'data/input.csv'), 'utf8')).toBe('x,y')
        return turn === 0 ? 'STATUS: SUBMIT' : 'ok'
      },
      verifier: () => 'VERDICT: PASS',
    })
    const result = await runDeepExploration(deps(runtime, { stopPolicy: 'verifier_pass' }), { lineage: 'd6', target: 'In <PROJECT_ROOT> do it.', paths: paths('d6'), targetFixtures })
    expect(result.termination).toBe('verifier_pass')
  })
})

describe('engine learning', () => {
  it('sends an over-limit draft back to the same Actor to trim instead of aborting the lineage', async () => {
    const small = new MemoryStore(join(base, 'small'), { maxFileBytes: 4096, maxTotalBytes: 65536, maxFiles: 2 }, { keepHistory: false })
    await small.init()
    let trimmed = false
    const runtime = new FakeRuntime({
      curriculum: async (message, _options, turn) => {
        if (turn === 0) {
          await fixture(join(waveRootOf(message), 'one'), { 'input.txt': 'x' })
          return wave(['one'])
        }
        return '{"decision":"SATURATED","rationale":"done","projects":[]}'
      },
      actor: async (message, options, turn) => {
        if (turn === 0) {
          await writeFile(join(options.cwd, 'one.out'), 'one')
          return 'STATUS: SUBMIT'
        }
        if (message.includes('MEMORY DISTILLATION')) {
          expect(message).toContain('the store\'s only limits are 2 files')
          await writeMemory(small, options, 'a.md', 'a')
          await writeMemory(small, options, 'b.md', 'b')
          // A file that slipped past the tools (e.g. written by a script) pushes the draft over the limit.
          await writeFile(join(options.memory.draft!.dir, 'c.md'), 'c')
          return 'draft ready'
        }
        if (message.includes('cannot be promoted')) {
          expect(options.memory.access).toBe('draft')
          await rm(join(options.memory.draft!.dir, 'c.md'))
          trimmed = true
          return 'trimmed'
        }
        return 'reconciled'
      },
      verifier: () => 'VERDICT: PASS',
    })
    const result = await runBroadExploration({ runtime, store: small, config, observe: event => events.push(event) }, { lineage: 'lim', direction: 'x', paths: paths('lim') })
    expect(result.termination).toBe('saturated')
    expect(trimmed).toBe(true)
    expect((await small.inventory()).map(entry => entry.path)).toEqual(['a.md', 'b.md'])
  })

  it('closes every branch Actor when serial wave learning fails', async () => {
    const runtime = new FakeRuntime({
      curriculum: async message => {
        await fixture(join(waveRootOf(message), 'first'), { 'input.txt': 'x' })
        await fixture(join(waveRootOf(message), 'second'), { 'input.txt': 'y' })
        return wave(['first', 'second'])
      },
      actor: async (message, options, turn) => {
        if (turn === 0) {
          await writeFile(join(options.cwd, 'out'), 'o')
          return 'STATUS: SUBMIT'
        }
        if (message.includes('MEMORY DISTILLATION') && options.label.includes('first')) throw new InfraError('the first Actor context died while distilling')
        return 'ok'
      },
      verifier: () => 'VERDICT: PASS',
    })
    await expect(runBroadExploration(deps(runtime), { lineage: 'leak', direction: 'x', paths: paths('leak') })).rejects.toThrow(/died while distilling/)
    // The second branch never learned, yet its Actor context is closed too: nothing stays parked.
    expect(runtime.closed).toBe(runtime.opened.length)
    expect(JSON.parse(await readFile(join(paths('leak').private, 'result.json'), 'utf8'))).toMatchObject({ termination: 'infra' })
  })
})
