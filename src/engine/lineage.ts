import { appendFile, cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CommitRecord, MemoryStore } from '../memory/store.ts'
import { parseDecision, type Verdict } from '../protocol/tokens.ts'
import { parseWave, PROJECT_ROOT_PLACEHOLDER, type WaveProject } from '../protocol/wave.ts'
import { engineActorSystem, practiceActorCharter, targetActorCharter, unverifiedMessage } from '../roles/actor.ts'
import {
  CURRICULUM_SYSTEM,
  curriculumTransportContinuation,
  DEEP_DECISIONS,
  deepCharter,
  waveCharter,
  type DeepDecision,
} from '../roles/curriculum.ts'
import { verifierSystem } from '../roles/verifier.ts'
import { inspect, learn, runHandoffPhase } from './steps.ts'
import { InfraError, type EngineObserver, type MemoryBinding, type RoleConversation, type RoleRuntime } from './types.ts'
import { describeDelta, discardableCopy, projectManifest } from './workspace.ts'

export interface EngineConfig {
  /** Phase 1: maximum projects one wave may author. */
  maxWaveProjects: number
  /** Phase 1: branches of one wave that run at the same time (host capacity, not wave width). */
  waveConcurrency: number
  /** Phase 1: complete-project budget, checked only at wave boundaries. */
  broadProjectBudget: number
  /** Phase 2: practice-project budget across the lineage. */
  deepPracticeBudget: number
  /** Phase 2: maximum target attempts. */
  targetCycleBudget: number
  /** Phase 2: same-attempt UNVERIFIED evidence rounds before the attempt is unverified. */
  unverifiedRounds: number
  /** Same-context continuations for a malformed handoff, verdict, or decision. */
  transportRetries: number
  /** Restarts of a branch that hit infrastructure trouble before a verdict (unscored). */
  branchRetries: number
  /** Inventory lines listed in a fresh Actor's opening message. */
  inventoryListed: number
  /** `curriculum_review` lets the Curriculum request more practice after a target PASS. */
  stopPolicy: 'curriculum_review' | 'verifier_pass'
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
  report: string
  commit?: CommitRecord
}

export interface BroadResult {
  lineage: string
  termination: 'saturated' | 'stalled' | 'budget_exhausted'
  rationale: string
  waves: number
  projects: ProjectOutcome[]
  memoryHash: string
}

export interface DeepResult {
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
  memoryHash: string
}

class Lineage {
  readonly dir: string

  constructor(readonly deps: EngineDeps, readonly id: string, stateRoot: string) {
    this.dir = join(stateRoot, 'lineages', id)
  }

