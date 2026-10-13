import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { treeFingerprint } from '../engine/workspace.ts'
import type { MemoryStore } from '../memory/store.ts'

export interface SealedEvaluationConfig {
  /** argv of a human-configured evaluator; empty disables sealed evaluation. */
  command: string[]
  timeoutSec: number
  /** Extra attempts after an evaluator infrastructure failure (non-zero exit or timeout). */
  retries: number
}

export interface SealedRecord {
  lineage: string
  runId: string
  status: 'scored' | 'blocked'
  score?: number
  attempts: Array<{ exitCode: number | null, timedOut: boolean, stdoutTail: string, stderrTail: string }>
  candidate: string
  memoryTreeBefore: string
  memoryTreeAfter: string
  frozenIntact: boolean
  /** RSIAgent invariant: evaluator output never reaches an agent prompt, memory, or later learning. */
  officialEvaluatorFeedbackEnteredAgent: false
  ts: string
}

function tail(text: string, chars = 4000): string {
  return text.length <= chars ? text : `…${text.slice(-chars)}`
}

function runOnce(argv: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<SealedRecord['attempts'][number]> {
  return new Promise(resolve => {
    execFile(argv[0]!, argv.slice(1), { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = error ? (typeof error.code === 'number' ? error.code : null) : 0
      resolve({ exitCode, timedOut: error?.killed === true, stdoutTail: tail(String(stdout)), stderrTail: tail(String(stderr)) })
    })
  })
}

function parseScore(stdout: string): number | undefined {
  const last = stdout.trim().split('\n').at(-1)
  if (!last) return undefined
  try {
    const value = JSON.parse(last) as unknown
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'object' && value !== null && typeof (value as { score?: unknown }).score === 'number') return (value as { score: number }).score
  } catch {
    // A last line that is not JSON carries no machine-readable score.
  }
  return undefined
}

/**
 * Sealed evaluation of a finished deep lineage (RSIAgent Phase 3 measurement):
 * runs only after every role context has ended, on frozen memory, against a
 * copy of the final candidate, and writes the result only to host artifacts
 * outside every role's working directory. Its output never enters a prompt,
 * memory, or later learning; the frozen tree hash is checked before and after.
 */
export async function runSealedEvaluation(input: {
  lineage: string
  lineageDir: string
  resultsDir: string
  runId: string
  store: MemoryStore
  config: SealedEvaluationConfig
}): Promise<SealedRecord> {
  const result = JSON.parse(await readFile(join(input.lineageDir, 'result.json'), 'utf8')) as { candidateRoot?: unknown, candidateCopy?: unknown, candidateDigest?: unknown }
  if (typeof result.candidateRoot !== 'string') throw new Error(`lineage ${input.lineage} has no final target candidate to evaluate (only completed deep lineages do)`)
  // Measure the candidate exactly as the lineage ended: the private copy, checked against its recorded digest.
  const source = typeof result.candidateCopy === 'string' ? result.candidateCopy : result.candidateRoot
  if (typeof result.candidateDigest === 'string' && (await treeFingerprint(source)) !== result.candidateDigest) {
    throw new Error(`the final candidate of ${input.lineage} changed after the lineage ended; refusing to score it`)
  }
  const meta = JSON.parse(await readFile(join(input.lineageDir, 'lineage.json'), 'utf8')) as { target?: unknown }
  if (!(await input.store.isFrozen())) await input.store.freeze()
  await input.store.assertFrozenIntact()
  const memoryTreeBefore = await input.store.treeHash()

  const runDir = join(input.resultsDir, input.lineage, input.runId)
  const candidate = join(runDir, 'candidate')
  await mkdir(runDir, { recursive: true })
  await cp(source, candidate, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
  const taskFile = join(runDir, 'task.md')
  await writeFile(taskFile, typeof meta.target === 'string' ? meta.target : '')

  const env = { ...process.env, RSI_CANDIDATE_ROOT: candidate, RSI_TASK_FILE: taskFile }
  const attempts: SealedRecord['attempts'] = []
  let score: number | undefined
  let status: SealedRecord['status'] = 'blocked'
  for (let attempt = 0; attempt <= input.config.retries; attempt++) {
    const outcome = await runOnce(input.config.command, candidate, env, input.config.timeoutSec * 1000)
    attempts.push(outcome)
    if (outcome.exitCode === 0) {
      status = 'scored'
      score = parseScore(outcome.stdoutTail)
      break
    }
  }

  const memoryTreeAfter = await input.store.treeHash()
  let frozenIntact = true
  try {
    await input.store.assertFrozenIntact()
  } catch {
    frozenIntact = false
  }
  const record: SealedRecord = {
    lineage: input.lineage,
    runId: input.runId,
    status,
    ...(score === undefined ? {} : { score }),
    attempts,
    candidate,
    memoryTreeBefore,
    memoryTreeAfter,
    frozenIntact: frozenIntact && memoryTreeBefore === memoryTreeAfter,
    officialEvaluatorFeedbackEnteredAgent: false,
    ts: new Date().toISOString(),
  }
  await writeFile(join(runDir, 'evaluation.json'), `${JSON.stringify(record, null, 2)}\n`)
  await writeFile(join(input.lineageDir, 'sealed.json'), `${JSON.stringify({ runId: input.runId, status, ts: record.ts })}\n`)
  return record
}
