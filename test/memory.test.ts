import { mkdtemp, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { LeakageAudit } from '../src/memory/audit.ts'
import { sha256, treeSha256 } from '../src/memory/hash.ts'
import { safeRelativePath } from '../src/memory/paths.ts'
import { MemoryConflictError, MemoryFrozenError, MemoryQuarantineError, MemoryStore } from '../src/memory/store.ts'

const limits = { maxFileBytes: 1024, maxTotalBytes: 4096, maxFiles: 8 }

describe('treeSha256', () => {
  it('matches RSIAgent memory_hash.tree_sha256 byte for byte', () => {
    // Reference values computed with RSIAgent's Python implementation.
    expect(treeSha256({ 'b/lesson.md': sha256('fail fast'), 'a.md': sha256('科学 notes') }))
      .toBe('c9cedc356c2e9259636f2e7a9b8ce36819a10fbf2e8e889fd1a011dbf9386a9e')
    expect(treeSha256({})).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a')
  })
  it('rejects unsafe entries', () => {
    expect(() => treeSha256({ '../x': sha256('') })).toThrow()
    expect(() => treeSha256({ a: 'nothex' })).toThrow()
  })
})

describe('safeRelativePath', () => {
  it('normalizes and confines paths', () => {
    expect(safeRelativePath('./notes//build.md')).toBe('notes/build.md')
    expect(safeRelativePath('scripts\\run.sh')).toBe('scripts/run.sh')
    for (const bad of ['', '/etc/passwd', '../escape', 'a/../../b', 'C:/x']) expect(() => safeRelativePath(bad)).toThrow()
  })
})

describe('MemoryStore', () => {
  let root: string
  let store: MemoryStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-rsi-'))
    store = new MemoryStore(root, limits, { keepHistory: true })
    await store.init()
  })

  it('promotes a draft atomically and journals the delta', async () => {
    const draft = await store.openDraft('ep1')
    await store.writeDraft(draft, 'procedures/build.md', 'Run `make` then `make test`.')
    expect(await store.inventory()).toEqual([])
    const record = await store.commit(draft, { kind: 'practice', outcome: 'PASS' })
    expect(record.created).toEqual(['procedures/build.md'])
    expect(record.treeAfter).toBe(await store.treeHash())
    expect(await store.inventory()).toEqual([{ path: 'procedures/build.md', bytes: 28 }])
    expect((await store.read('procedures/build.md')).text).toContain('make test')
    expect(await store.journal()).toHaveLength(1)
    expect(await readdir(join(root, 'history'))).toEqual(['0001'])

    const second = await store.openDraft('ep2')
    await store.deleteDraft(second, 'procedures/build.md')
    await store.writeDraft(second, 'lessons/flaky.md', 'Retry once; a second failure is real.')
    const next = await store.commit(second, { kind: 'task', outcome: 'FAIL' })
    expect(next).toMatchObject({ created: ['lessons/flaky.md'], deleted: ['procedures/build.md'], treeBefore: record.treeAfter })
  })

  it('refuses a draft whose base is no longer canonical', async () => {
    const a = await store.openDraft('a')
    const b = await store.openDraft('b')
    await store.writeDraft(a, 'x.md', 'a')
    await store.writeDraft(b, 'y.md', 'b')
    await store.commit(a, { kind: 'practice', outcome: 'PASS' })
    await expect(store.commit(b, { kind: 'practice', outcome: 'PASS' })).rejects.toBeInstanceOf(MemoryConflictError)
  })

  it('enforces limits while the Actor writes, and again at commit', async () => {
    const draft = await store.openDraft('big')
    await expect(store.writeDraft(draft, 'big.md', 'x'.repeat(2048))).rejects.toThrow(/limit/)
    for (let i = 0; i < 8; i++) await store.writeDraft(draft, `f${i}.md`, 'x')
    // The ninth file is refused at write time, so the Actor can trim within its own learning turn.
    await expect(store.writeDraft(draft, 'f8.md', 'x')).rejects.toThrow(/9 files; the limit is 8/)
    // Replacing an existing file does not add to the count.
    await store.writeDraft(draft, 'f0.md', 'y')
    // A draft that grew outside the tools is still refused at commit.
    await writeFile(join(draft.dir, 'f9.md'), 'x')
    await expect(store.commit(draft, { kind: 'practice', outcome: 'PASS' })).rejects.toThrow(/files/)
  })

  it('searches and reads with line windows', async () => {
    const draft = await store.openDraft('s')
    await store.writeDraft(draft, 'notes.md', 'alpha\nBeta tool\ngamma')
    await store.commit(draft, { kind: 'practice', outcome: 'PASS' })
    expect(await store.search('beta', { regex: false, maxResults: 5 })).toEqual([{ path: 'notes.md', line: 2, text: 'Beta tool' }])
    expect(await store.search('^g', { regex: true, maxResults: 5 })).toHaveLength(1)
    expect(await store.read('notes.md', 2, 1)).toEqual({ text: 'Beta tool', totalLines: 3 })
  })

  it('freezes memory for test-time reuse and detects mutation', async () => {
    await store.freeze()
    await expect(store.openDraft('late')).rejects.toBeInstanceOf(MemoryFrozenError)
    await store.assertFrozenIntact()
    await writeFile(join(store.canonicalDir, 'sneaky.md'), 'edited outside the protocol')
    await expect(store.assertFrozenIntact()).rejects.toThrow(/mutated/)
  })

  it('refuses symlinks in the tree', async () => {
    await symlink('/etc/hostname', join(store.canonicalDir, 'link'))
    await expect(store.manifest()).rejects.toThrow(/symlink/)
  })

  it('quarantines a commit that overlaps sealed material', async () => {
    const audited = new MemoryStore(join(root, 'audited'), limits, {
      keepHistory: false,
      audit: new LeakageAudit(['the held out task asks for exactly seven red widgets on the second sheet'], 8),
    })
    await audited.init()
    const draft = await audited.openDraft('leak')
    await audited.writeDraft(draft, 'cheat.md', 'Remember: the held out task asks for exactly seven red widgets!')
    await expect(audited.commit(draft, { kind: 'practice', outcome: 'PASS' })).rejects.toBeInstanceOf(MemoryQuarantineError)
    expect(await audited.inventory()).toEqual([])
  })

  it('recovers from an install interrupted between its renames', async () => {
    const draft = await store.openDraft('ok')
    await store.writeDraft(draft, 'keep.md', 'durable')
    await store.commit(draft, { kind: 'practice', outcome: 'PASS' })
    await rename(store.canonicalDir, join(root, '.backup-crash'))
    await mkdir(join(root, '.staging-crash'))
    const reopened = new MemoryStore(root, limits, { keepHistory: false })
    await reopened.init()
    expect(await readFile(join(reopened.canonicalDir, 'keep.md'), 'utf8')).toBe('durable')
    expect((await readdir(root)).filter(name => name.startsWith('.'))).toEqual([])
  })
})

