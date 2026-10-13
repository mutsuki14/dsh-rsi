import { randomBytes } from 'node:crypto'
import { appendFile, cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { LeakageAudit } from './audit.ts'
import { sha256, treeSha256, type TreeHashes } from './hash.ts'
import { safeRelativePath } from './paths.ts'

export interface MemoryLimits {
  maxFileBytes: number
  maxTotalBytes: number
  maxFiles: number
}

export interface ManifestEntry {
  bytes: number
  sha256: string
}

export type Manifest = Record<string, ManifestEntry>

export type EpisodeKind = 'practice' | 'target' | 'task'
export type TerminalOutcome = 'PASS' | 'FAIL'

export interface CommitRecord {
  episode: string
  kind: EpisodeKind
  outcome: TerminalOutcome
  ts: string
  files: number
  bytes: number
  treeBefore: string
  treeAfter: string
  created: string[]
  modified: string[]
  deleted: string[]
}

export interface MemoryDelta {
  created: string[]
  modified: string[]
  deleted: string[]
}

export class MemoryFrozenError extends Error {
  constructor() {
    super('memory is frozen: test-time reuse never updates durable memory')
  }
}

export class MemoryConflictError extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super('durable memory changed after this draft was opened; reopen the learning phase against the current memory')
  }
}

export class MemoryQuarantineError extends Error {
  constructor() {
    super('the candidate memory was quarantined by the leakage audit; durable memory is unchanged')
  }
}

export function diffManifests(before: Manifest, after: Manifest): MemoryDelta {
  const created: string[] = []
  const modified: string[] = []
  const deleted: string[] = []
  for (const [path, entry] of Object.entries(after)) {
    const prior = before[path]
    if (prior === undefined) created.push(path)
    else if (prior.sha256 !== entry.sha256) modified.push(path)
  }
  for (const path of Object.keys(before)) if (after[path] === undefined) deleted.push(path)
  return { created: created.sort(), modified: modified.sort(), deleted: deleted.sort() }
}

export function manifestHash(manifest: Manifest): string {
  const hashes: TreeHashes = {}
  for (const [path, entry] of Object.entries(manifest)) hashes[path] = entry.sha256
  return treeSha256(hashes)
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Walks a memory tree. Symlinks are refused so memory never aliases outside its root. */
async function walk(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  if (!(await exists(root))) return files
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`memory tree contains a symlink: ${relative(root, full)}`)
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile()) files.set(relative(root, full).split(sep).join('/'), await readFile(full))
    }
  }
  await visit(root)
  return files
}

function manifestOf(files: ReadonlyMap<string, Buffer>): Manifest {
  const manifest: Manifest = {}
  for (const [path, data] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    manifest[path] = { bytes: data.byteLength, sha256: sha256(data) }
  }
  return manifest
}

export interface SearchMatch {
  path: string
  line: number
  text: string
}

/**
 * A disposable working copy of durable memory opened for one learning phase.
 * Writes never touch the canonical tree until `MemoryStore.commit` promotes the
 * whole draft atomically.
 */
export class MemoryDraft {
  constructor(
    readonly episode: string,
    readonly dir: string,
    /** Canonical tree digest the draft was copied from. */
    readonly baseHash: string,
    readonly baseManifest: Manifest,
  ) {}
}

/**
 * Durable, Actor-owned experience memory (RSIAgent `~/.memory` plus the host
 * commit pipeline). Layout under `root`:
 *
 * - `memory/` — the canonical tree, read by every new Actor context;
 * - `drafts/<episode>/` — learning-phase working copies;
 * - `journal.jsonl` — append-only commit records with before/after digests;
 * - `history/<n>/` — optional full snapshots after each commit;
 * - `frozen.json` — present when memory is frozen for test-time reuse.
 */
export class MemoryStore {
  readonly canonicalDir: string
  readonly #drafts = new Map<string, MemoryDraft>()
  #commitChain: Promise<unknown> = Promise.resolve()

  constructor(
    readonly root: string,
    readonly limits: MemoryLimits,
    readonly options: { keepHistory: boolean, audit?: LeakageAudit },
  ) {
    this.canonicalDir = join(root, 'memory')
  }

