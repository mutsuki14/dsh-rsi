import { isAbsolute, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Config } from '../config.ts'
import { LeakageAudit } from '../memory/audit.ts'
import { MemoryStore } from '../memory/store.ts'

/**
 * One durable memory store per project. A session's project is its original
 * working directory (`header.cwd`), so memory follows the environment the
 * Actor learned, not a transient `cd`.
 */
export class StoreRegistry {
  readonly #stores = new Map<string, Promise<MemoryStore>>()
  readonly #inventories = new Map<string, Array<{ path: string, bytes: number }>>()
  readonly #audit: LeakageAudit

  constructor(readonly config: Config) {
    this.#audit = new LeakageAudit(config.audit.sealedTexts, config.audit.shingleWords)
  }

  stateRoot(projectDir: string): string {
    return isAbsolute(this.config.stateDir) ? this.config.stateDir : resolve(projectDir, this.config.stateDir)
  }

  projectDir(agent: Agent): string {
    return agent.session.header.cwd ?? process.cwd()
  }

  forAgent(agent: Agent): Promise<MemoryStore> {
    return this.forRoot(this.stateRoot(this.projectDir(agent)))
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
