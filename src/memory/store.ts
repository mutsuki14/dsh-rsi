import { randomBytes } from 'node:crypto'
import { appendFile, cp, lstat, mkdir, open, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
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
  /** The verdict this experience came from (shared by a session and its forks); absent for engine episodes. */
  origin?: string
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

export interface CommitMeta {
  kind: EpisodeKind
  outcome: TerminalOutcome
  /** The verdict this experience came from; a second promotion of the same origin returns the first. */
  origin?: string
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

/** Whether a process recorded on this host has exited (never true for another host or an unknown process). */
function processGone(owner: { pid: number, host: string } | undefined): boolean {
  if (!owner || owner.host !== hostname() || owner.pid === process.pid) return false
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
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
  /** Engine drafts record their process: a draft whose process is gone can never be resumed. */
  process?: { pid: number, host: string }
}

/** Identifies this process's lock records, so a restarted process that reuses the pid never mistakes an old lock for its own. */
const LOCK_NONCE = randomBytes(8).toString('hex')
/** Lock tokens this process holds right now. */
const HELD_LOCKS = new Set<string>()
/** A lock whose heartbeat stopped this long ago has no live owner, whatever its pid or host. */
const LOCK_LEASE_MS = 30_000
const LOCK_HEARTBEAT_MS = 5_000

function draftDirName(episode: string): string {
  return safeRelativePath(episode).replace(/\//g, '_')
}

const SHA256_HEX = /^[0-9a-f]{64}$/

/** Written before an install and removed after its journal record: recovery finishes or drops it. */
interface PendingCommit {
  v: 1
  record: CommitRecord
}

export interface MemoryStoreOptions {
  keepHistory: boolean
  audit?: LeakageAudit
  /** Configured test-time reuse: as frozen as the marker file, for every writer. */
  frozen?: boolean
  /** How long a mutation waits for another process's store lock. */
  lockTimeoutMs?: number
}

/**
 * Durable, Actor-owned experience memory (RSIAgent `~/.memory` plus the host
 * commit pipeline). Layout under `root`:
 *
 * - `memory/` — the canonical tree, read by every new Actor context;
 * - `drafts/<episode>/` and `drafts/<episode>.json` — learning-phase working
 *   copies and their metadata (written last, removed first);
 * - `journal.jsonl` — append-only commit records with before/after digests;
 * - `commit.pending.json` — an install in flight, finished or dropped on recovery;
 * - `quarantined/<episode>` — learning phases the silent audit refused;
 * - `history/<n>/` — optional full snapshots after each commit;
 * - `frozen.json` — present when memory is frozen for test-time reuse;
 * - `.lock` — the cross-process mutation lock.
 */
export class MemoryStore {
  readonly canonicalDir: string
  readonly #drafts = new Map<string, MemoryDraft>()
  #chain: Promise<unknown> = Promise.resolve()

  constructor(
    readonly root: string,
    readonly limits: MemoryLimits,
    readonly options: MemoryStoreOptions,
  ) {
    this.canonicalDir = join(root, 'memory')
  }

  /**
   * Creates the layout and recovers from an interrupted install, commit, or
   * draft operation. `prepare` (e.g. a one-time migration) runs first, inside
   * the cross-process lock.
   */
  async init(prepare?: () => Promise<void>): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await this.#serial(() => this.#locked(async () => {
      if (prepare) await prepare()
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
      await this.#resolvePending()
      // Drafts whose episode already reached the journal are leftovers of a crash after promotion;
      // a draft directory without valid metadata was never completely opened, or was half discarded.
      const committed = new Set((await this.journal()).map(record => record.episode))
      const draftsDir = join(this.root, 'drafts')
      const names = await readdir(draftsDir).catch(() => [] as string[])
      const valid = new Set<string>()
      for (const name of names) {
        if (name.endsWith('.json.tmp')) {
          await rm(join(draftsDir, name), { force: true })
          continue
        }
        if (!name.endsWith('.json')) continue
        const meta = await this.#readDraftMeta(join(draftsDir, name))
        if (meta && !committed.has(meta.episode) && !processGone(meta.process) && (await exists(join(draftsDir, draftDirName(meta.episode))))) {
          valid.add(draftDirName(meta.episode))
          continue
        }
        await rm(join(draftsDir, name), { force: true })
        if (meta) await rm(join(draftsDir, draftDirName(meta.episode)), { recursive: true, force: true })
      }
      for (const name of names) {
        if (name.endsWith('.json') || name.endsWith('.json.tmp') || valid.has(name)) continue
        await rm(join(draftsDir, name), { recursive: true, force: true })
      }
    }))
  }

  /** Finishes an install whose tree reached canonical but whose journal record did not, or drops one that never installed. */
  async #resolvePending(): Promise<void> {
    const path = join(this.root, 'commit.pending.json')
    let pending: PendingCommit | undefined
    try {
      pending = JSON.parse(await readFile(path, 'utf8')) as PendingCommit
    } catch {
      // No marker, or a torn one written before any rename: nothing was installed.
      await rm(path, { force: true })
      return
    }
    const canonical = manifestHash(manifestOf(await walk(this.canonicalDir)))
    if (pending.v === 1 && canonical === pending.record.treeAfter) {
      await this.#journalize(pending.record)
      await rm(join(this.root, 'drafts', `${draftDirName(pending.record.episode)}.json`), { force: true })
      await rm(join(this.root, 'drafts', draftDirName(pending.record.episode)), { recursive: true, force: true })
    }
    await rm(path, { force: true })
  }

  /** Appends a record once (newline-safe after a torn tail) and snapshots the tree it produced. */
  async #journalize(record: CommitRecord): Promise<void> {
    const journal = await this.journal()
    if (journal.some(entry => entry.episode === record.episode)) return
    const path = join(this.root, 'journal.jsonl')
    let prefix = ''
    try {
      const info = await stat(path)
      if (info.size > 0) {
        const handle = await open(path, 'r')
        try {
          const last = Buffer.alloc(1)
          await handle.read(last, 0, 1, info.size - 1)
          if (last[0] !== 0x0a) prefix = '\n'
        } finally {
          await handle.close()
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await appendFile(path, `${prefix}${JSON.stringify(record)}\n`)
    if (this.options.keepHistory) {
      const snapshot = join(this.root, 'history', String(journal.length + 1).padStart(4, '0'))
      await rm(snapshot, { recursive: true, force: true })
      await cp(this.canonicalDir, snapshot, { recursive: true })
    }
  }

  /**
   * Cross-process mutation lock (`O_EXCL` lock file). Two dsh processes in the
   * same project share one memory root; recovery and installs never interleave.
   * The holder refreshes the file's time while it works (a lease), so a lock
   * left by a crash is taken over once its heartbeat stops — whatever pid or
   * hostname the next process has — and at once when its owner on this host
   * is known to be gone.
   */
  async #locked<T>(task: () => Promise<T>): Promise<T> {
    const path = join(this.root, '.lock')
    const deadline = Date.now() + (this.options.lockTimeoutMs ?? 60_000)
    const token = `${LOCK_NONCE}:${randomBytes(6).toString('hex')}`
    const owner = `${JSON.stringify({ pid: process.pid, host: hostname(), token, at: new Date().toISOString() })}\n`
    HELD_LOCKS.add(token)
    try {
      for (;;) {
        try {
          const handle = await open(path, 'wx')
          try {
            await handle.writeFile(owner, 'utf8')
          } finally {
            await handle.close()
          }
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          const stale = await this.#staleLock(path)
          if (stale !== undefined) {
            // Take over only the exact record judged stale, never a lock someone else just took.
            const now = await readFile(path, 'utf8').catch(() => undefined)
            if (now === stale) await rm(path, { force: true })
            continue
          }
          if (Date.now() > deadline) throw new Error(`memory store lock ${path} is held by another process; delete it if no dsh process uses this memory`)
          await new Promise(resolve => setTimeout(resolve, 50))
        }
      }
      const beat = setInterval(() => {
        const now = new Date()
        void utimes(path, now, now).catch(() => undefined)
      }, LOCK_HEARTBEAT_MS)
      beat.unref?.()
      try {
        return await task()
      } finally {
        clearInterval(beat)
        await rm(path, { force: true })
      }
    } finally {
      HELD_LOCKS.delete(token)
    }
  }

  /** The stale lock's exact content, or `undefined` while a live owner may hold it. */
  async #staleLock(path: string): Promise<string | undefined> {
    const info = await stat(path).catch(() => undefined)
    if (!info) return undefined
    const content = await readFile(path, 'utf8').catch(() => undefined)
    if (content === undefined) return undefined
    if (Date.now() - info.mtimeMs > LOCK_LEASE_MS) return content
    try {
      const owner = JSON.parse(content) as { pid?: number, host?: string, token?: string }
      // A record of this process that it does not hold now was left by an earlier process with the same pid.
      if (typeof owner.token === 'string' && owner.token.startsWith(`${LOCK_NONCE}:`)) return HELD_LOCKS.has(owner.token) ? undefined : content
      if (owner.pid === process.pid && owner.host === hostname()) return typeof owner.token === 'string' ? content : undefined
      if (owner.host !== hostname() || typeof owner.pid !== 'number') return undefined
      return processGone({ pid: owner.pid, host: owner.host }) ? content : undefined
    } catch {
      // A lock file still being written, or torn by a crash: torn locks older than a few seconds are stale.
      return Date.now() - info.mtimeMs > 5_000 ? content : undefined
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

  /** Whether the freeze marker is present. */
  async isFrozen(): Promise<boolean> {
    return exists(join(this.root, 'frozen.json'))
  }

  /** Whether memory may not change: frozen by configuration or by the marker. */
  async frozen(): Promise<boolean> {
    return this.options.frozen === true || (await this.isFrozen())
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
   * learning phase. Its metadata is written after the copy completes (and is
   * removed before a stale copy is replaced), so a restarted process reopens
   * exactly a complete draft. `fresh` discards any earlier draft of the episode
   * instead of continuing it (engine episodes never resume a dead context's draft).
   */
  openDraft(episode: string, options: { fresh?: boolean } = {}): Promise<MemoryDraft> {
    return this.#serial(() => this.#locked(async () => {
      if (await this.frozen()) throw new MemoryFrozenError()
      if (options.fresh) await this.#discard(episode)
      const existing = this.#drafts.get(episode) ?? (await this.#reopen(episode))
      if (existing) return existing
      const dir = join(this.root, 'drafts', draftDirName(episode))
      const metaPath = `${dir}.json`
      await rm(metaPath, { force: true })
      await rm(dir, { recursive: true, force: true })
      await mkdir(dirname(dir), { recursive: true })
      await cp(this.canonicalDir, dir, { recursive: true })
      const baseManifest = manifestOf(await walk(dir))
      const draft = new MemoryDraft(episode, dir, manifestHash(baseManifest), baseManifest)
      const meta: DraftMeta = {
        v: 1,
        episode,
        baseHash: draft.baseHash,
        baseManifest,
        createdAt: new Date().toISOString(),
        ...(options.fresh ? { process: { pid: process.pid, host: hostname() } } : {}),
      }
      await writeFile(`${metaPath}.tmp`, `${JSON.stringify(meta)}\n`)
      await rename(`${metaPath}.tmp`, metaPath)
      this.#drafts.set(episode, draft)
      return draft
    }))
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

  /** Files and bytes a draft tree holds, from metadata only. */
  async #usage(dir: string): Promise<Map<string, number>> {
    const sizes = new Map<string, number>()
    const visit = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) await visit(full)
        else if (entry.isFile()) sizes.set(relative(dir, full).split(sep).join('/'), (await lstat(full)).size)
      }
    }
    await visit(dir)
    return sizes
  }

  async writeDraft(draft: MemoryDraft, path: string, content: string): Promise<void> {
    const rel = safeRelativePath(path)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > this.limits.maxFileBytes) throw new MemoryLimitError(`memory file ${rel} is ${bytes} bytes; the limit is ${this.limits.maxFileBytes}`)
    // Aggregate limits apply while the Actor writes, so it can trim within its own learning turn.
    // Only growth is refused here: condensing an over-limit draft must stay possible; commit checks the result.
    const usage = await this.#usage(draft.dir)
    const previous = usage.get(rel)
    const total = [...usage.values()].reduce((sum, size) => sum + size, 0) - (previous ?? 0) + bytes
    if (previous === undefined && usage.size + 1 > this.limits.maxFiles) {
      throw new MemoryLimitError(`memory would hold ${usage.size + 1} files; the limit is ${this.limits.maxFiles}. Merge or delete files first.`)
    }
    if (total > this.limits.maxTotalBytes && bytes > (previous ?? 0)) {
      throw new MemoryLimitError(`memory would hold ${total} bytes; the limit is ${this.limits.maxTotalBytes}. Condense or delete files first.`)
    }
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

  /** The commit of `episode`, or of any episode that came from it as its origin verdict. */
  async findCommit(episode: string): Promise<CommitRecord | undefined> {
    return (await this.journal()).find(record => record.episode === episode || record.origin === episode)
  }

  async draftManifest(draft: MemoryDraft): Promise<Manifest> {
    return manifestOf(await walk(draft.dir))
  }

  /** Whether the silent audit refused this episode's learning phase. */
  async isQuarantined(episode: string): Promise<boolean> {
    return exists(join(this.root, 'quarantined', draftDirName(episode)))
  }

  discardDraft(episode: string): Promise<void> {
    return this.#serial(() => this.#locked(() => this.#discard(episode)))
  }

  /** Metadata first: a crash mid-delete leaves a directory init() removes, never a reopenable partial draft. */
  async #discard(episode: string): Promise<void> {
    this.#drafts.delete(episode)
    const dir = join(this.root, 'drafts', draftDirName(episode))
    await rm(`${dir}.json`, { force: true })
    await rm(`${dir}.json.tmp`, { force: true })
    await rm(dir, { recursive: true, force: true })
  }

  /**
   * Promotes a draft as the new canonical tree: validates limits and the
   * optional audit, records the intended commit, replaces the full tree with
   * stage-and-rename, then appends the journal. Commits are serialized across
   * processes; a draft whose base is no longer canonical is refused rather than
   * silently overwriting a sibling commit.
   */
  commit(draft: MemoryDraft, meta: CommitMeta): Promise<CommitRecord> {
    return this.#serial(() => this.#locked(() => this.#commit(draft, meta)))
  }

  async #commit(draft: MemoryDraft, meta: CommitMeta): Promise<CommitRecord> {
    if (await this.frozen()) throw new MemoryFrozenError()
    await this.#resolvePending()
    // The same experience is promoted once: by episode, and by the verdict it came from (a session and its forks).
    const already = (await this.journal()).find(record => record.episode === draft.episode || (meta.origin !== undefined && (record.origin === meta.origin || record.episode === meta.origin)))
    if (already) {
      await this.#discard(draft.episode)
      return already
    }
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
        // Durable before the draft goes: no second learning phase for a quarantined episode, even after a crash.
        await mkdir(join(this.root, 'quarantined'), { recursive: true })
        for (const id of meta.origin === undefined ? [draft.episode] : [draft.episode, meta.origin]) {
          await writeFile(join(this.root, 'quarantined', draftDirName(id)), `${new Date().toISOString()}\n`)
        }
        await this.#discard(draft.episode)
        throw new MemoryQuarantineError()
      }
    }

    const record: CommitRecord = {
      episode: draft.episode,
      ...(meta.origin === undefined ? {} : { origin: meta.origin }),
      kind: meta.kind,
      outcome: meta.outcome,
      ts: new Date().toISOString(),
      files: files.size,
      bytes: total,
      treeBefore: beforeHash,
      treeAfter: manifestHash(after),
      ...diffManifests(before, after),
    }
    const nonce = randomBytes(6).toString('hex')
    const staging = join(this.root, `.staging-${nonce}`)
    const backup = join(this.root, `.backup-${nonce}`)
    const pendingPath = join(this.root, 'commit.pending.json')
    await cp(draft.dir, staging, { recursive: true })
    const pending: PendingCommit = { v: 1, record }
    await writeFile(`${pendingPath}.tmp`, `${JSON.stringify(pending)}\n`)
    await rename(`${pendingPath}.tmp`, pendingPath)
    await rename(this.canonicalDir, backup)
    try {
      await rename(staging, this.canonicalDir)
    } catch (error) {
      await rename(backup, this.canonicalDir)
      await rm(staging, { recursive: true, force: true })
      await rm(pendingPath, { force: true })
      throw error
    }
    await this.#journalize(record)
    await rm(pendingPath, { force: true })
    await rm(backup, { recursive: true, force: true })
    await this.#discard(draft.episode)
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
