import { mkdtemp, mkdir, readdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
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

  it('enforces limits', async () => {
    const draft = await store.openDraft('big')
    await expect(store.writeDraft(draft, 'big.md', 'x'.repeat(2048))).rejects.toThrow(/limit/)
    for (let i = 0; i < 9; i++) await store.writeDraft(draft, `f${i}.md`, 'x')
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
})
