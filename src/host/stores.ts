import { createHash } from 'node:crypto'
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
 * - The workspace state root holds only what roles must work in: practice and
 *   target project roots and fixture authoring roots.
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

  /** Workspace-visible state root (lineage project roots). */
  stateRoot(projectDir: string): string {
    return isAbsolute(this.config.stateDir) ? this.config.stateDir : resolve(projectDir, this.config.stateDir)
  }

  /** Harness-private memory root. */
  memoryRoot(projectDir: string): string {
    const configured = this.config.memoryDir.trim()
    if (configured) return isAbsolute(configured) ? configured : resolve(projectDir, configured)
    const key = createHash('sha256').update(resolve(projectDir)).digest('hex').slice(0, 12)
    const name = basename(resolve(projectDir)).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'root'
    return join(dshHome(), 'rsi', `${name}-${key}`)
  }

  forAgent(agent: Agent): Promise<MemoryStore> {
    return this.forRoot(this.memoryRoot(this.projectDir(agent)))
  }

  forRoot(root: string): Promise<MemoryStore> {
    let store = this.#stores.get(root)
    if (!store) {
      const created = new MemoryStore(root, this.config.memory, { keepHistory: this.config.memory.keepHistory, audit: this.#audit })
      store = created.init().then(async () => {
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
