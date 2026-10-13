import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { sha256 } from '../memory/hash.ts'
import { gitLines } from './git.ts'

const IGNORED = new Set(['.git', 'node_modules', '.venv', '__pycache__'])

interface Entry {
  /** Content digest, or undefined in detect-only mode (size, mtime, and mode are compared instead). */
  sha256?: string
  size: number
  mtimeMs: number
  mode: number
}

export interface CheckpointLimits {
  /** Above this many bytes the checkpoint only detects changes and restores nothing. */
  maxBytes: number
  maxFiles: number
}

type Method = 'git' | 'walk'

const ABSENT = new Set(['ENOENT', 'ENOTDIR'])
const UNREADABLE = new Set(['EACCES', 'EPERM', 'ELOOP'])

function absent(error: unknown): boolean {
  return ABSENT.has((error as NodeJS.ErrnoException).code ?? '')
}

function skippable(error: unknown): boolean {
  return absent(error) || UNREADABLE.has((error as NodeJS.ErrnoException).code ?? '')
}

/**
 * Candidate checkpoint for an interactive inspection (RSIAgent: Verifier
 * effects never reach the candidate). It covers the files a change capture can
 * see — tracked and untracked-but-not-ignored files in a git work tree, or every
 * file outside dependency and VCS directories otherwise. `excludes` are
 * harness-owned paths relative to the root.
 *
 * The listing method is fixed when the checkpoint is taken, and a path that
 * existed then (ignored files included) is never deleted on restore: only
 * files the inspection created are removed.
 */
export class WorkspaceCheckpoint {
  private constructor(
    readonly root: string,
    readonly excludes: readonly string[],
    readonly method: Method,
    readonly entries: Map<string, Entry>,
    /** Ignored paths (git: directories end with `/`) that existed at take time. */
    readonly ignoredBefore: readonly string[],
    /** Copy of the checked files, or undefined in detect-only mode. */
    readonly store: string | undefined,
    /** Paths that could not be read when the checkpoint was taken. */
    readonly unreadable: readonly string[],
  ) {}

