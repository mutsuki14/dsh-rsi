import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Config } from '../config.ts'
import { LeakageAudit } from '../memory/audit.ts'
import { MemoryStore } from '../memory/store.ts'

/** dsh's home directory: `$DSH_HOME`, else `~/.dsh` (dsh-home-paths precedence). */
export function dshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  return configured ? resolve(configured) : join(homedir(), '.dsh')
}

/**
 * Durable memory and lineage state per project. A session's project is its
 * original working directory (`header.cwd`), so memory follows the environment
 * the Actor learned, not a transient `cd`.
 *
 * - The memory root (canonical memory, drafts, journal, reports, lineage
 *   records) lives outside the project by default, like RSIAgent's host-side
 *   memory, so candidates, diffs, and Verifier file tools never contain it.
 * - The work root holds only what roles must work in: practice and target
 *   project roots and fixture authoring roots. It stays inside the project,
 *   the only place dsh's default workspace-write sandbox lets role agents
 *   write, but is its own git boundary and ignores itself, so role commands
 *   such as `git` never act on the user's repository.
 */
export class StoreRegistry {
  readonly #stores = new Map<string, Promise<MemoryStore>>()
  readonly #inventories = new Map<string, Array<{ path: string, bytes: number }>>()
  readonly #audit: LeakageAudit

  constructor(readonly config: Config) {
    this.#audit = new LeakageAudit(config.audit.sealedTexts, config.audit.shingleWords)
  }

  projectDir(agent: Agent): string {
    return agent.session.header.cwd ?? process.cwd()
  }

  /** Role-visible work root (lineage project roots). */
  stateRoot(projectDir: string): string {
    const configured = this.config.stateDir.trim()
    if (configured) return isAbsolute(configured) ? configured : resolve(projectDir, configured)
    return resolve(projectDir, '.dsh-rsi', 'work')
  }

  /** Harness-private memory root. */
  memoryRoot(projectDir: string): string {
    const configured = this.config.memoryDir.trim()
    if (configured) return isAbsolute(configured) ? configured : resolve(projectDir, configured)
    return join(dshHome(), 'rsi', projectKey(projectDir))
  }

  forAgent(agent: Agent): Promise<MemoryStore> {
    const projectDir = this.projectDir(agent)
    const root = this.memoryRoot(projectDir)
    return this.forRoot(root, this.config.memoryDir.trim() === '' ? () => migrateLegacyMemory(resolve(projectDir, '.dsh-rsi'), root) : undefined)
  }

  /** Opens a store; `prepare` runs inside its cross-process lock, before recovery. */
  forRoot(root: string, prepare?: () => Promise<void>): Promise<MemoryStore> {
    let store = this.#stores.get(root)
    if (!store) {
      const created = new MemoryStore(root, this.config.memory, {
        keepHistory: this.config.memory.keepHistory,
        audit: this.#audit,
        frozen: this.config.mode === 'frozen',
      })
      store = created.init(prepare).then(async () => {
        await this.refresh(created)
        return created
      })
      store.catch(() => this.#stores.delete(root))
      this.#stores.set(root, store)
    }
    return store
  }

  /** Re-reads the inventory that the synchronous prompt context serves. */
  async refresh(store: MemoryStore): Promise<void> {
    this.#inventories.set(store.root, await store.inventory())
  }

  /** Cached inventory for prompt assembly, or `undefined` before the store was opened. */
  inventory(root: string): Array<{ path: string, bytes: number }> | undefined {
    return this.#inventories.get(root)
  }
}

/** `<basename>-<sha12>` of a project directory: readable and collision-free. */
export function projectKey(projectDir: string): string {
  const key = createHash('sha256').update(resolve(projectDir)).digest('hex').slice(0, 12)
  const name = basename(resolve(projectDir)).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'root'
  return `${name}-${key}`
}

const LEGACY_ENTRIES = ['memory', 'journal.jsonl', 'history', 'frozen.json', 'reports']

/**
 * Makes a work root inside the user's project inert for git: it ignores
 * itself (so the user's status stays clean) and is its own repository (so a
 * role's git command never discovers the user's). Host-side, no hooks run.
 */
export async function prepareWorkRoot(workRoot: string): Promise<void> {
  await mkdir(workRoot, { recursive: true })
  const parent = resolve(workRoot, '..')
  if (basename(parent) === '.dsh-rsi') await writeFile(join(parent, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => undefined)
  await writeFile(join(workRoot, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => undefined)
  if (!(await exists(join(workRoot, '.git')))) {
    await new Promise<void>(done => {
      execFile('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', workRoot], { timeout: 15_000 }, () => done())
    })
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false)
}

/**
 * dsh-rsi 0.1 kept memory inside the workspace (`<project>/.dsh-rsi`). Moves it
 * to the private root once, when that root holds no memory yet, so an upgrade
 * neither starts from empty memory nor leaves the old copy where a Verifier
 * could read it.
 */
export async function migrateLegacyMemory(legacy: string, root: string): Promise<void> {
  if (!(await exists(join(legacy, 'journal.jsonl'))) && !(await exists(join(legacy, 'memory')))) return
  if (await exists(join(root, 'journal.jsonl'))) return
  if ((await exists(join(root, 'memory'))) && (await readdir(join(root, 'memory'))).length > 0) return
  await mkdir(root, { recursive: true })
  for (const entry of LEGACY_ENTRIES) {
    const from = join(legacy, entry)
    if (!(await exists(from))) continue
    const to = join(root, entry)
    await rm(to, { recursive: true, force: true })
    try {
      await rename(from, to)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      // Different filesystems: copy, then remove the workspace copy.
      await cp(from, to, { recursive: true, verbatimSymlinks: true })
      await rm(from, { recursive: true, force: true })
    }
  }
  await rm(join(legacy, 'drafts'), { recursive: true, force: true })
  await writeFile(join(legacy, 'MOVED.txt'), `dsh-rsi memory moved to ${root}\n`, 'utf8')
}
