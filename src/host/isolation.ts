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

interface SandboxProbe {
  confine(argv: readonly string[], policy: { mode: 'read-only', workspaceRoot: string }, signal?: AbortSignal): Promise<{ argv: readonly string[] }>
}

/**
 * The Verifier's effect isolation on this host. `sandbox` pins the Verifier
 * child to dsh's read-only policy before its first step, which confines its file
 * tools and processes (bash, background jobs, terminals, run_code) while the
 * Actor keeps its own policy. That needs a sandbox-policy service, a reserved
 * child id (so the creation hook can recognize the child), and a sandbox
 * backend that actually confines: a profile that runs unconfined (no bwrap or
 * Landlock) would leave the Verifier unable to run any command, so its verdicts
 * would measure the host rather than the candidate.
 */
export async function decideIsolation(ctx: Context, setting: IsolationSetting, canReserveIds: boolean, cwd: string): Promise<IsolationDecision> {
  if (setting === 'rollback') return { mode: 'rollback' }
  let unavailable = !canReserveIds
    ? 'this dsh version cannot reserve sub-agent ids, so the Verifier cannot be confined at creation'
    : ctx.get('sandboxPolicy') === undefined
      ? 'this profile mounts no sandbox-policy service'
      : undefined
  if (unavailable === undefined) {
    const sandbox = (ctx as unknown as { get(name: string): unknown }).get('sandbox') as SandboxProbe | undefined
    if (sandbox === undefined) unavailable = 'this profile mounts no sandbox provider'
    else {
      try {
        await sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: cwd })
      } catch (error) {
        unavailable = `no sandbox backend can confine a read-only command on this host (${error instanceof Error ? error.message : String(error)})`
      }
    }
  }
  if (unavailable === undefined) return { mode: 'sandbox' }
  return setting === 'sandbox' ? { mode: 'sandbox', unavailable } : { mode: 'rollback', unavailable }
}

/**
 * Resolves a path the way the filesystem does: `..` after a symbolic link
 * means the parent of the link's target, so the deepest existing prefix of the
 * unnormalized spelling is resolved physically before the missing tail is
 * re-appended (which cannot contain links, since it does not exist).
 */
export function physicalPath(cwd: string, raw: string): string {
  const spelled = isAbsolute(raw) ? raw : `${cwd}${sep}${raw}`
  const segments = spelled.split(sep)
  for (let keep = segments.length; keep > 0; keep--) {
    const prefix = segments.slice(0, keep).join(sep) || sep
    try {
      const real = realpathSync.native(prefix)
      const rest = segments.slice(keep).filter(segment => segment !== '')
      return rest.length === 0 ? real : resolve(real, ...rest)
    } catch {
      // Missing or unreadable: try a shorter prefix.
    }
  }
  return resolve(spelled)
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
  str_replace_editor: 'path',
  grep: 'path',
  glob: 'path',
}

export interface GuardedExecution {
  readonly name: string
  readonly arguments: unknown
  readonly agent?: Agent
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
): (execution: GuardedExecution) => string | undefined {
  const roots = hidden.map(path => canonical(resolve(path)))
  return execution => {
    const field = PATH_ARGUMENTS[execution.name]
    if (field === undefined || roots.length === 0) return undefined
    const args = (execution.arguments ?? {}) as Record<string, unknown>
    const cwd = execution.agent ? cwdOf(execution.agent.session) : process.cwd()
    const raw = args[field]
    const target = physicalPath(cwd, typeof raw === 'string' && raw.trim() !== '' ? raw : '.')
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
 * Applies a role's sandbox pin from the serial `agent/created` hook, before
 * the child's first step: the read-only sandbox mode is an ordinary
 * `sandbox/mode` session event on the child alone. Tool guards are global and
 * keyed by role (see the plugin), so they also cover hosts where the child's
 * id is only known after creation.
 */
export function applyRoleIsolation(agent: Agent, role: RoleContext): void {
  if (role.readOnly) agent.session.append('sandbox/mode', { mode: 'read-only' })
}