  static async take(root: string, excludes: readonly string[], limits: CheckpointLimits): Promise<WorkspaceCheckpoint> {
    const listing = await listFiles(root, excludes, undefined)
    if (listing === undefined) throw new Error('the candidate files could not be listed')
    const unreadable: string[] = []
    const stats = new Map<string, { size: number, mtimeMs: number, mode: number }>()
    let bytes = 0
    for (const rel of listing.files) {
      try {
        const info = await lstat(join(root, rel))
        if (!info.isFile()) continue
        stats.set(rel, { size: info.size, mtimeMs: info.mtimeMs, mode: info.mode })
        bytes += info.size
      } catch (error) {
        if (!skippable(error)) throw error
        // A tracked file deleted from the work tree has nothing to checkpoint; an unreadable one exists.
        if (!absent(error)) unreadable.push(rel)
      }
    }
    const detectOnly = stats.size > limits.maxFiles || bytes > limits.maxBytes
    const entries = new Map<string, Entry>()
    let store: string | undefined
    if (!detectOnly) store = await mkdtemp(join(tmpdir(), 'dsh-rsi-checkpoint-'))
    try {
      for (const [rel, info] of stats) {
        if (detectOnly) {
          entries.set(rel, info)
          continue
        }
        try {
          const data = await readFile(join(root, rel))
          await mkdir(dirname(join(store!, rel)), { recursive: true })
          await copyFile(join(root, rel), join(store!, rel))
          entries.set(rel, { ...info, sha256: sha256(data) })
        } catch (error) {
          if (!skippable(error)) throw error
          if (!absent(error)) unreadable.push(rel)
        }
      }
    } catch (error) {
      if (store) await rm(store, { recursive: true, force: true })
      throw error
    }
    const ignoredBefore = listing.method === 'git' ? ((await gitLines(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], '\0')) ?? []) : []
    return new WorkspaceCheckpoint(root, excludes, listing.method, entries, ignoredBefore, store, unreadable.sort())
  }

  get restores(): boolean {
    return this.store !== undefined
  }

  /** Whether `rel` may have existed before the inspection although it was not checkpointed. */
  #preexisting(rel: string): boolean {
    return this.unreadable.includes(rel) || this.ignoredBefore.some(path => (path.endsWith('/') ? rel.startsWith(path) : rel === path))
  }

  /**
   * Paths whose content differs from the checkpoint, including created and
   * deleted files, plus whether this comparison could list the tree at all
   * (`listed: false` when the take-time listing method no longer works).
   */
  async compare(): Promise<{ changed: string[], created: Set<string>, listed: boolean }> {
    const listing = await listFiles(this.root, this.excludes, this.method)
    const changed: string[] = []
    for (const [rel, entry] of this.entries) {
      let info
      try {
        info = await lstat(join(this.root, rel))
      } catch (error) {
        if (!skippable(error)) throw error
        changed.push(rel)
        continue
      }
      if (!info.isFile() || (info.mode & 0o7777) !== (entry.mode & 0o7777)) {
        changed.push(rel)
        continue
      }
      if (entry.sha256 === undefined) {
        if (info.size !== entry.size || info.mtimeMs !== entry.mtimeMs) changed.push(rel)
        continue
      }
      if (info.size !== entry.size) {
        changed.push(rel)
        continue
      }
      try {
        if (sha256(await readFile(join(this.root, rel))) !== entry.sha256) changed.push(rel)
      } catch (error) {
        if (!skippable(error)) throw error
        changed.push(rel)
      }
    }
    const created = new Set<string>()
    if (listing !== undefined) {
      for (const rel of listing.files) {
        if (this.entries.has(rel)) continue
        // A listed path counts as created only when a regular file is there now.
        const info = await lstat(join(this.root, rel)).catch(() => undefined)
        if (!info?.isFile()) continue
        created.add(rel)
        changed.push(rel)
      }
    }
    return { changed: [...new Set(changed)].sort(), created, listed: listing !== undefined }
  }

  async changes(): Promise<string[]> {
    return (await this.compare()).changed
  }

  /**
   * Restores every changed path from the checkpoint and removes files the
   * inspection created; returns what changed. A path that cannot be restored is
   * reported, never a reason to stop restoring the others.
   */
  async restore(): Promise<string[]> {
    const { changed, created } = await this.compare()
    if (!this.store) return changed
    for (const rel of changed) {
      const full = join(this.root, rel)
      const entry = this.entries.get(rel)
      try {
        if (entry === undefined) {
          // Only what the inspection created goes; a pre-existing (ignored or unreadable) path stays.
          if (created.has(rel) && !this.#preexisting(rel)) await rm(full, { recursive: true, force: true })
          continue
        }
        await mkdir(dirname(full), { recursive: true })
        const staged = `${full}.dsh-rsi-restore`
        await copyFile(join(this.store, rel), staged)
        await chmod(staged, entry.mode & 0o7777)
        await rm(full, { recursive: true, force: true })
        await rename(staged, full)
      } catch {
        // Reported through the changed list; the harness note tells the Actor to inspect it.
      }
    }
    return changed
  }

  async dispose(): Promise<void> {
    if (this.store) await rm(this.store, { recursive: true, force: true })
  }
}

/**
 * Candidate files by one method: `git` (tracked plus untracked-but-not-ignored)
 * or a `walk` that skips VCS and dependency directories. `undefined` when the
 * requested method fails, so a comparison never mixes the two.
 */
async function listFiles(root: string, excludes: readonly string[], method: Method | undefined): Promise<{ method: Method, files: string[] } | undefined> {
  const excluded = (rel: string) => excludes.some(ex => rel === ex || rel.startsWith(`${ex}/`))
  if (method !== 'walk') {
    const tracked = await gitLines(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], '\0')
    if (tracked !== undefined) return { method: 'git', files: [...new Set(tracked.filter(rel => rel !== '' && !excluded(rel)))] }
    if (method === 'git') return undefined
  }
  const files: string[] = []
  const visit = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (skippable(error)) return
      throw error
    }
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue
      const full = join(dir, entry.name)
      const rel = relative(root, full).split(sep).join('/')
      if (excluded(rel)) continue
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile()) files.push(rel)
    }
  }
  await visit(root)
  return { method: 'walk', files }
}
