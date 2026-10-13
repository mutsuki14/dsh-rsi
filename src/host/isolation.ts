import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type { RoleContext } from './registry.ts'

export type IsolationSetting = 'auto' | 'sandbox' | 'rollback'
export type IsolationMode = 'sandbox' | 'rollback'

export interface IsolationDecision {
  mode: IsolationMode
  /** Why `sandbox` is unavailable, when it is. */
  unavailable?: string
}

/**
 * The Verifier's effect isolation on this host. `sandbox` pins the Verifier
 * child to dsh's read-only policy before its first step, which confines its file
 * tools and processes (bash, background jobs, terminals, run_code) while the
 * Actor keeps its own policy. That needs a sandbox-policy service and a reserved
 * child id (so the creation hook can recognize the child).
 */
export function decideIsolation(ctx: Context, setting: IsolationSetting, canReserveIds: boolean): IsolationDecision {
  const unavailable = !canReserveIds
    ? 'this dsh version cannot reserve sub-agent ids, so the Verifier cannot be confined at creation'
    : ctx.get('sandboxPolicy') === undefined
      ? 'this profile mounts no sandbox-policy service'
      : undefined
  if (setting === 'rollback') return { mode: 'rollback' }
  if (unavailable === undefined) return { mode: 'sandbox' }
  return setting === 'sandbox' ? { mode: 'sandbox', unavailable } : { mode: 'rollback', unavailable }
}

/** Resolves the deepest existing ancestor with symlinks expanded, then re-appends the missing tail. */
function canonical(path: string): string {
  let existing = path
  const tail: string[] = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break
    tail.unshift(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
    existing = parent
  }
  let real = existing
  try {
    real = realpathSync.native(existing)
  } catch {
    // An unreadable ancestor keeps its lexical form; the containment check still applies.
  }
  return tail.length === 0 ? real : resolve(real, ...tail)
}

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const PATH_ARGUMENTS: Record<string, 'file_path' | 'path'> = {
  read: 'file_path',
  read_image: 'file_path',
  write: 'file_path',
  edit: 'file_path',
  grep: 'path',
  glob: 'path',
}

/**
 * A synchronous guard for one role's file tools: no read, search, or write may
 * target an Actor-private path, and no search may start above one. Process
 * reads are outside this guard; private state therefore lives outside the
 * workspace, and its location is never disclosed to the Verifier.
 */
export function privatePathGuard(
  hidden: readonly string[],
  cwdOf: (session: Session) => string,
): (execution: { readonly name: string, readonly arguments: unknown, readonly agent?: Agent }) => string | undefined {
  const roots = hidden.map(path => canonical(resolve(path)))
  return execution => {
    const field = PATH_ARGUMENTS[execution.name]
    if (field === undefined || roots.length === 0) return undefined
    const args = (execution.arguments ?? {}) as Record<string, unknown>
    const cwd = execution.agent ? cwdOf(execution.agent.session) : process.cwd()
    const raw = args[field]
    const target = canonical(resolve(cwd, typeof raw === 'string' && raw.trim() !== '' ? raw : '.'))
    const searches = execution.name === 'grep' || execution.name === 'glob'
    for (const root of roots) {
      if (within(target, root) || (searches && within(root, target))) {
        return 'That path holds state private to the Actor Agent or the harness; it is outside what this role may inspect.'
      }
    }
    return undefined
  }
}

/**
 * Applies a role's isolation from the serial `agent/created` hook, before the
 * child's first step: the read-only sandbox mode is an ordinary `sandbox/mode`
 * session event on the child alone, and the guard is scoped to the child's context.
 */
export function applyRoleIsolation(agent: Agent, role: RoleContext, cwdOf: (session: Session) => string): void {
  if (role.readOnly) agent.session.append('sandbox/mode', { mode: 'read-only' })
  if (role.hidden.length > 0) agent.ctx.tools.guard(privatePathGuard(role.hidden, cwdOf))
}
