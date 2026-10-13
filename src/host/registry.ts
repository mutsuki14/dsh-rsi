import type { RoleKind, MemoryBinding } from '../engine/types.ts'
import type { MemoryStore } from '../memory/store.ts'
import type { HandoffChannel } from './channel.ts'

/** One live engine-driven role context, keyed by its reserved child session id. */
export interface RoleContext {
  role: RoleKind
  label: string
  binding: MemoryBinding
  channel: HandoffChannel
  store: MemoryStore
}

/**
 * Role contexts the plugin started. Tools consult it to scope memory access and
 * the handoff channel to the calling agent; prompt contributions consult it so
 * role children never receive the interactive Actor protocol.
 */
export class RoleRegistry {
  readonly #roles = new Map<string, RoleContext>()

  get(id: string): RoleContext | undefined {
    return this.#roles.get(id)
  }

  set(id: string, role: RoleContext): void {
    this.#roles.set(id, role)
  }

  delete(id: string): void {
    this.#roles.delete(id)
  }

  get size(): number {
    return this.#roles.size
  }
}