  async init(meta: Record<string, unknown>): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(join(this.dir, 'lineage.json'), `${JSON.stringify({ id: this.id, ...meta, startedAt: new Date().toISOString() }, null, 2)}\n`)
  }

  async event(type: string, data: Record<string, unknown> = {}): Promise<void> {
    const event = { type, lineage: this.id, ts: new Date().toISOString(), ...data }
    this.deps.observe(event)
    await appendFile(join(this.dir, 'events.jsonl'), `${JSON.stringify(event)}\n`)
  }

  async finish(result: object): Promise<void> {
    await writeFile(join(this.dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
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

interface VerifiedProject {
  project: WaveProject
  verdict: Exclude<Verdict, 'UNVERIFIED'>
  report: string
  actor: RoleConversation
  binding: MemoryBinding
}

/**
 * One practice episode: fresh Actor on a fresh project root → candidate capture →
 * fresh Verifier with rollback protection → one PASS/FAIL. The Actor context is
 * returned open so the caller can run its learning phase at a valid boundary.
 */
async function runProject(lineage: Lineage, project: WaveProject, episodeDir: string, memoryDir: string): Promise<VerifiedProject> {
  const { runtime, config, store, signal } = lineage.deps
  const root = join(episodeDir, 'project')
  await rm(episodeDir, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const binding = readBinding(memoryDir)
  const actor = await runtime.open({
    role: 'actor',
    label: `${lineage.id}/${project.id} actor`,
    system: engineActorSystem(),
    cwd: root,
    memory: binding,
  })
  try {
    const instruction = project.instruction.split(PROJECT_ROOT_PLACEHOLDER).join(root)
    const before = await projectManifest(root)
    const inventory = Object.entries(await store.manifest()).map(([path, entry]) => ({ path, bytes: entry.bytes }))
    await runHandoffPhase(actor, practiceActorCharter(project.instruction, root, inventory, config.inventoryListed), config.transportRetries, signal)
    const after = await projectManifest(root)
    await lineage.event('PROJECT_SUBMITTED', { project: project.id })

    const checkpoint = join(episodeDir, 'candidate.checkpoint')
    await discardableCopy(root, checkpoint)
    const verifier = await runtime.open({
      role: 'verifier',
      label: `${lineage.id}/${project.id} verifier`,
      system: verifierSystem(false),
      cwd: root,
      memory: { access: 'none' },
    })
    let result
    try {
      result = await inspect(verifier, {
        task: instruction,
        generation: 1,
        mechanicalContext: describeDelta(root, before, after),
        allowUnverified: false,
        retries: config.transportRetries,
        signal,
      })
    } finally {
      await verifier.close()
    }
    const checked = await projectManifest(root)
    if (JSON.stringify(checked) !== JSON.stringify(after)) {
      // Verifier effects never reach the candidate: roll back to the captured checkpoint.
      await rm(root, { recursive: true, force: true })
      await cp(checkpoint, root, { recursive: true })
      await lineage.event('VERIFIER_EFFECTS_ROLLED_BACK', { project: project.id })
    }
    await rm(checkpoint, { recursive: true, force: true })
    if (result.kind === 'infra') throw new InfraError(result.reason)
    if (result.verdict === 'UNVERIFIED') throw new InfraError('practice verification admits only PASS or FAIL')
    await lineage.event('PROJECT_VERIFIED', { project: project.id, verdict: result.verdict })
    return { project, verdict: result.verdict, report: result.report, actor, binding }
  } catch (error) {
    await actor.close()
    throw error
  }
}

async function runProjectWithRetry(lineage: Lineage, project: WaveProject, episodeDir: string, memoryDir: string): Promise<VerifiedProject> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runProject(lineage, project, episodeDir, memoryDir)
    } catch (error) {
      if (!(error instanceof InfraError) || attempt >= lineage.deps.config.branchRetries) throw error
      await lineage.event('PROJECT_RESTARTED_UNSCORED', { project: project.id, reason: error.message })
    }
  }
}

function outcomeText(outcome: ProjectOutcome): string {
  const memory = outcome.commit
    ? `MEMORY CHANGES: created ${outcome.commit.created.join(', ') || '-'}; modified ${outcome.commit.modified.join(', ') || '-'}; deleted ${outcome.commit.deleted.join(', ') || '-'}`
    : 'MEMORY CHANGES: none committed'
  return `PROJECT ${outcome.id}:\n${outcome.instruction}\nTERMINAL OUTCOME: ${outcome.verdict}\nVERIFIER REPORT (verbatim):\n${outcome.report.trim()}\n${memory}`
}

async function askCurriculum<T>(
  curriculum: RoleConversation,
  message: string,
  parse: (reply: string) => T | undefined,
  expected: string,
  deps: EngineDeps,
): Promise<T> {
  let reply = await curriculum.send(message, deps.signal)
  for (let attempt = 0; ; attempt++) {
    const parsed = parse(reply)
    if (parsed !== undefined) return parsed
    if (attempt >= deps.config.transportRetries) throw new InfraError(`the Curriculum Agent never published a valid handoff (${expected})`)
    reply = await curriculum.send(curriculumTransportContinuation(expected), deps.signal)
  }
}

/**
 * Phase 1 — Broad Recursive Self-exploration. The Curriculum authors waves of
 * independent projects; every branch starts from the same pre-wave snapshot;
 * after the complete wave is verified, the same Actor contexts distill serially
 * in authored order, each against the latest canonical memory.
 */
export async function runBroadExploration(deps: EngineDeps, input: { lineage: string, direction: string, stateRoot: string }): Promise<BroadResult> {
  const lineage = new Lineage(deps, input.lineage, input.stateRoot)
  await lineage.init({ phase: 'broad', direction: input.direction })
  const curriculum = await deps.runtime.open({
    role: 'curriculum',
    label: `${input.lineage} curriculum`,
    system: CURRICULUM_SYSTEM,
    cwd: lineage.dir,
    memory: readBinding(deps.store.canonicalDir),
  })
  const projects: ProjectOutcome[] = []
  let priorOutcomes = ''
  let wave = 0
  try {
    while (true) {
      if (projects.length >= deps.config.broadProjectBudget) {
        const result: BroadResult = { lineage: input.lineage, termination: 'budget_exhausted', rationale: 'complete-project budget reached at a wave boundary', waves: wave, projects, memoryHash: await deps.store.treeHash() }
        await lineage.event('PHASE1_TERMINATED', { termination: result.termination })
        await lineage.finish(result)
        return result
      }
      wave++
      const decision = await askCurriculum(
        curriculum,
        waveCharter({ direction: input.direction, priorOutcomes, maxProjects: deps.config.maxWaveProjects }),
        reply => parseWave(reply, deps.config.maxWaveProjects),
        `one JSON object with decision WAVE (1-${deps.config.maxWaveProjects} projects, unique ids, each instruction naming ${PROJECT_ROOT_PLACEHOLDER}), SATURATED, or STALLED`,
        deps,
      )
      if (decision.decision !== 'WAVE') {
        const result: BroadResult = { lineage: input.lineage, termination: decision.decision === 'SATURATED' ? 'saturated' : 'stalled', rationale: decision.rationale, waves: wave - 1, projects, memoryHash: await deps.store.treeHash() }
        await lineage.event('PHASE1_TERMINATED', { termination: result.termination })
        await lineage.finish(result)
        return result
      }
      await lineage.event('WAVE_AUTHORED', { wave, projects: decision.projects.map(project => project.id), rationale: decision.rationale })

      const waveDir = join(lineage.dir, `wave-${String(wave).padStart(3, '0')}`)
      const snapshot = join(waveDir, 'memory_snapshot')
      await rm(snapshot, { recursive: true, force: true })
      await mkdir(waveDir, { recursive: true })
      await cp(deps.store.canonicalDir, snapshot, { recursive: true })

      const settled = await pool(decision.projects, deps.config.waveConcurrency, project =>
        runProjectWithRetry(lineage, project, join(waveDir, project.id), snapshot))
      const failed = settled.find(result => result.status === 'rejected')
      if (failed) {
        // Wave barrier: an incomplete branch blocks the wave and no memory is merged.
        for (const result of settled) if (result.status === 'fulfilled') await result.value.actor.close()
        await lineage.event('WAVE_BLOCKED', { wave, reason: String((failed as PromiseRejectedResult).reason) })
        throw (failed as PromiseRejectedResult).reason
      }

      const verified = settled.map(result => (result as PromiseFulfilledResult<VerifiedProject>).value)
      const waveOutcomes: ProjectOutcome[] = []
      for (const branch of verified) {
        try {
          const learning = await learn(branch.actor, {
            store: deps.store,
            binding: branch.binding,
            episode: `${input.lineage}-w${wave}-${branch.project.id}`,
            kind: 'practice',
            outcome: branch.verdict,
            report: branch.report,
            diagnosis: false,
            signal: deps.signal,
          })
          const outcome: ProjectOutcome = { id: branch.project.id, instruction: branch.project.instruction, verdict: branch.verdict, report: branch.report, commit: learning.commit }
          waveOutcomes.push(outcome)
          await lineage.event('MEMORY_COMMITTED', { wave, project: branch.project.id, tree: learning.commit.treeAfter })
        } finally {
          await branch.actor.close()
        }
      }
      projects.push(...waveOutcomes)
      priorOutcomes += `${priorOutcomes ? '\n\n' : ''}WAVE ${wave} — rationale: ${decision.rationale}\n\n${waveOutcomes.map(outcomeText).join('\n\n')}`
      await lineage.event('WAVE_COMPLETED', { wave, projects: waveOutcomes.length })
    }
  } finally {
    await curriculum.close()
  }
}

/**
 * Phase 2 — Deep Recursive Self-exploration around an immutable development
 * target (RSIAgent `run_self_evolving_loop`). Each cycle attempts the target with a
 * fresh Actor; grounded outcomes are learned by that same Actor; the Curriculum
 * then chooses focused practice until it returns readiness or stalls.
 */
export async function runDeepExploration(deps: EngineDeps, input: { lineage: string, target: string, stateRoot: string }): Promise<DeepResult> {
  const { config, store, runtime, signal } = deps
  const lineage = new Lineage(deps, input.lineage, input.stateRoot)
  await lineage.init({ phase: 'deep', target: input.target, stopPolicy: config.stopPolicy })
  let curriculum: RoleConversation | undefined
  let targetCycles = 0
  let practiceProjects = 0
  let finalAfterStall = false
  let history = ''
  const finish = async (termination: DeepResult['termination'], verdict: Verdict, report: string): Promise<DeepResult> => {
    const result: DeepResult = { lineage: input.lineage, termination, targetCycles, practiceProjects, verdict, report, memoryHash: await store.treeHash() }
    await lineage.event('TARGET_LOOP_TERMINATED', { termination, verdict })
    await lineage.finish(result)
    return result
  }
  try {
    while (true) {
      if (targetCycles >= config.targetCycleBudget) return await finish('budget_exhausted', 'UNVERIFIED', '')
      targetCycles++
      const cycleDir = join(lineage.dir, `target-${String(targetCycles).padStart(3, '0')}`)
      const root = join(cycleDir, 'project')
      await rm(cycleDir, { recursive: true, force: true })
      await mkdir(root, { recursive: true })
      const binding = readBinding(store.canonicalDir)
      const actor = await runtime.open({ role: 'actor', label: `${input.lineage} target#${targetCycles} actor`, system: engineActorSystem(), cwd: root, memory: binding })
      let verdict: Verdict
      let report: string
      let diagnosis = ''
      try {
        await lineage.event('TARGET_STARTED', { targetCycle: targetCycles, finalAfterStall })
        const inventory = await store.inventory()
        const target = input.target
        const instruction = target.split(PROJECT_ROOT_PLACEHOLDER).join(root)
        const before = await projectManifest(root)
        let handoff = await runHandoffPhase(actor, targetActorCharter(target, root, inventory, config.inventoryListed), config.transportRetries, signal)
        const verifier = await runtime.open({ role: 'verifier', label: `${input.lineage} target#${targetCycles} verifier`, system: verifierSystem(true), cwd: root, memory: { access: 'none' } })
        try {
          let generation = 0
          let leads: string | undefined
          while (true) {
            generation++
            const after = await projectManifest(root)
            const checkpoint = join(cycleDir, 'candidate.checkpoint')
            await rm(checkpoint, { recursive: true, force: true })
            await discardableCopy(root, checkpoint)
            const result = await inspect(verifier, { task: instruction, generation, mechanicalContext: describeDelta(root, before, after), leads, allowUnverified: true, retries: config.transportRetries, signal })
            if (JSON.stringify(await projectManifest(root)) !== JSON.stringify(after)) {
              await rm(root, { recursive: true, force: true })
              await cp(checkpoint, root, { recursive: true })
              await lineage.event('VERIFIER_EFFECTS_ROLLED_BACK', { targetCycle: targetCycles, generation })
            }
            await rm(checkpoint, { recursive: true, force: true })
            if (result.kind === 'infra') throw new InfraError(result.reason)
            await lineage.event('TARGET_VERIFIED', { targetCycle: targetCycles, generation, verdict: result.verdict })
            if (result.verdict !== 'UNVERIFIED' || generation > config.unverifiedRounds) {
              verdict = result.verdict
              report = result.report
              break
            }
            handoff = await runHandoffPhase(actor, `${unverifiedMessage(result.report)}\n\nEnd your turn with a new handoff whose first non-empty line is STATUS: SUBMIT and which lists the reproducible evidence leads.`, config.transportRetries, signal)
            leads = handoff
          }
        } finally {
          await verifier.close()
        }

        if (verdict === 'FAIL' || verdict === 'PASS') {
          const learning = await learn(actor, { store, binding, episode: `${input.lineage}-t${targetCycles}`, kind: 'target', outcome: verdict, report, diagnosis: true, signal })
          diagnosis = learning.diagnosis ?? ''
          await lineage.event('TARGET_LEARNING_COMPLETED', { targetCycle: targetCycles, tree: learning.commit.treeAfter })
        }
      } finally {
        await actor.close()
      }

      const reviewPass = verdict === 'PASS' && config.stopPolicy === 'curriculum_review' && !finalAfterStall
      if (verdict === 'PASS' && !reviewPass) return await finish('verifier_pass', verdict, report)
      if (finalAfterStall) return await finish('curriculum_stalled_final_target_test', verdict, report)
      if (verdict === 'UNVERIFIED') return await finish('target_harness_unverified', verdict, report)

      curriculum ??= await runtime.open({ role: 'curriculum', label: `${input.lineage} curriculum`, system: CURRICULUM_SYSTEM, cwd: lineage.dir, memory: readBinding(store.canonicalDir) })
      let latestOutcome = `TARGET ATTEMPT ${targetCycles}: ${verdict}\nVERIFIER REPORT (verbatim):\n${report.trim()}\n\nACTOR LEARNING DIAGNOSIS:\n${diagnosis.trim() || '(none)'}`
      let practiceThisEvolution = 0
      while (true) {
        if (practiceProjects >= config.deepPracticeBudget) return await finish('budget_exhausted', verdict, report)
        const decision = await askCurriculum(
          curriculum,
          deepCharter({ target: input.target, history, latestOutcome }),
          reply => parseDecision<DeepDecision>(reply, DEEP_DECISIONS),
          'the first non-empty line must be DECISION: PROJECT, DECISION: READY_FOR_TARGET, or DECISION: STALLED',
          deps,
        )
        await lineage.event('CURRICULUM_DECIDED', { decision: decision.decision })
        if (decision.decision === 'READY_FOR_TARGET') break
        if (decision.decision === 'STALLED') {
          finalAfterStall = true
          break
        }
        if (!decision.body.includes(PROJECT_ROOT_PLACEHOLDER)) {
          latestOutcome = `The previous PROJECT handoff did not name ${PROJECT_ROOT_PLACEHOLDER} as its project root and was not run.`
          continue
        }
        practiceProjects++
        practiceThisEvolution++
        const project: WaveProject = { id: `p${String(practiceProjects).padStart(3, '0')}`, instruction: decision.body }
        const branch = await runProjectWithRetry(lineage, project, join(lineage.dir, `practice-${project.id}`), store.canonicalDir)
        try {
          const learning = await learn(branch.actor, { store, binding: branch.binding, episode: `${input.lineage}-${project.id}`, kind: 'practice', outcome: branch.verdict, report: branch.report, diagnosis: false, signal })
          const outcome: ProjectOutcome = { id: project.id, instruction: project.instruction, verdict: branch.verdict, report: branch.report, commit: learning.commit }
          history += `${history ? '\n\n' : ''}${outcomeText(outcome)}`
          latestOutcome = outcomeText(outcome)
        } finally {
          await branch.actor.close()
        }
      }
      if (verdict === 'PASS' && practiceThisEvolution === 0) {
        return await finish(finalAfterStall ? 'verifier_pass_curriculum_stalled' : 'verifier_pass_curriculum_ready', verdict, report)
      }
    }
  } finally {
    await curriculum?.close()
  }
}
