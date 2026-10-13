import { chmod, cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { sha256 } from '../memory/hash.ts'
import type { Manifest } from '../memory/store.ts'

/** A byte-for-byte capture of a fixture or candidate tree (RSIAgent fixture tar + sha256 manifest). */
export interface TreeCapture {
  /** Directory holding the captured copy. */
  tree: string
  files: Manifest
  dirs: string[]
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

/**
 * RSIAgent's shape gate (target_learning.py:129-138): an existing,
 * non-symlink directory with at least one regular file and no links or
 * special files. Returns a transport detail, or undefined when the tree is valid.
 */
export async function shapeGate(root: string): Promise<string | undefined> {
  let info
  try {
    info = await lstat(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `${root} does not exist`
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return `${root} is not a plain directory`
  let regular = 0
  const visit = async (dir: string): Promise<string | undefined> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) return `${relative(root, full)} is a symbolic link`
      if (entry.isDirectory()) {
        const nested = await visit(full)
        if (nested) return nested
      } else if (entry.isFile()) regular++
      else return `${relative(root, full)} is not a regular file or directory`
    }
    return undefined
  }
  const problem = await visit(root)
  if (problem) return problem
  return regular === 0 ? `${root} contains no regular file` : undefined
}

async function scan(root: string): Promise<{ files: Manifest, dirs: string[] }> {
  const files: Manifest = {}
  const dirs: string[] = []
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const rel = relative(root, full).split(sep).join('/')
      if (entry.isDirectory()) {
        dirs.push(rel)
        await visit(full)
      } else if (entry.isFile()) {
        const data = await readFile(full)
        files[rel] = { bytes: data.byteLength, sha256: sha256(data) }
      } else {
        files[`${rel} (non-regular)`] = { bytes: 0, sha256: sha256(rel) }
      }
    }
  }
  await visit(root)
  return { files, dirs: dirs.sort() }
}

/** Captures `root` into `dest` and records its manifest; the source must pass the shape gate first. */
export async function captureTree(root: string, dest: string): Promise<TreeCapture> {
  const tree = join(dest, 'tree')
  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })
  await cp(root, tree, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
  const { files, dirs } = await scan(tree)
  const capture: TreeCapture = { tree, files, dirs }
  await writeFile(join(dest, 'manifest.json'), `${JSON.stringify({ files, dirs }, null, 2)}\n`)
  return capture
}

/** Whether `path` holds exactly the captured file set, contents, and directories. */
export async function verifyTree(path: string, capture: TreeCapture): Promise<boolean> {
  if (!(await exists(path))) return false
  const { files, dirs } = await scan(path)
  return JSON.stringify(files) === JSON.stringify(capture.files) && JSON.stringify(dirs) === JSON.stringify(capture.dirs)
}

/** Replays a capture byte-for-byte at `root`, replacing whatever was there. */
export async function replayTree(capture: TreeCapture, root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
  await cp(capture.tree, root, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
  if (!(await verifyTree(root, capture))) throw new Error(`replayed tree at ${root} does not match its capture`)
}

async function setWritable(path: string, writable: boolean): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) return
  if (info.isDirectory()) {
    if (writable) await chmod(path, info.mode | 0o200)
    for (const entry of await readdir(path)) await setWritable(join(path, entry), writable)
    if (!writable) await chmod(path, info.mode & ~0o222)
  } else {
    await chmod(path, writable ? info.mode | 0o200 : info.mode & ~0o222)
  }
}

/** A read-only comparison view of a capture (RSIAgent `chmod -R a-w` original-fixture view). */
export async function stageReadOnlyView(capture: TreeCapture, view: string): Promise<void> {
  await removeView(view)
  await cp(capture.tree, view, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
  await setWritable(view, false)
}

export async function removeView(view: string): Promise<void> {
  if (!(await exists(view))) return
  await setWritable(view, true)
  await rm(view, { recursive: true, force: true })
}

/** Moves a failed attempt aside instead of deleting it (RSIAgent keeps infra attempts for recovery). */
export async function moveAside(dir: string, into: string): Promise<string | undefined> {
  if (!(await exists(dir))) return undefined
  await mkdir(into, { recursive: true })
  const taken = new Set(await readdir(into))
  let index = 1
  while (taken.has(`attempt_${String(index).padStart(3, '0')}`)) index++
  const target = join(into, `attempt_${String(index).padStart(3, '0')}`)
  await rename(dir, target)
  return target
}
