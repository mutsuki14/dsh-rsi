import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runSealedEvaluation } from '../src/host/sealed.ts'
import { MemoryStore } from '../src/memory/store.ts'

describe('runSealedEvaluation', () => {
  it('scores a copy of the final candidate on frozen memory and records only host artifacts', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-rsi-sealed-'))
    const store = new MemoryStore(join(base, 'mem'), { maxFileBytes: 1024, maxTotalBytes: 4096, maxFiles: 8 }, { keepHistory: false })
    await store.init()
    const candidate = join(base, 'ws', 'target-001', 'project')
    await mkdir(candidate, { recursive: true })
    await writeFile(join(candidate, 'answer.txt'), '42')
    const lineageDir = join(store.root, 'lineages', 'd1')
    await mkdir(lineageDir, { recursive: true })
    await writeFile(join(lineageDir, 'lineage.json'), JSON.stringify({ target: 'In <PROJECT_ROOT> write the answer.' }))
    await writeFile(join(lineageDir, 'result.json'), JSON.stringify({ termination: 'verifier_pass', candidateRoot: candidate }))
    const evaluator = join(base, 'eval.mjs')
    await writeFile(evaluator, `import { readFileSync, writeFileSync } from 'node:fs'
const answer = readFileSync(process.env.RSI_CANDIDATE_ROOT + '/answer.txt', 'utf8')
writeFileSync(process.env.RSI_CANDIDATE_ROOT + '/answer.txt', 'evaluator scribble')
console.log(JSON.stringify({ score: answer === '42' ? 1 : 0 }))`)
    const record = await runSealedEvaluation({ lineage: 'd1', lineageDir, resultsDir: join(store.root, 'sealed'), runId: 'r1', store, config: { command: [process.execPath, evaluator], timeoutSec: 30, retries: 0 } })
    expect(record).toMatchObject({ status: 'scored', score: 1, frozenIntact: true, officialEvaluatorFeedbackEnteredAgent: false })
    expect(await store.isFrozen()).toBe(true)
    // The evaluator ran on a copy: the lineage's candidate is untouched.
    expect(await readFile(join(candidate, 'answer.txt'), 'utf8')).toBe('42')
    expect(JSON.parse(await readFile(join(store.root, 'sealed', 'd1', 'r1', 'evaluation.json'), 'utf8'))).toMatchObject({ status: 'scored', score: 1 })
  })

  it('reports an evaluator infrastructure failure as blocked and unscored after its retries', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-rsi-sealed-'))
    const store = new MemoryStore(join(base, 'mem'), { maxFileBytes: 1024, maxTotalBytes: 4096, maxFiles: 8 }, { keepHistory: false })
    await store.init()
    const candidate = join(base, 'c')
    await mkdir(candidate, { recursive: true })
    const lineageDir = join(store.root, 'lineages', 'd2')
    await mkdir(lineageDir, { recursive: true })
    await writeFile(join(lineageDir, 'lineage.json'), '{}')
    await writeFile(join(lineageDir, 'result.json'), JSON.stringify({ candidateRoot: candidate }))
    const record = await runSealedEvaluation({ lineage: 'd2', lineageDir, resultsDir: join(store.root, 'sealed'), runId: 'r1', store, config: { command: [process.execPath, '-e', 'process.exit(3)'], timeoutSec: 30, retries: 1 } })
    expect(record).toMatchObject({ status: 'blocked' })
    expect(record.score).toBeUndefined()
    expect(record.attempts).toHaveLength(2)
  })
})