describe('workspaceState', () => {
  it('captures uncommitted changes and leaves the RSI state directory out', async () => {
    const { execFileSync } = await import('node:child_process')
    const { workspaceState } = await import('../src/host/git.ts')
    const repo = await mkdtemp(join(tmpdir(), 'dsh-rsi-git-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
    await writeFile(join(repo, 'app.py'), 'print(1)\n')
    await mkdir(join(repo, '.dsh-rsi', 'memory'), { recursive: true })
    await writeFile(join(repo, '.dsh-rsi', 'memory', 'x.md'), 'harness-owned')
    const state = await workspaceState(repo, ['.dsh-rsi'])
    expect(state.tracked).toBe(true)
    expect(state.summary).toContain('?? app.py')
    expect(state.summary).not.toContain('.dsh-rsi')
    const untracked = await workspaceState(await mkdtemp(join(tmpdir(), 'dsh-rsi-nogit-')))
    expect(untracked.tracked).toBe(false)
  })
})

describe('MemoryStore durability', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-rsi-durable-'))
  })

  it('reopens a draft from disk in a fresh store instance after a restart', async () => {
    const first = new MemoryStore(root, limits, { keepHistory: false })
    await first.init()
    const draft = await first.openDraft('task-s1-7')
    await first.writeDraft(draft, 'lesson.md', 'survives restarts')
    const second = new MemoryStore(root, limits, { keepHistory: false })
    await second.init()
    const reopened = await second.reopenDraft('task-s1-7')
    expect(reopened?.baseHash).toBe(draft.baseHash)
    await second.commit(reopened!, { kind: 'task', outcome: 'PASS' })
    expect((await second.read('lesson.md')).text).toBe('survives restarts')
    expect(await second.reopenDraft('task-s1-7')).toBeUndefined()
    expect(await second.findCommit('task-s1-7')).toMatchObject({ episode: 'task-s1-7', outcome: 'PASS' })
  })

  it('stores reports by content and refuses altered ones', async () => {
    const store = new MemoryStore(root, limits, { keepHistory: false })
    await store.init()
    const ref = await store.putReport('VERDICT: PASS')
    expect(await store.getReport(ref.sha256)).toBe('VERDICT: PASS')
    await writeFile(join(root, 'reports', `${ref.sha256}.md`), 'VERDICT: FAIL')
    expect(await store.getReport(ref.sha256)).toBeUndefined()
    expect(await store.getReport('../escape')).toBeUndefined()
  })

  it('tolerates a torn final journal line', async () => {
    const store = new MemoryStore(root, limits, { keepHistory: false })
    await store.init()
    const draft = await store.openDraft('e')
    await store.writeDraft(draft, 'a.md', 'a')
    await store.commit(draft, { kind: 'practice', outcome: 'PASS' })
    await writeFile(join(root, 'journal.jsonl'), `${await readFile(join(root, 'journal.jsonl'), 'utf8')}{"episode":"tor`)
    expect((await store.journal()).map(record => record.episode)).toEqual(['e'])
  })

  it('cleans up drafts of already-committed episodes at init', async () => {
    const store = new MemoryStore(root, limits, { keepHistory: false })
    await store.init()
    const draft = await store.openDraft('done')
    await store.writeDraft(draft, 'a.md', 'a')
    await store.commit(draft, { kind: 'practice', outcome: 'PASS' })
    await mkdir(join(root, 'drafts', 'done'), { recursive: true })
    await writeFile(join(root, 'drafts', 'done.json'), JSON.stringify({ v: 1, episode: 'done', baseHash: '0'.repeat(64), baseManifest: {}, createdAt: '' }))
    await new MemoryStore(root, limits, { keepHistory: false }).init()
    expect(await readdir(join(root, 'drafts'))).toEqual([])
  })

  it('finishes an install whose tree reached canonical before its journal record (crash recovery)', async () => {
    const store = new MemoryStore(root, limits, { keepHistory: true })
    await store.init()
    const draft = await store.openDraft('task-s-3')
    await store.writeDraft(draft, 'lesson.md', 'promoted once')
    const record = await store.commit(draft, { kind: 'task', outcome: 'PASS' })
    // Recreate the crash window: tree installed, marker present, journal and history not yet written, draft kept.
    await writeFile(join(root, 'commit.pending.json'), `${JSON.stringify({ v: 1, record })}\n`)
    await writeFile(join(root, 'journal.jsonl'), '')
    await rm(join(root, 'history'), { recursive: true, force: true })
    await mkdir(join(root, 'drafts', 'task-s-3'), { recursive: true })
    await writeFile(join(root, 'drafts', 'task-s-3', 'lesson.md'), 'promoted once')
    await writeFile(join(root, 'drafts', 'task-s-3.json'), JSON.stringify({ v: 1, episode: 'task-s-3', baseHash: record.treeBefore, baseManifest: {}, createdAt: '' }))
    const restarted = new MemoryStore(root, limits, { keepHistory: true })
    await restarted.init()
    // The promotion is recognized, so a relearn finds the commit instead of conflicting and promoting twice.
    expect(await restarted.findCommit('task-s-3')).toMatchObject({ treeAfter: record.treeAfter })
    expect(await restarted.reopenDraft('task-s-3')).toBeUndefined()
    expect(await readdir(join(root, 'history'))).toEqual(['0001'])
    expect((await readdir(root)).includes('commit.pending.json')).toBe(false)
  })

  it('drops a pending commit whose install never happened', async () => {
    const store = new MemoryStore(root, limits, { keepHistory: false })
    await store.init()
    const draft = await store.openDraft('never')
    await store.writeDraft(draft, 'x.md', 'x')
    const treeBefore = await store.treeHash()
    await writeFile(join(root, 'commit.pending.json'), JSON.stringify({ v: 1, record: { episode: 'never', treeBefore, treeAfter: 'f'.repeat(64) } }))
    const restarted = new MemoryStore(root, limits, { keepHistory: false })
    await restarted.init()
    expect(await restarted.journal()).toEqual([])
    expect(await restarted.reopenDraft('never')).toBeDefined()
  })

  it('never reopens a half-discarded or half-opened draft', async () => {
    const store = new MemoryStore(root, limits, { keepHistory: false })
    await store.init()
    const draft = await store.openDraft('half')
    await store.writeDraft(draft, 'x.md', 'x')
    // A discard that crashed after removing the metadata (removed first) leaves only a directory.
    await rm(join(root, 'drafts', 'half.json'))
    const restarted = new MemoryStore(root, limits, { keepHistory: false })
    await restarted.init()
    expect(await restarted.reopenDraft('half')).toBeUndefined()
    expect(await readdir(join(root, 'drafts'))).toEqual([])
  })

  it('keeps a record appended after a torn journal tail', async () => {
    const store = new MemoryStore(root, limits, { keepHistory: false })
    await store.init()
    await writeFile(join(root, 'journal.jsonl'), '{"episode":"tor')
    const draft = await store.openDraft('after')
    await store.writeDraft(draft, 'a.md', 'a')
    await store.commit(draft, { kind: 'practice', outcome: 'PASS' })
    expect((await store.journal()).map(record => record.episode)).toEqual(['after'])
  })

  it('records a quarantine durably and treats configured freezing like the marker', async () => {
    const audited = new MemoryStore(root, limits, {
      keepHistory: false,
      audit: new LeakageAudit(['the held out task asks for exactly seven red widgets on the second sheet'], 8),
    })
    await audited.init()
    const draft = await audited.openDraft('leak')
    await audited.writeDraft(draft, 'cheat.md', 'Remember: the held out task asks for exactly seven red widgets!')
    await expect(audited.commit(draft, { kind: 'practice', outcome: 'PASS' })).rejects.toBeInstanceOf(MemoryQuarantineError)
    expect(await new MemoryStore(root, limits, { keepHistory: false }).isQuarantined('leak')).toBe(true)

    const frozen = new MemoryStore(root, limits, { keepHistory: false, frozen: true })
    await frozen.init()
    expect(await frozen.frozen()).toBe(true)
    await expect(frozen.openDraft('late')).rejects.toBeInstanceOf(MemoryFrozenError)
  })

  it('serializes mutations across store instances and takes over a dead owner\'s lock', async () => {
    const a = new MemoryStore(root, limits, { keepHistory: false })
    const b = new MemoryStore(root, limits, { keepHistory: false })
    await a.init()
    await b.init()
    const da = await a.openDraft('a')
    await a.writeDraft(da, 'a.md', 'a')
    const db = await b.openDraft('b')
    await b.writeDraft(db, 'b.md', 'b')
    const results = await Promise.allSettled([a.commit(da, { kind: 'practice', outcome: 'PASS' }), b.commit(db, { kind: 'practice', outcome: 'PASS' })])
    // Exactly one promotes; the other sees the changed base and conflicts instead of interleaving installs.
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(MemoryConflictError)
    const { hostname } = await import('node:os')
    await writeFile(join(root, '.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), at: '' }))
    const dc = await a.openDraft('c')
    expect(dc.episode).toBe('c')
  })


  it('moves dsh-rsi 0.1 memory out of the workspace once, leaving a note', async () => {
    const { migrateLegacyMemory } = await import('../src/host/stores.ts')
    const legacy = join(root, 'project', '.dsh-rsi')
    await mkdir(join(legacy, 'memory', 'procedures'), { recursive: true })
    await writeFile(join(legacy, 'memory', 'procedures', 'build.md'), 'make build')
    await writeFile(join(legacy, 'journal.jsonl'), '{"episode":"old"}\n')
    await mkdir(join(legacy, 'drafts', 'x'), { recursive: true })
    const target = join(root, 'home', 'rsi', 'project-abc')
    await migrateLegacyMemory(legacy, target)
    expect(await readFile(join(target, 'memory', 'procedures', 'build.md'), 'utf8')).toBe('make build')
    expect(await readFile(join(target, 'journal.jsonl'), 'utf8')).toContain('"old"')
    expect((await readdir(legacy)).sort()).toEqual(['MOVED.txt'])
    // A second run is a no-op: the private root already holds memory.
    await mkdir(join(legacy, 'memory'), { recursive: true })
    await writeFile(join(legacy, 'memory', 'stale.md'), 'stale')
    await migrateLegacyMemory(legacy, target)
    expect(await readdir(join(target, 'memory'))).toEqual(['procedures'])
  })

})
