import { InfraError, TransportInfraError, type RoleConversation, type RoleReply, type TransportPolicy } from './types.ts'

export type Parsed<T> = { ok: true, value: T } | { ok: false, detail: string }

/**
 * Drives one role phase in the same context until its handoff parses. Like
 * RSIAgent `_run_handoff_phase`, no fixed retry count applies: only
 * `actionlessLimit` consecutive replies that took no tool action, or the
 * emergency `ceiling`, end the context as transport infrastructure.
 */
export async function converse<T>(
  role: RoleConversation,
  first: string,
  parse: (reply: RoleReply) => Parsed<T> | Promise<Parsed<T>>,
  continuation: (detail: string) => string,
  policy: TransportPolicy,
  who: string,
  signal?: AbortSignal,
): Promise<T> {
  let reply = await role.send(first, signal)
  let actionless = 0
  for (let round = 1; ; round++) {
    const parsed = await parse(reply)
    if (parsed.ok) return parsed.value
    actionless = reply.actions === 0 ? actionless + 1 : 0
    if (actionless >= policy.actionlessLimit) {
      throw new TransportInfraError(`${who}: ${actionless} consecutive actionless segments without a usable handoff (${parsed.detail})`)
    }
    if (round >= policy.ceiling) throw new TransportInfraError(`${who}: emergency transport ceiling of ${policy.ceiling} segments reached`)
    signal?.throwIfAborted()
    reply = await role.send(continuation(parsed.detail), signal)
  }
}

export function isInfra(error: unknown): error is InfraError {
  return error instanceof InfraError
}
