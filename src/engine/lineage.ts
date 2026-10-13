import { appendFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MemoryQuarantineError, type CommitRecord, type MemoryStore } from '../memory/store.ts'
import { parseDecision, type Verdict } from '../protocol/tokens.ts'
import { parseWave, PROJECT_ROOT_PLACEHOLDER, type WaveProject } from '../protocol/wave.ts'
import {
  engineActorSystem,
  leadsRequest,
  practiceActorCharter,
  resumeHandoffMessage,
  resumePivotMessage,
  targetActorCharter,
  unverifiedMessage,
} from '../roles/actor.ts'
import {
  curriculumSystem,
  curriculumTransportContinuation,
  DEEP_DECISIONS,
  deepCharter,
  waveCharter,
  waveContinuation,
  type CurriculumMemoryAccess,
  type DeepDecision,
} from '../roles/curriculum.ts'
import { verifierSystem, type VerifierMechanics } from '../roles/verifier.ts'
import { converse } from './converse.ts'
import { captureTree, moveAside, removeView, replayTree, shapeGate, stageReadOnlyView, verifyTree, type TreeCapture } from './fixtures.ts'
import { formatLeads, inspect, leadsProblem, learn, parseLeads, runHandoffPhase } from './steps.ts'
import {
  InfraError,
  TransportInfraError,
  type EngineObserver,
  type MemoryBinding,
  type RoleConversation,
  type RoleRoute,
  type RoleRuntime,
  type TransportPolicy,
} from './types.ts'
import { describeDelta, discardableCopy, projectManifest, treeFingerprint } from './workspace.ts'

export interface EngineConfig {
  /** Phase 1: host capacity ceiling for one wave; never disclosed unless exceeded. */
  waveCeiling: number
  /** Phase 1: branches of one wave that run at the same time (host capacity, not wave width). */
  waveConcurrency: number
  /** Phase 1: complete-project budget, checked only at wave boundaries. */
  broadProjectBudget: number
  /** Phase 2: emergency ceiling on practice projects; a final fresh target test always follows practice. */
  deepPracticeBudget: number
  /** Phase 2: emergency ceiling on target attempts. */
  targetCycleBudget: number
  /** Consecutive failed submissions (UNVERIFIED rounds) before an attempt counts as stalled (RSIAgent max_consec_done). */
  unverifiedRounds: number
  /** Phase 2: fresh-context resumes of a stalled target attempt. */
  targetResumes: number
  /** Restarts of a branch that hit runtime infrastructure trouble before a verdict (unscored). */
  branchRetries: number
  /** Inventory lines listed in a fresh Actor's opening message. */
  inventoryListed: number
  /** `curriculum_review` lets the Curriculum request more practice after a target PASS. */
  stopPolicy: 'curriculum_review' | 'verifier_pass'
  curriculumMemoryAccess: CurriculumMemoryAccess
  transport: TransportPolicy
  verifierMechanics: VerifierMechanics
  /** A resumed target Actor uses the escalation route. */
  escalation: boolean
  /** When the escalation route equals the Verifier's, the resumed segment's Verifier takes the original Actor route. */
  crossModelVerifier: boolean
}

export interface EnginePaths {
  /** Workspace-visible lineage root: project roots, fixture authoring roots, comparison views. */
  workspace: string
  /** Harness-private lineage root outside every role's working directory: records, captures, snapshots, notes. */
  private: string
}

export interface EngineDeps {
  runtime: RoleRuntime
  store: MemoryStore
  config: EngineConfig
  observe: EngineObserver
  signal?: AbortSignal
}

export interface ProjectOutcome {
  id: string
  instruction: string
  verdict: Exclude<Verdict, 'UNVERIFIED'>
  reports: string[]
  diagnosis?: string
  commit?: CommitRecord
}

interface SealedInvariants {
  /** RSIAgent asserts the official evaluator never runs inside a learning phase. */
  officialEvaluatorCalls: 0
  officialEvaluatorFeedbackEnteredLearning: false
}

export interface BroadResult extends SealedInvariants {
  lineage: string
  termination: 'saturated' | 'stalled' | 'budget_exhausted'
  rationale: string
  waves: number
  projects: ProjectOutcome[]
  memoryHash: string
}

