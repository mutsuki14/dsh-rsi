import { mkdtemp, copyFile, mkdir, readdir, readFile, rm, lstat, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { sha256 } from '../memory/hash.ts'
import { gitLines } from './git.ts'

const IGNORED = new Set(['.git', 'node_modules', '.venv', '__pycache__'])

interface Entry {
  sha256: string
  mode: number
}

export interface CheckpointLimits {
  /** Above this many bytes the checkpoint only detects changes and restores nothing. */
  maxBytes: number
  maxFiles: number
}

/**
 * Candidate checkpoint for an interactive inspection (RSIAgent: Verifier
 * effects never reach the candidate). It covers the files a change capture can
 * see — tracked and untracked-but-not-ignored files in a git work tree, or every
 * file outside dependency and VCS directories otherwise. `excludes` are
 * harness-owned paths relative to the root.
 */
export class WorkspaceCheckpoint {
  private constructor(
    readonly root: string,
    readonly excludes: readonly string[],
    readonly entries: Map<string, Entry>,
    /** Copy of the checked files, or undefined in detect-only mode. */
    readonly store: string | undefined,
  ) {}

  static async take(root: string, excludes: readonly string[], limits: CheckpointLimits): Promise<WorkspaceCheckpoint> {
    const files = await listFiles(root, excludes, limits.maxFiles + 1)
    const entries = new Map<string, Entry>()
    let bytes = 0
    for (const rel of files) {
      const full = join(root, rel)
      const data = await readFile(full)
      bytes += data.byteLength
      entries.set(rel, { sha256: sha256(data), mode: (await lstat(full)).mode })
    }
    const detectOnly = files.length > limits.maxFiles || bytes > limits.maxBytes
    let store: string | undefined
    if (!detectOnly) {
      store = await mkdtemp(join(tmpdir(), 'dsh-rsi-checkpoint-'))
      for (const rel of files) {
        await mkdir(dirname(join(store, rel)), { recursive: true })
        await copyFile(join(root, rel), join(store, rel))
      }
    }
    return new WorkspaceCheckpoint(root, excludes, entries, store)
  }

  get restores(): boolean {
    return this.store !== undefined
  }

  /** Paths whose content differs from the checkpoint, including created and deleted files. */
  async changes(): Promise<string[]> {
    const now = new Set(await listFiles(this.root, this.excludes, Number.MAX_SAFE_INTEGER))
    const changed: string[] = []
    for (const [rel, entry] of this.entries) {
      if (!now.has(rel)) {
        changed.push(rel)
        continue
      }
      if (sha256(await readFile(join(this.root, rel))) !== entry.sha256) changed.push(rel)
    }
    for (const rel of now) if (!this.entries.has(rel)) changed.push(rel)
    return changed.sort()
  }

  /** Restores every changed path from the checkpoint; returns what changed. */
  async restore(): Promise<string[]> {
    const changed = await this.changes()
    if (!this.store) return changed
    for (const rel of changed) {
      const full = join(this.root, rel)
      const entry = this.entries.get(rel)
      if (entry === undefined) {
        await rm(full, { force: true })
        continue
      }
      await mkdir(dirname(full), { recursive: true })
      await rm(full, { force: true })
      await copyFile(join(this.store, rel), full)
      await chmod(full, entry.mode & 0o7777)
    }
    return changed
  }

  async dispose(): Promise<void> {
    if (this.store) await rm(this.store, { recursive: true, force: true })
  }
}

async function listFiles(root: string, excludes: readonly string[], cap: number): Promise<string[]> {
  const excluded = (rel: string) => excludes.some(ex => rel === ex || rel.startsWith(`${ex}/`))
  const tracked = await gitLines(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], '\0')
  if (tracked !== undefined) {
    const files: string[] = []
    for (const rel of tracked) {
      if (rel === '' || excluded(rel)) continue
      try {
        if ((await lstat(join(root, rel))).isFile()) files.push(rel)
      } catch (error) {
        // A tracked file deleted from the work tree has nothing to checkpoint.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (files.length >= cap) break
    }
    return files
  }
  const files: string[] = []
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (files.length >= cap) return
      if (IGNORED.has(entry.name)) continue
      const full = join(dir, entry.name)
      const rel = relative(root, full).split(sep).join('/')
      if (excluded(rel)) continue
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile()) files.push(rel)
    }
  }
  await visit(root)
  return files
}
