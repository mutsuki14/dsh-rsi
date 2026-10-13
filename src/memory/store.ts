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
  readonly code = 'RSI_MEMORY_FROZEN'
  constructor() {
    super('memory is frozen: test-time reuse never updates durable memory')
  }
}

export class MemoryConflictError extends Error {
  readonly code = 'RSI_MEMORY_CONFLICT'
  constructor(readonly expected: string, readonly actual: string) {
    super('durable memory changed after this draft was opened; reopen the learning phase against the current memory')
  }
}

/** Deliberately neutral: like RSIAgent's silent audit, the reason never reaches an agent. */
export class MemoryQuarantineError extends Error {
  readonly code = 'RSI_MEMORY_QUARANTINED'
  constructor() {
    super('this learning phase could not be promoted; durable memory is unchanged')
  }
}

export class MemoryLimitError extends Error {
  readonly code = 'RSI_MEMORY_LIMIT'
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

interface DraftMeta {
  v: 1
  episode: string
  baseHash: string
  baseManifest: Manifest
  createdAt: string
}

function draftDirName(episode: string): string {
  return safeRelativePath(episode).replace(/\//g, '_')
}

const SHA256_HEX = /^[0-9a-f]{64}$/

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
  #chain: Promise<unknown> = Promise.resolve()

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
    // Drafts whose episode already reached the journal are leftovers of a crash after promotion.
    const committed = new Set((await this.journal()).map(record => record.episode))
    for (const name of await readdir(join(this.root, 'drafts')).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue
      const meta = await this.#readDraftMeta(join(this.root, 'drafts', name))
      if (meta && committed.has(meta.episode)) {
        await rm(join(this.root, 'drafts', draftDirName(meta.episode)), { recursive: true, force: true })
        await rm(join(this.root, 'drafts', name), { force: true })
      }
    }
  }

