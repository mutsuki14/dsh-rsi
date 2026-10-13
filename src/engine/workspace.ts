import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readdir, readFile, readlink } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { sha256 } from '../memory/hash.ts'
import { diffManifests, type Manifest } from '../memory/store.ts'

const IGNORED = new Set(['.git', 'node_modules', '.venv', '__pycache__'])

/** Content manifest of a project tree, used for mechanical context and candidate integrity checks. */
export async function projectManifest(root: string, maxFiles = 5000): Promise<Manifest> {
  const manifest: Manifest = {}
  let count = 0
  const visit = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile()) {
        if (++count > maxFiles) return
        const data = await readFile(full)
        manifest[relative(root, full).split(sep).join('/')] = { bytes: data.byteLength, sha256: sha256(data) }
      } else if (entry.isSymbolicLink()) {
        const info = await lstat(full)
        manifest[`${relative(root, full).split(sep).join('/')} -> (symlink)`] = { bytes: info.size, sha256: sha256(full) }
      }
    }
  }
  await visit(root)
  return manifest
}

/**
 * Digest of everything under `root` — every file, link, and directory, with
 * modes, including `.git`, dependency trees, and caches — so a Verifier effect
 * anywhere in the candidate is detected. No ignore list and no cap: this is the
 * integrity check, not the Verifier's summary.
 */
export async function treeFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256')
  const visit = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const full = join(dir, entry.name)
      const rel = relative(root, full).split(sep).join('/')
      const info = await lstat(full)
      if (entry.isSymbolicLink()) hash.update(`L\0${rel}\0${await readlink(full)}\0`)
      else if (entry.isDirectory()) {
        hash.update(`D\0${rel}\0${info.mode}\0`)
        await visit(full)
      } else if (entry.isFile()) {
        hash.update(`F\0${rel}\0${info.mode}\0${info.size}\0`)
        hash.update(await readFile(full))
        hash.update('\0')
      } else hash.update(`O\0${rel}\0${info.mode}\0`)
    }
  }
  await visit(root)
  return hash.digest('hex')
}

/** Harness-captured facts about candidate changes (RSIAgent `_surface_delta`). Not a grade. */
export function describeDelta(root: string, before: Manifest, after: Manifest): string {
  const delta = diffManifests(before, after)
  const lines = [`Candidate root: ${root}`]
  const section = (title: string, paths: string[]) => {
    if (paths.length === 0) return
    lines.push(`${title} (${paths.length}):`)
    for (const path of paths.slice(0, 200)) lines.push(`  ${path}  ${after[path]?.bytes ?? before[path]?.bytes ?? 0}B`)
    if (paths.length > 200) lines.push(`  … ${paths.length - 200} more`)
  }
  section('CREATED', delta.created)
  section('MODIFIED', delta.modified)
  section('DELETED', delta.deleted)
  if (delta.created.length + delta.modified.length + delta.deleted.length === 0) lines.push('No file changes were captured.')
  return lines.join('\n')
}

/** A complete copy (links verbatim, timestamps kept) that can restore the candidate exactly. */
export async function discardableCopy(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true })
  await cp(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
}
