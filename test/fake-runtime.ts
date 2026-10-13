import type { MemoryStore } from '../src/memory/store.ts'
import type { OpenRoleOptions, RoleConversation, RoleReply, RoleRuntime } from '../src/engine/types.ts'

export type ScriptReply = string | RoleReply
export type Script = (message: string, options: OpenRoleOptions, turn: number) => Promise<ScriptReply> | ScriptReply

/** Scripted role contexts: each `open` gets its own turn counter, like a fresh dsh sub-agent. */
export class FakeRuntime implements RoleRuntime {
  readonly opened: OpenRoleOptions[] = []
  readonly transcript: Array<{ label: string, message: string, reply: string }> = []
  closed = 0

  constructor(readonly scripts: Record<OpenRoleOptions['role'], Script>) {}

  async open(options: OpenRoleOptions): Promise<RoleConversation> {
    this.opened.push(options)
    let turn = 0
    return {
      send: async message => {
        const raw = await this.scripts[options.role](message, options, turn++)
        // A scripted reply counts as one tool action unless it says otherwise.
        const reply = typeof raw === 'string' ? { text: raw, actions: 1 } : raw
        this.transcript.push({ label: options.label, message, reply: reply.text })
        return reply
      },
      close: async () => {
        this.closed++
      },
    }
  }
}

/** Simulates the Actor calling rsi_memory_write during its learning phase. */
export async function writeMemory(store: MemoryStore, options: OpenRoleOptions, path: string, content: string): Promise<void> {
  if (options.memory.access !== 'draft' || !options.memory.draft) throw new Error('memory is not writable outside a learning phase')
  await store.writeDraft(options.memory.draft, path, content)
}