  /** Runs store mutations one at a time (open, commit, discard). */
  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(task)
    this.#chain = run.catch(() => undefined)
    return run
  }

  async #readDraftMeta(path: string): Promise<DraftMeta | undefined> {
    try {
      const meta = JSON.parse(await readFile(path, 'utf8')) as DraftMeta
      return meta.v === 1 && typeof meta.episode === 'string' && SHA256_HEX.test(meta.baseHash) ? meta : undefined
    } catch {
      // A missing or torn metadata file means the draft was never completely opened.
      return undefined
    }
  }

  async manifest(): Promise<Manifest> {
    return manifestOf(await walk(this.canonicalDir))
  }

  /** Manifest of another tree the store owns, such as a wave snapshot or a draft. */
  async manifestAt(dir: string): Promise<Manifest> {
    return manifestOf(await walk(dir))
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

  /**
   * Copies the current canonical tree into a fresh draft for one episode's
   * learning phase. Its metadata is written after the copy completes, so a
   * restarted process can reopen exactly that draft.
   */
  openDraft(episode: string): Promise<MemoryDraft> {
    return this.#serial(async () => {
      if (await this.isFrozen()) throw new MemoryFrozenError()
      const existing = this.#drafts.get(episode) ?? (await this.#reopen(episode))
      if (existing) return existing
      const dir = join(this.root, 'drafts', draftDirName(episode))
      await rm(dir, { recursive: true, force: true })
      await mkdir(dirname(dir), { recursive: true })
      await cp(this.canonicalDir, dir, { recursive: true })
      const baseManifest = manifestOf(await walk(dir))
      const draft = new MemoryDraft(episode, dir, manifestHash(baseManifest), baseManifest)
      const meta: DraftMeta = { v: 1, episode, baseHash: draft.baseHash, baseManifest, createdAt: new Date().toISOString() }
      const metaPath = `${dir}.json`
      await writeFile(`${metaPath}.tmp`, `${JSON.stringify(meta)}\n`)
      await rename(`${metaPath}.tmp`, metaPath)
      this.#drafts.set(episode, draft)
      return draft
    })
  }

  /** Reopens a draft from disk after a restart; `undefined` when it is gone or incomplete. */
  reopenDraft(episode: string): Promise<MemoryDraft | undefined> {
    return this.#serial(async () => this.#drafts.get(episode) ?? this.#reopen(episode))
  }

  async #reopen(episode: string): Promise<MemoryDraft | undefined> {
    const dir = join(this.root, 'drafts', draftDirName(episode))
    const meta = await this.#readDraftMeta(`${dir}.json`)
    if (!meta || meta.episode !== episode || !(await exists(dir))) return undefined
    const draft = new MemoryDraft(episode, dir, meta.baseHash, meta.baseManifest)
    this.#drafts.set(episode, draft)
    return draft
  }

  async writeDraft(draft: MemoryDraft, path: string, content: string): Promise<void> {
    const rel = safeRelativePath(path)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > this.limits.maxFileBytes) throw new MemoryLimitError(`memory file ${rel} is ${bytes} bytes; the limit is ${this.limits.maxFileBytes}`)
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

  /** Content-addressed Verifier report, outside every role's working directory. */
  async putReport(text: string): Promise<{ sha256: string, bytes: number }> {
    const digest = sha256(text)
    const dir = join(this.root, 'reports')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${digest}.md`)
    if (!(await exists(path))) {
      await writeFile(`${path}.tmp`, text, 'utf8')
      await rename(`${path}.tmp`, path)
    }
    return { sha256: digest, bytes: Buffer.byteLength(text, 'utf8') }
  }

  /** The report with this digest, or `undefined` when missing or altered. */
  async getReport(digest: string): Promise<string | undefined> {
    if (!SHA256_HEX.test(digest)) return undefined
    try {
      const text = await readFile(join(this.root, 'reports', `${digest}.md`), 'utf8')
      return sha256(text) === digest ? text : undefined
    } catch {
      // A lost report is reported to the caller as unavailable rather than guessed.
      return undefined
    }
  }

  async findCommit(episode: string): Promise<CommitRecord | undefined> {
    return (await this.journal()).find(record => record.episode === episode)
  }

  async draftManifest(draft: MemoryDraft): Promise<Manifest> {
    return manifestOf(await walk(draft.dir))
  }

  async discardDraft(episode: string): Promise<void> {
    this.#drafts.delete(episode)
    const dir = join(this.root, 'drafts', draftDirName(episode))
    await rm(dir, { recursive: true, force: true })
    await rm(`${dir}.json`, { force: true })
  }

  /**
   * Promotes a draft as the new canonical tree: validates limits and the
   * optional audit, replaces the full tree with stage-and-rename, then appends
   * the journal. Commits are serialized; a draft whose base is no longer
   * canonical is refused rather than silently overwriting a sibling commit.
   */
  commit(draft: MemoryDraft, meta: { kind: EpisodeKind, outcome: TerminalOutcome }): Promise<CommitRecord> {
    return this.#serial(() => this.#commit(draft, meta))
  }

  async #commit(draft: MemoryDraft, meta: { kind: EpisodeKind, outcome: TerminalOutcome }): Promise<CommitRecord> {
    if (await this.isFrozen()) throw new MemoryFrozenError()
    const before = await this.manifest()
    const beforeHash = manifestHash(before)
    if (beforeHash !== draft.baseHash) throw new MemoryConflictError(draft.baseHash, beforeHash)
    const files = await walk(draft.dir)
    const after = manifestOf(files)
    const total = Object.values(after).reduce((sum, entry) => sum + entry.bytes, 0)
    if (files.size > this.limits.maxFiles) throw new MemoryLimitError(`memory would hold ${files.size} files; the limit is ${this.limits.maxFiles}`)
    if (total > this.limits.maxTotalBytes) throw new MemoryLimitError(`memory would hold ${total} bytes; the limit is ${this.limits.maxTotalBytes}`)
    for (const [path, entry] of Object.entries(after)) {
      if (entry.bytes > this.limits.maxFileBytes) throw new MemoryLimitError(`memory file ${path} exceeds ${this.limits.maxFileBytes} bytes`)
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
    await rm(`${draft.dir}.json`, { force: true })
    return record
  }

  async journal(): Promise<CommitRecord[]> {
    const path = join(this.root, 'journal.jsonl')
    if (!(await exists(path))) return []
    const records: CommitRecord[] = []
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      if (line.trim() === '') continue
      try {
        records.push(JSON.parse(line) as CommitRecord)
      } catch {
        // A torn final line from an interrupted append is not a record.
      }
    }
    return records
  }
}