  /** Creates the layout and recovers from an install interrupted between its two renames. */
  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const entries = await readdir(this.root)
    const backups = entries.filter(name => name.startsWith('.backup-'))
    if (!(await exists(this.canonicalDir)) && backups.length > 0) {
      await rename(join(this.root, backups.sort().at(-1)!), this.canonicalDir)
    }
    for (const name of entries) {
      if (name.startsWith('.staging-') || (name.startsWith('.backup-') && (await exists(this.canonicalDir)))) {
        await rm(join(this.root, name), { recursive: true, force: true })
      }
    }
    await mkdir(this.canonicalDir, { recursive: true })
  }

  async manifest(): Promise<Manifest> {
    return manifestOf(await walk(this.canonicalDir))
  }

  async treeHash(): Promise<string> {
    return manifestHash(await this.manifest())
  }

  /** Mechanical inventory: names and sizes only, no file bodies and no privileged index. */
  async inventory(): Promise<Array<{ path: string, bytes: number }>> {
    return Object.entries(await this.manifest()).map(([path, entry]) => ({ path, bytes: entry.bytes }))
  }

  async read(path: string, offset = 1, limit?: number, dir = this.canonicalDir): Promise<{ text: string, totalLines: number }> {
    const rel = safeRelativePath(path)
    const content = await readFile(join(dir, rel), 'utf8')
    const lines = content.split('\n')
    const start = Math.max(1, offset)
    const end = limit === undefined ? lines.length : Math.min(lines.length, start - 1 + limit)
    return { text: lines.slice(start - 1, end).join('\n'), totalLines: lines.length }
  }

  async search(query: string, options: { regex: boolean, maxResults: number }, dir = this.canonicalDir): Promise<SearchMatch[]> {
    const matcher = options.regex ? new RegExp(query, 'i') : undefined
    const needle = query.toLowerCase()
    const matches: SearchMatch[] = []
    for (const [path, data] of await walk(dir)) {
      const lines = data.toString('utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        if (matcher ? matcher.test(line) : line.toLowerCase().includes(needle)) {
          matches.push({ path, line: i + 1, text: line.length > 400 ? `${line.slice(0, 400)}…` : line })
          if (matches.length >= options.maxResults) return matches
        }
      }
    }
    return matches
  }

  async isFrozen(): Promise<boolean> {
    return exists(join(this.root, 'frozen.json'))
  }

  /** Freezes the current tree: drafts can no longer be opened or committed. */
  async freeze(): Promise<string> {
    const hash = await this.treeHash()
    await writeFile(join(this.root, 'frozen.json'), `${JSON.stringify({ treeHash: hash, frozenAt: new Date().toISOString() })}\n`)
    return hash
  }

  async unfreeze(): Promise<void> {
    await rm(join(this.root, 'frozen.json'), { force: true })
  }

  /** Throws when frozen memory no longer matches its recorded digest. */
  async assertFrozenIntact(): Promise<void> {
    const recorded = JSON.parse(await readFile(join(this.root, 'frozen.json'), 'utf8')) as { treeHash: string }
    const actual = await this.treeHash()
    if (recorded.treeHash !== actual) throw new Error(`frozen memory was mutated (expected ${recorded.treeHash}, found ${actual})`)
  }

  draft(episode: string): MemoryDraft | undefined {
    return this.#drafts.get(episode)
  }

  /** Copies the current canonical tree into a fresh draft for one episode's learning phase. */
  async openDraft(episode: string): Promise<MemoryDraft> {
    if (await this.isFrozen()) throw new MemoryFrozenError()
    const existing = this.#drafts.get(episode)
    if (existing) return existing
    const dir = join(this.root, 'drafts', safeRelativePath(episode).replace(/\//g, '_'))
    await rm(dir, { recursive: true, force: true })
    await mkdir(dirname(dir), { recursive: true })
    await cp(this.canonicalDir, dir, { recursive: true })
    const baseManifest = await this.manifest()
    const draft = new MemoryDraft(episode, dir, manifestHash(baseManifest), baseManifest)
    this.#drafts.set(episode, draft)
    return draft
  }

  async writeDraft(draft: MemoryDraft, path: string, content: string): Promise<void> {
    const rel = safeRelativePath(path)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > this.limits.maxFileBytes) throw new Error(`memory file ${rel} is ${bytes} bytes; the limit is ${this.limits.maxFileBytes}`)
    const full = join(draft.dir, rel)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content, 'utf8')
  }

  async deleteDraft(draft: MemoryDraft, path: string): Promise<boolean> {
    const full = join(draft.dir, safeRelativePath(path))
    if (!(await exists(full))) return false
    await rm(full, { recursive: true })
    return true
  }

  async draftManifest(draft: MemoryDraft): Promise<Manifest> {
    return manifestOf(await walk(draft.dir))
  }

  async discardDraft(episode: string): Promise<void> {
    const draft = this.#drafts.get(episode)
    if (!draft) return
    this.#drafts.delete(episode)
    await rm(draft.dir, { recursive: true, force: true })
  }

  /**
   * Promotes a draft as the new canonical tree: validates limits and the
   * optional audit, replaces the full tree with stage-and-rename, then appends
   * the journal. Commits are serialized; a draft whose base is no longer
   * canonical is refused rather than silently overwriting a sibling commit.
   */
  commit(draft: MemoryDraft, meta: { kind: EpisodeKind, outcome: TerminalOutcome }): Promise<CommitRecord> {
    const run = this.#commitChain.then(() => this.#commit(draft, meta))
    this.#commitChain = run.catch(() => undefined)
    return run
  }

  async #commit(draft: MemoryDraft, meta: { kind: EpisodeKind, outcome: TerminalOutcome }): Promise<CommitRecord> {
    if (await this.isFrozen()) throw new MemoryFrozenError()
    const before = await this.manifest()
    const beforeHash = manifestHash(before)
    if (beforeHash !== draft.baseHash) throw new MemoryConflictError(draft.baseHash, beforeHash)
    const files = await walk(draft.dir)
    const after = manifestOf(files)
    const total = Object.values(after).reduce((sum, entry) => sum + entry.bytes, 0)
    if (files.size > this.limits.maxFiles) throw new Error(`memory would hold ${files.size} files; the limit is ${this.limits.maxFiles}`)
    if (total > this.limits.maxTotalBytes) throw new Error(`memory would hold ${total} bytes; the limit is ${this.limits.maxTotalBytes}`)
    for (const [path, entry] of Object.entries(after)) {
      if (entry.bytes > this.limits.maxFileBytes) throw new Error(`memory file ${path} exceeds ${this.limits.maxFileBytes} bytes`)
    }
    if (this.options.audit?.enabled) {
      const text = new Map([...files].map(([path, data]) => [path, data.toString('utf8')] as const))
      if (this.options.audit.flagged(text).length > 0) {
        await this.discardDraft(draft.episode)
        throw new MemoryQuarantineError()
      }
    }

    const nonce = randomBytes(6).toString('hex')
    const staging = join(this.root, `.staging-${nonce}`)
    const backup = join(this.root, `.backup-${nonce}`)
    await cp(draft.dir, staging, { recursive: true })
    await rename(this.canonicalDir, backup)
    await rename(staging, this.canonicalDir)
    await rm(backup, { recursive: true, force: true })

    const delta = diffManifests(before, after)
    const record: CommitRecord = {
      episode: draft.episode,
      kind: meta.kind,
      outcome: meta.outcome,
      ts: new Date().toISOString(),
      files: files.size,
      bytes: total,
      treeBefore: beforeHash,
      treeAfter: manifestHash(after),
      ...delta,
    }
    await appendFile(join(this.root, 'journal.jsonl'), `${JSON.stringify(record)}\n`)
    if (this.options.keepHistory) {
      const count = (await this.journal()).length
      await cp(this.canonicalDir, join(this.root, 'history', String(count).padStart(4, '0')), { recursive: true })
    }
    this.#drafts.delete(draft.episode)
    await rm(draft.dir, { recursive: true, force: true })
    return record
  }

  async journal(): Promise<CommitRecord[]> {
    const path = join(this.root, 'journal.jsonl')
    if (!(await exists(path))) return []
    return (await readFile(path, 'utf8'))
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as CommitRecord)
  }
}