export interface DeepResult extends SealedInvariants {
  lineage: string
  termination:
    | 'verifier_pass'
    | 'verifier_pass_curriculum_ready'
    | 'verifier_pass_curriculum_stalled'
    | 'curriculum_stalled_final_target_test'
    | 'target_harness_unverified'
    | 'budget_exhausted'
  targetCycles: number
  practiceProjects: number
  verdict: Verdict
  report: string
  /** Project root of the final target attempt. */
  candidateRoot: string
  /** Harness-private copy of that candidate as the lineage ended: what a sealed evaluation measures. */
  candidateCopy: string
  /** `treeFingerprint` of the candidate at the end of the lineage. */
  candidateDigest: string
  memoryHash: string
}

const SEALED: SealedInvariants = { officialEvaluatorCalls: 0, officialEvaluatorFeedbackEnteredLearning: false }

class Lineage {
  readonly ws: string
  readonly priv: string

  constructor(readonly deps: EngineDeps, readonly id: string, paths: EnginePaths) {
    this.ws = paths.workspace
    this.priv = paths.private
  }

  get notesFile(): string {
    return join(this.priv, 'curriculum_notes.md')
  }

  async notes(): Promise<string> {
    try {
      return await readFile(this.notesFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }

  async init(meta: Record<string, unknown>): Promise<void> {
    await mkdir(this.ws, { recursive: true })
    await mkdir(this.priv, { recursive: true })
    await writeFile(join(this.priv, 'lineage.json'), `${JSON.stringify({ id: this.id, ...meta, workspace: this.ws, startedAt: new Date().toISOString() }, null, 2)}\n`)
  }

  async event(type: string, data: Record<string, unknown> = {}): Promise<void> {
    const event = { type, lineage: this.id, ts: new Date().toISOString(), ...data }
    this.deps.observe(event)
    await appendFile(join(this.priv, 'events.jsonl'), `${JSON.stringify(event)}\n`)
  }

  async finish(result: object): Promise<void> {
    await writeFile(join(this.priv, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  }

  /** Infrastructure, quarantine, and cancellation end the lineage unscored, with an explicit record. */
  async fail(error: unknown): Promise<never> {
    const termination = this.deps.signal?.aborted
      ? 'aborted'
      : error instanceof MemoryQuarantineError ? 'quarantined' : error instanceof InfraError ? 'infra' : 'error'
    await this.event('LINEAGE_ABORTED', { termination, reason: String(error) })
    await this.finish({ lineage: this.id, termination, reason: String(error), memoryHash: await this.deps.store.treeHash(), ...SEALED })
    throw error
  }

  open(role: 'actor' | 'verifier' | 'curriculum', label: string, system: string, cwd: string, memory: MemoryBinding, route?: RoleRoute): Promise<RoleConversation> {
    return this.deps.runtime.open({
      role,
      label: `${this.id} ${label}`,
      system,
      cwd,
      memory,
      ...(route === undefined ? {} : { route }),
      ...(role === 'curriculum' ? { notesFile: this.notesFile } : {}),
    })
  }
}

function readBinding(dir: string): MemoryBinding {
  return { access: 'read', readDir: dir }
}

async function pool<T, R>(items: readonly T[], width: number, run: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      try {
        results[index] = { status: 'fulfilled', value: await run(items[index]!, index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, worker))
  return results
}

/** RSIAgent `practice_loop._outcome_text`: only the project, the verdict, and the Verifier's own evidence. */
function outcomeText(index: string, outcome: ProjectOutcome): string {
  return [
    `PROJECT ${index}`,
    `ORIGINAL NATURAL-LANGUAGE PROJECT (verbatim):\n${outcome.instruction}`,
    `TERMINAL OUTCOME: ${outcome.verdict}`,
    ...outcome.reports.map((report, i) => `VERIFIER REPORT ${i + 1} (verbatim):\n${report.trim()}`),
  ].join('\n\n')
}

/** RSIAgent `_memory_changes`: sorted created, deleted, modified, and unchanged file names. */
function memoryChanges(commit: CommitRecord, unchanged: readonly string[]): string {
  const changes = { created: commit.created, deleted: commit.deleted, modified: commit.modified, unchanged: [...unchanged].sort() }
  return `MEMORY CHANGES:\n${JSON.stringify(changes, null, 2)}`
}

/** RSIAgent `target_learning._outcome_text` (Phase 2). */
function phase2OutcomeText(label: string, request: string, verdict: string, report: string, diagnosis: string): string {
  return [
    label,
    `ORIGINAL REQUEST (verbatim):\n${request}`,
    `TERMINAL OUTCOME: ${verdict}`,
    `VERIFIER REPORT (verbatim):\n${report.trim()}`,
    `ACTOR LEARNING DIAGNOSIS (verbatim):\n${diagnosis.trim() || '(none)'}`,
  ].join('\n\n')
}

interface VerifiedProject {
  project: WaveProject
  verdict: Exclude<Verdict, 'UNVERIFIED'>
  reports: string[]
  actor: RoleConversation
  binding: MemoryBinding
}

interface ProjectOptions {
  episodeDir: string
  fixtures: TreeCapture
  memoryDir: string
  /** Phase 2 practice: UNVERIFIED asks the same Actor for evidence leads, and the Verifier sees the original fixtures. */
  phase2: boolean
}

async function shapeProblem(root: string): Promise<string | undefined> {
  const problem = await shapeGate(root)
  return problem === undefined ? undefined : `the project root must stay nonempty and hold only regular files and directories (${problem})`
}

/**
 * One inspection with the candidate protected from Verifier effects: the
 * candidate is checkpointed, inspected, hash-checked, and restored if it changed.
 */
async function protectedInspection(
  lineage: Lineage,
  verifier: RoleConversation,
  input: {
    root: string
    checkpointDir: string
    task: string
    generation: number
    before: Awaited<ReturnType<typeof projectManifest>>
    leads?: string
    allowUnverified: boolean
    originalFixtures?: string
    label: string
    /** A fresh Verifier on another model taking over, with the earlier context's published reports. */
    handover?: { priorReports: readonly string[] }
  },
) {
  const { config, signal } = lineage.deps
  const after = await projectManifest(input.root)
  // The integrity check covers the whole tree (.git, dependency trees, caches), not the summary's view of it.
  const fingerprint = await treeFingerprint(input.root)
  await rm(input.checkpointDir, { recursive: true, force: true })
  await discardableCopy(input.root, input.checkpointDir)
  try {
    const result = await inspect(verifier, {
      task: input.task,
      generation: input.generation,
      mechanicalContext: describeDelta(input.root, input.before, after),
      ...(input.leads ? { leads: input.leads } : {}),
      ...(input.originalFixtures ? { originalFixtures: input.originalFixtures } : {}),
      ...(input.handover ? { handover: 'other-verifier' as const, priorReports: input.handover.priorReports } : {}),
      allowUnverified: input.allowUnverified,
      policy: config.transport,
      ...(signal ? { signal } : {}),
    })
    if ((await treeFingerprint(input.root)) !== fingerprint) {
      // Verifier effects never reach the candidate: restore the captured checkpoint.
      await rm(input.root, { recursive: true, force: true })
      await cp(input.checkpointDir, input.root, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
      await lineage.event('VERIFIER_EFFECTS_ROLLED_BACK', { candidate: input.label, generation: input.generation })
    }
    return result
  } finally {
    await rm(input.checkpointDir, { recursive: true, force: true })
  }
}

/**
 * One practice episode: replay the Curriculum's fixtures into a fresh project
 * root → fresh Actor → SUBMIT → fresh Verifier with rollback protection →
 * PASS or FAIL. The Actor context stays open for learning at a valid boundary.
 */
async function runProject(lineage: Lineage, project: WaveProject, options: ProjectOptions): Promise<VerifiedProject> {
  const { config, store, signal } = lineage.deps
  const root = join(options.episodeDir, 'project')
  await mkdir(options.episodeDir, { recursive: true })
  await replayTree(options.fixtures, root)
  const binding = readBinding(options.memoryDir)
  const actor = await lineage.open('actor', `${project.id} actor`, engineActorSystem(), root, binding)
  try {
    const instruction = project.instruction.split(PROJECT_ROOT_PLACEHOLDER).join(root)
    const before = await projectManifest(root)
    const inventory = Object.entries(await store.manifestAt(options.memoryDir)).map(([path, entry]) => ({ path, bytes: entry.bytes }))
    let handoff = await runHandoffPhase(actor, practiceActorCharter(project.instruction, root, inventory, config.inventoryListed), config.transport, {
      validate: () => shapeProblem(root),
      ...(signal ? { signal } : {}),
    })
    await lineage.event('PROJECT_SUBMITTED', { project: project.id })

    const view = options.phase2 ? join(options.episodeDir, 'original-fixtures') : undefined
    if (view) await stageReadOnlyView(options.fixtures, view)
    const verifier = await lineage.open('verifier', `${project.id} verifier`, verifierSystem(options.phase2, config.verifierMechanics), root, { access: 'none' })
    const reports: string[] = []
    try {
      let leads: string | undefined
      let failedRounds = 0
      for (let generation = 1; ; generation++) {
        const result = await protectedInspection(lineage, verifier, {
          root,
          checkpointDir: join(options.episodeDir, 'candidate.checkpoint'),
          task: instruction,
          generation,
          before,
          ...(leads ? { leads } : {}),
          allowUnverified: options.phase2,
          ...(view ? { originalFixtures: view } : {}),
          label: project.id,
        })
        if (view && !(await verifyTree(view, options.fixtures))) throw new InfraError(`${project.id}: the original-fixture view changed during verification`)
        if (result.kind === 'infra') throw new InfraError(result.reason)
        reports.push(result.report)
        await lineage.event('PROJECT_VERIFIED', { project: project.id, generation, verdict: result.verdict })
        if (result.verdict !== 'UNVERIFIED') {
          return { project, verdict: result.verdict, reports, actor, binding }
        }
        // The role's own outcome, not runtime trouble: the branch is not restarted.
        if (++failedRounds >= config.unverifiedRounds) throw new TransportInfraError(`${project.id}: ${failedRounds} UNVERIFIED rounds without a terminal verdict`)
        handoff = await runHandoffPhase(actor, `${unverifiedMessage(result.report)}\n\n${leadsRequest()}`, config.transport, {
          validate: async body => (await shapeProblem(root)) ?? leadsProblem(body),
          ...(signal ? { signal } : {}),
        })
        leads = formatLeads(parseLeads(handoff))
      }
    } finally {
      await verifier.close()
      if (view) await removeView(view)
    }
  } catch (error) {
    await actor.close()
    throw error
  }
}

async function runProjectWithRetry(lineage: Lineage, project: WaveProject, options: ProjectOptions): Promise<VerifiedProject> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runProject(lineage, project, options)
    } catch (error) {
      // Only runtime infrastructure before a verdict restarts a branch; transport exhaustion is the role's own outcome.
      if (!(error instanceof InfraError) || error instanceof TransportInfraError || attempt >= lineage.deps.config.branchRetries) throw error
      const moved = await moveAside(join(options.episodeDir, 'project'), join(options.episodeDir, 'infra_attempts'))
      await lineage.event('PROJECT_RESTARTED_UNSCORED', { project: project.id, reason: error.message, preserved: moved })
    }
  }
}

/** Captures each declared wave fixture tree and removes the authoring copies, so branches never share a mutable tree. */
async function captureWave(lineage: Lineage, waveRoot: string, privWave: string, projects: readonly WaveProject[]): Promise<Map<string, TreeCapture>> {
  const captures = new Map<string, TreeCapture>()
  // Under projects/, so no project id can collide with the wave's memory snapshot.
  for (const project of projects) captures.set(project.id, await captureTree(join(waveRoot, project.id), join(privWave, 'projects', project.id, 'fixtures')))
  await rm(waveRoot, { recursive: true, force: true })
  await lineage.event('WAVE_FIXTURES_CAPTURED', { projects: projects.map(project => project.id) })
  return captures
}

/**
 * Phase 1 — Broad Recursive Self-exploration. The Curriculum authors waves of
 * independent projects with their fixtures; every branch starts from the same
 * pre-wave snapshot; after the complete wave is verified, the same Actor
 * contexts distill serially in authored order, each against the latest
 * canonical memory.
 */
export async function runBroadExploration(deps: EngineDeps, input: { lineage: string, direction: string, paths: EnginePaths }): Promise<BroadResult> {
  const lineage = new Lineage(deps, input.lineage, input.paths)
  await lineage.init({ phase: 'broad', direction: input.direction })
  const { config, store, signal } = deps
  const memory: MemoryBinding = config.curriculumMemoryAccess === 'none' ? { access: 'none' } : readBinding(store.canonicalDir)
  let curriculum: RoleConversation | undefined
  try {
    curriculum = await lineage.open('curriculum', 'curriculum', curriculumSystem(config.curriculumMemoryAccess), lineage.ws, memory)
    const projects: ProjectOutcome[] = []
    let priorWave = ''
    let wave = 0
    const finish = async (termination: BroadResult['termination'], rationale: string): Promise<BroadResult> => {
      const result: BroadResult = { lineage: input.lineage, termination, rationale, waves: wave, projects, memoryHash: await store.treeHash(), ...SEALED }
      await lineage.event('PHASE1_TERMINATED', { termination })
      await lineage.finish(result)
      return result
    }
    while (true) {
      if (projects.length >= config.broadProjectBudget) return await finish('budget_exhausted', 'complete-project budget reached at a wave boundary')
      const waveName = `wave-${String(wave + 1).padStart(3, '0')}`
      const waveRoot = join(lineage.ws, waveName, 'authoring')
      await mkdir(waveRoot, { recursive: true })
      const decision = await converse(
        curriculum,
        waveCharter({ direction: input.direction, priorWave, waveRoot, notes: await lineage.notes() }),
        async reply => {
          const parsed = parseWave(reply.text)
          if (!parsed) return { ok: false, detail: 'the handoff is not one JSON object with decision WAVE (a nonempty project list with unique lowercase ids, each instruction naming <PROJECT_ROOT>), SATURATED, or STALLED with an empty project list' }
          if (parsed.decision === 'WAVE') {
            if (parsed.projects.length > config.waveCeiling) return { ok: false, detail: `this host can run at most ${config.waveCeiling} projects in one wave` }
            for (const project of parsed.projects) {
              const problem = await shapeGate(join(waveRoot, project.id))
              if (problem) return { ok: false, detail: `the fixture tree for project "${project.id}" is not replayable: ${problem}` }
            }
          }
          return { ok: true, value: parsed }
        },
        detail => waveContinuation(detail, waveRoot),
        config.transport,
        'Curriculum Agent',
        signal,
      )
      if (decision.decision !== 'WAVE') {
        await rm(join(lineage.ws, waveName), { recursive: true, force: true })
        return await finish(decision.decision === 'SATURATED' ? 'saturated' : 'stalled', decision.rationale)
      }
      wave++
      await lineage.event('WAVE_AUTHORED', { wave, projects: decision.projects.map(project => project.id), rationale: decision.rationale })

      const privWave = join(lineage.priv, waveName)
      const snapshot = join(privWave, 'memory_snapshot')
      await rm(snapshot, { recursive: true, force: true })
      await mkdir(privWave, { recursive: true })
      await cp(store.canonicalDir, snapshot, { recursive: true })
      const captures = await captureWave(lineage, waveRoot, privWave, decision.projects)

      const settled = await pool(decision.projects, config.waveConcurrency, project =>
        runProjectWithRetry(lineage, project, { episodeDir: join(lineage.ws, waveName, project.id), fixtures: captures.get(project.id)!, memoryDir: snapshot, phase2: false }))
      const failed = settled.find(result => result.status === 'rejected')
      if (failed) {
        // Wave barrier: an incomplete branch blocks the wave and no memory is merged.
        for (const result of settled) if (result.status === 'fulfilled') await result.value.actor.close()
        await lineage.event('WAVE_BLOCKED', { wave, reason: String((failed as PromiseRejectedResult).reason) })
        throw (failed as PromiseRejectedResult).reason
      }

      const verified = settled.map(result => (result as PromiseFulfilledResult<VerifiedProject>).value)
      const rendered: string[] = []
      try {
        for (const [index, branch] of verified.entries()) {
          try {
            const learning = await learn(branch.actor, {
              store,
              binding: branch.binding,
              episode: `${input.lineage}-w${wave}-${branch.project.id}`,
              kind: 'practice',
              outcome: branch.verdict,
              report: branch.reports.at(-1)!,
              diagnosis: false,
              policy: config.transport,
              ...(signal ? { signal } : {}),
            })
            const outcome: ProjectOutcome = { id: branch.project.id, instruction: branch.project.instruction, verdict: branch.verdict, reports: branch.reports, commit: learning.commit }
            projects.push(outcome)
            rendered.push(`${outcomeText(`${wave}.${index + 1} (${branch.project.id})`, outcome)}\n\n${memoryChanges(learning.commit, learning.unchanged)}`)
            await lineage.event('MEMORY_COMMITTED', { wave, project: branch.project.id, tree: learning.commit.treeAfter })
          } finally {
            await branch.actor.close()
          }
        }
      } finally {
        // Whatever ended the serial learning, no later branch's Actor context outlives it.
        for (const branch of verified) await branch.actor.close()
      }
      priorWave = `WAVE ${wave} CURRICULUM RATIONALE:\n${decision.rationale}\n\n${rendered.join('\n\n---\n\n')}`
      await lineage.event('WAVE_COMPLETED', { wave, projects: verified.length })
    }
  } catch (error) {
    return lineage.fail(error)
  } finally {
    await curriculum?.close()
  }
}

interface TargetOutcome {
  verdict: Verdict
  report: string
  diagnosis: string
  root: string
}

/**
 * One target attempt (RSIAgent `run_with_resume`): a fresh Actor and a Verifier
 * that persists through UNVERIFIED rounds. FAIL is terminal for the attempt.
 * A stalled attempt gets one forced inspection; when that is still
 * unresolved, a fresh Actor resumes on the same root (optionally on the
 * escalation route), with a work log rather than the old conversation.
 */
async function runTargetAttempt(lineage: Lineage, cycle: number, target: string, targetFixtures: TreeCapture | undefined): Promise<TargetOutcome> {
  const { config, store, signal } = lineage.deps
  const cycleDir = join(lineage.ws, `target-${String(cycle).padStart(3, '0')}`)
  const root = join(cycleDir, 'project')
  await mkdir(cycleDir, { recursive: true })
  if (targetFixtures) await replayTree(targetFixtures, root)
  else await mkdir(root, { recursive: true })
  const instruction = target.split(PROJECT_ROOT_PLACEHOLDER).join(root)
  const before = await projectManifest(root)
  const worklog: string[] = []
  let resumes = 0
  let binding = readBinding(store.canonicalDir)
  let actor = await lineage.open('actor', `target#${cycle} actor`, engineActorSystem(), root, binding)
  let verifier = await lineage.open('verifier', `target#${cycle} verifier`, verifierSystem(true, config.verifierMechanics), root, { access: 'none' })
  let generation = 0
  let swapped = false
  /** Reports of this attempt's Verifier so far; a swapped-in Verifier gets them once, on its first inspection. */
  const reports: string[] = []
  let handover: { priorReports: readonly string[] } | undefined
  const inspectNow = async (leads?: string) => {
    const result = await protectedInspection(lineage, verifier, {
      root,
      checkpointDir: join(cycleDir, 'candidate.checkpoint'),
      task: instruction,
      generation: ++generation,
      before,
      ...(leads ? { leads } : {}),
      allowUnverified: true,
      label: `target#${cycle}`,
      ...(handover ? { handover } : {}),
    })
    handover = undefined
    if (result.kind === 'verdict') reports.push(result.report)
    return result
  }
  try {
    await lineage.event('TARGET_STARTED', { targetCycle: cycle })
    let opening = targetActorCharter(target, root, await store.inventory(), config.inventoryListed)
    while (true) {
      let verdict: Verdict | undefined
      let report = ''
      try {
        let handoff = await runHandoffPhase(actor, opening, config.transport, { validate: () => shapeProblem(root), ...(signal ? { signal } : {}) })
        worklog.push(`HANDOFF:\n${handoff}`)
        let failedRounds = 0
        let leads: string | undefined
        while (verdict === undefined) {
          const result = await inspectNow(leads)
          if (result.kind === 'infra') throw new InfraError(result.reason)
          await lineage.event('TARGET_VERIFIED', { targetCycle: cycle, generation, verdict: result.verdict })
          worklog.push(`VERIFIER REPORT (generation ${generation}, ${result.verdict}):\n${result.report}`)
          if (result.verdict !== 'UNVERIFIED') {
            verdict = result.verdict
            report = result.report
            break
          }
          // RSIAgent max_consec_done: repeated failed submissions stall the attempt.
          if (++failedRounds >= config.unverifiedRounds) throw new TransportInfraError(`${failedRounds} consecutive UNVERIFIED rounds`)
          handoff = await runHandoffPhase(actor, `${unverifiedMessage(result.report)}\n\n${leadsRequest()}`, config.transport, {
            validate: async body => (await shapeProblem(root)) ?? leadsProblem(body),
            ...(signal ? { signal } : {}),
          })
          worklog.push(`HANDOFF:\n${handoff}`)
          leads = formatLeads(parseLeads(handoff))
        }
      } catch (error) {
        if (!(error instanceof TransportInfraError)) throw error
        await lineage.event('TARGET_STALLED', { targetCycle: cycle, reason: error.message })
        // Stall exit: one forced inspection of the live candidate.
        const forced = await inspectNow()
        if (forced.kind === 'infra') throw new InfraError(forced.reason)
        worklog.push(`VERIFIER REPORT (generation ${generation}, ${forced.verdict}):\n${forced.report}`)
        if (forced.verdict !== 'UNVERIFIED') {
          verdict = forced.verdict
          report = forced.report
        } else if (resumes < config.targetResumes) {
          resumes++
          const changed = JSON.stringify(await projectManifest(root)) !== JSON.stringify(before)
          await actor.close()
          const escalated = config.escalation
          binding = readBinding(store.canonicalDir)
          actor = await lineage.open('actor', `target#${cycle} actor (resume ${resumes})`, engineActorSystem(), root, binding, escalated ? 'escalation' : 'actor')
          if (escalated && config.crossModelVerifier && !swapped) {
            // Two different models must still agree: the resumed segment's Verifier takes the original Actor route,
            // once; later resumes keep that context.
            swapped = true
            await verifier.close()
            verifier = await lineage.open('verifier', `target#${cycle} verifier (cross-model)`, verifierSystem(true, config.verifierMechanics), root, { access: 'none' }, 'actor')
            handover = { priorReports: [...reports] }
          }
          const log = worklog.join('\n\n')
          opening = targetActorCharter(target, root, await store.inventory(), config.inventoryListed, changed ? resumeHandoffMessage(log) : resumePivotMessage(log))
          await lineage.event('TARGET_RESUMED', { targetCycle: cycle, resume: resumes, escalated })
          continue
        } else {
          return { verdict: 'UNVERIFIED', report: forced.report, diagnosis: '', root }
        }
      }
      const learning = await learn(actor, {
        store,
        binding,
        episode: `${lineage.id}-t${cycle}`,
        kind: 'target',
        outcome: verdict as 'PASS' | 'FAIL',
        report,
        diagnosis: true,
        policy: config.transport,
        ...(signal ? { signal } : {}),
      })
      await lineage.event('TARGET_LEARNING_COMPLETED', { targetCycle: cycle, tree: learning.commit.treeAfter })
      return { verdict, report, diagnosis: learning.diagnosis ?? '', root }
    }
  } finally {
    await verifier.close()
    await actor.close()
  }
}

/**
 * Phase 2 — Deep Recursive Self-exploration around an immutable development
 * target (RSIAgent `run_self_evolving_loop`). Each cycle attempts the target with a
 * fresh Actor; grounded outcomes are learned by that same Actor; the Curriculum
 * then chooses focused practice until it returns readiness or stalls.
 */
export async function runDeepExploration(
  deps: EngineDeps,
  input: { lineage: string, target: string, paths: EnginePaths, targetFixtures?: TreeCapture },
): Promise<DeepResult> {
  const { config, store, signal } = deps
  const lineage = new Lineage(deps, input.lineage, input.paths)
  await lineage.init({ phase: 'deep', target: input.target, stopPolicy: config.stopPolicy })
  let curriculum: RoleConversation | undefined
  let targetCycles = 0
  let practiceProjects = 0
  let finalAfterStall = false
  let finalAfterBudget = false
  const history: string[] = []
  const finish = async (termination: DeepResult['termination'], outcome: TargetOutcome): Promise<DeepResult> => {
    // The candidate as the lineage ended, kept privately: later edits to the work root never change what is measured.
    const candidateCopy = join(lineage.priv, 'final-candidate')
    await rm(candidateCopy, { recursive: true, force: true })
    await discardableCopy(outcome.root, candidateCopy)
    const result: DeepResult = {
      lineage: input.lineage,
      termination,
      targetCycles,
      practiceProjects,
      verdict: outcome.verdict,
      report: outcome.report,
      candidateRoot: outcome.root,
      candidateCopy,
      candidateDigest: await treeFingerprint(candidateCopy),
      memoryHash: await store.treeHash(),
      ...SEALED,
    }
    await lineage.event('TARGET_LOOP_TERMINATED', { termination, verdict: outcome.verdict })
    await lineage.finish(result)
    return result
  }
  try {
    while (true) {
      targetCycles++
      const outcome = await runTargetAttempt(lineage, targetCycles, input.target, input.targetFixtures)
      history.push(`- Phase-2 target attempt ${targetCycles}: ${outcome.verdict}`)

      if (finalAfterBudget) return await finish('budget_exhausted', outcome)
      const reviewPass = outcome.verdict === 'PASS' && config.stopPolicy === 'curriculum_review' && !finalAfterStall
      if (outcome.verdict === 'PASS' && !reviewPass) return await finish('verifier_pass', outcome)
      if (finalAfterStall) return await finish('curriculum_stalled_final_target_test', outcome)
      if (outcome.verdict === 'UNVERIFIED') return await finish('target_harness_unverified', outcome)
      if (targetCycles >= config.targetCycleBudget) return await finish('budget_exhausted', outcome)

      if (!curriculum) {
        const memory: MemoryBinding = config.curriculumMemoryAccess === 'none' ? { access: 'none' } : readBinding(store.canonicalDir)
        curriculum = await lineage.open('curriculum', 'curriculum', curriculumSystem(config.curriculumMemoryAccess), lineage.ws, memory)
      }
      let latestOutcome = phase2OutcomeText(`Phase-2 target attempt ${targetCycles}`, input.target, outcome.verdict, outcome.report, outcome.diagnosis)
      let practiceThisEvolution = 0
      while (true) {
        if (practiceProjects >= config.deepPracticeBudget) {
          if (practiceThisEvolution === 0) return await finish('budget_exhausted', outcome)
          // Practice changed memory since the last attempt: a final fresh target test is mandatory.
          finalAfterBudget = true
          break
        }
        const id = `p${String(practiceProjects + 1).padStart(3, '0')}`
        const fixtureRoot = join(lineage.ws, `practice-${id}`, 'authoring')
        await mkdir(fixtureRoot, { recursive: true })
        const decision = await converse(
          curriculum,
          deepCharter({ target: input.target, history: history.join('\n'), latestOutcome, fixtureRoot, notes: await lineage.notes() }),
          async reply => {
            const parsed = parseDecision<DeepDecision>(reply.text, DEEP_DECISIONS)
            if (!parsed) return { ok: false, detail: 'the first non-empty line must be DECISION: PROJECT, DECISION: READY_FOR_TARGET, or DECISION: STALLED' }
            if (parsed.decision === 'PROJECT') {
              if (!parsed.body.includes(PROJECT_ROOT_PLACEHOLDER)) return { ok: false, detail: `the PROJECT handoff does not name ${PROJECT_ROOT_PLACEHOLDER} as its project root` }
              const problem = await shapeGate(fixtureRoot)
              if (problem) return { ok: false, detail: `the fixture tree at ${fixtureRoot} is not replayable: ${problem}` }
            }
            return { ok: true, value: parsed }
          },
          detail => curriculumTransportContinuation(detail),
          config.transport,
          'Curriculum Agent',
          signal,
        )
        await lineage.event('CURRICULUM_DECIDED', { decision: decision.decision })
        if (decision.decision !== 'PROJECT') {
          await rm(join(lineage.ws, `practice-${id}`), { recursive: true, force: true })
          if (decision.decision === 'STALLED') finalAfterStall = true
          break
        }
        practiceProjects++
        practiceThisEvolution++
        const fixtures = await captureTree(fixtureRoot, join(lineage.priv, `practice-${id}`, 'fixtures'))
        await rm(fixtureRoot, { recursive: true, force: true })
        const project: WaveProject = { id, instruction: decision.body }
        const branch = await runProjectWithRetry(lineage, project, { episodeDir: join(lineage.ws, `practice-${id}`), fixtures, memoryDir: store.canonicalDir, phase2: true })
        try {
          const report = branch.reports.at(-1)!
          const learning = await learn(branch.actor, {
            store,
            binding: branch.binding,
            episode: `${input.lineage}-${id}`,
            kind: 'practice',
            outcome: branch.verdict,
            report,
            diagnosis: true,
            policy: config.transport,
            ...(signal ? { signal } : {}),
          })
          history.push(`- Phase-2 practice project ${id}: ${branch.verdict}`)
          latestOutcome = phase2OutcomeText(`Phase-2 practice project ${id}`, project.instruction, branch.verdict, report, learning.diagnosis ?? '')
          await lineage.event('PRACTICE_LEARNING_COMPLETED', { project: id, tree: learning.commit.treeAfter })
        } finally {
          await branch.actor.close()
        }
      }
      if (finalAfterBudget) continue
      if (outcome.verdict === 'PASS' && practiceThisEvolution === 0) {
        return await finish(finalAfterStall ? 'verifier_pass_curriculum_stalled' : 'verifier_pass_curriculum_ready', outcome)
      }
    }
  } catch (error) {
    return lineage.fail(error)
  } finally {
    await curriculum?.close()
  }
}
