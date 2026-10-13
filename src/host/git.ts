import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { sha256 } from '../memory/hash.ts'

const run = promisify(execFile)

/**
 * Harness-side git never runs repository-configured code. The Actor (or a
 * Verifier in rollback mode) can write `.git/config` and `.gitattributes`, so
 * every invocation disables fsmonitor and hooks and neutralizes every filter
 * and diff driver the repository defines. System and global configuration
 * belong to the user and the administrator (a sandboxed role cannot write
 * them), so their settings — line endings, LFS, safe.directory — still apply.
 */
const SAFE = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.untrackedCache=false',
  '-c', 'diff.external=',
]

/** Read per call, so a changed environment (e.g. GIT_CONFIG_SYSTEM) takes effect. */
const env = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EXTERNAL_DIFF: '', GIT_OPTIONAL_LOCKS: '0' })

/** Configuration scopes a role can never write. */
const TRUSTED_SCOPES = new Set(['global', 'system'])

async function raw(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', args, { cwd, env: env(), timeout: 15_000, maxBuffer: 32 * 1024 * 1024 })
    return stdout
  } catch {
    // Not a repository, git missing, or a timeout: the caller treats capture as unavailable.
    return undefined
  }
}

const DRIVER_KEY = /^(filter|diff)\.(.+)\.(clean|smudge|process|required|command|textconv|cachetextconv)$/i

/**
 * `-c` overrides that disable every filter and diff driver defined outside the
 * user's global and system configuration. `undefined` when the configuration
 * cannot be read: then git is not run at all (fail closed).
 */
async function driverOverrides(cwd: string): Promise<string[] | undefined> {
  // `--show-scope` (git >= 2.26) separates repository-planted drivers from the user's and administrator's.
  let listing = await raw(cwd, [...SAFE, 'config', '--show-scope', '--name-only', '--get-regexp', '^(filter|diff)\\.'])
  let scoped = true
  if (listing === undefined) {
    // Exit status 1 also means "no matching keys"; distinguish it from an unreadable configuration.
    const probe = await raw(cwd, [...SAFE, 'config', '--name-only', '--get-regexp', '^(filter|diff)\\.'])
    if (probe === undefined) {
      const readable = await raw(cwd, [...SAFE, 'rev-parse', '--git-dir'])
      return readable === undefined ? undefined : []
    }
    listing = probe
    scoped = false
  }
  const overrides: string[] = []
  const seen = new Set<string>()
  for (const line of listing.split('\n')) {
    if (line.trim() === '') continue
    const [scope, key] = scoped ? line.split('\t') as [string, string | undefined] : ['unknown', line]
    if (key === undefined || TRUSTED_SCOPES.has(scope)) continue
    const match = DRIVER_KEY.exec(key.trim())
    if (!match) continue
    const id = `${match[1]!.toLowerCase()}.${match[2]}`
    if (seen.has(id)) continue
    seen.add(id)
    if (match[1]!.toLowerCase() === 'filter') {
      overrides.push('-c', `${id}.clean=`, '-c', `${id}.smudge=`, '-c', `${id}.process=`, '-c', `${id}.required=false`)
    } else {
      overrides.push('-c', `${id}.command=`, '-c', `${id}.textconv=`)
    }
  }
  return overrides
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  const overrides = await driverOverrides(cwd)
  if (overrides === undefined) return undefined
  return raw(cwd, [...SAFE, ...overrides, ...args])
}

export async function gitLines(cwd: string, args: string[], separator = '\n'): Promise<string[] | undefined> {
  const out = await git(cwd, args)
  return out === undefined ? undefined : out.split(separator).filter(line => line !== '')
}

export interface WorkspaceState {
  /** Whether change capture works in this directory. */
  tracked: boolean
  /** Mechanical description of uncommitted changes. */
  summary: string
  /** Digest of the status and diff. */
  digest: string
}

/**
 * Harness-captured change facts for an interactive candidate: git status and
 * diff stat, never a grade. `exclude` paths (harness state) are left out of
 * the candidate. Submodules are not entered, and no external diff or textconv
 * program runs.
 */
export async function workspaceState(cwd: string, exclude: readonly string[] = []): Promise<WorkspaceState> {
  const pathspec = ['--', '.', ...exclude.map(path => `:(exclude)${path}`)]
  const status = await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all', ...pathspec])
  if (status === undefined) {
    return { tracked: false, summary: `Candidate root: ${cwd}\nNo usable git repository: file-change capture is unavailable; inspect the live state directly.`, digest: '' }
  }
  const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all']
  const stat = (await git(cwd, [...diffArgs, '--stat', 'HEAD', ...pathspec])) ?? ''
  const diff = (await git(cwd, [...diffArgs, 'HEAD', ...pathspec])) ?? ''
  const lines = status.split('\n').filter(Boolean)
  const shown = lines.slice(0, 200).map(line => `  ${line}`).join('\n')
  const more = lines.length > 200 ? `\n  … ${lines.length - 200} more` : ''
  const summary = lines.length === 0
    ? `Candidate root: ${cwd}\nThe working tree has no uncommitted changes.`
    : `Candidate root: ${cwd}\nUNCOMMITTED CHANGES (git status --porcelain, ${lines.length}):\n${shown}${more}\n\nDIFF STAT:\n${stat.trim()}`
  return { tracked: true, summary, digest: sha256(`${status}\n${diff}`) }
}
