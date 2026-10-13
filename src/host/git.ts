import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { sha256 } from '../memory/hash.ts'

const run = promisify(execFile)

/**
 * Harness-side git never runs repository-configured code: a candidate (or a
 * Verifier in rollback mode) could have planted an fsmonitor or hooks.
 */
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false']

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', [...SAFE, ...args], { cwd, timeout: 15_000, maxBuffer: 32 * 1024 * 1024 })
    return stdout
  } catch {
    // Not a repository, git missing, or a timeout: change capture is unavailable, which the caller states.
    return undefined
  }
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
 * diff stat, never a grade. `exclude` paths (the RSI state directory) are
 * harness-owned and left out of the candidate.
 */
export async function workspaceState(cwd: string, exclude: readonly string[] = []): Promise<WorkspaceState> {
  const pathspec = ['--', '.', ...exclude.map(path => `:(exclude)${path}`)]
  const status = await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all', ...pathspec])
  if (status === undefined) {
    return { tracked: false, summary: `Candidate root: ${cwd}\nNo git repository: file-change capture is unavailable; inspect the live state directly.`, digest: '' }
  }
  const stat = (await git(cwd, ['diff', '--stat', 'HEAD', ...pathspec])) ?? ''
  const diff = (await git(cwd, ['diff', 'HEAD', ...pathspec])) ?? ''
  const lines = status.split('\n').filter(Boolean)
  const shown = lines.slice(0, 200).map(line => `  ${line}`).join('\n')
  const more = lines.length > 200 ? `\n  … ${lines.length - 200} more` : ''
  const summary = lines.length === 0
    ? `Candidate root: ${cwd}\nThe working tree has no uncommitted changes.`
    : `Candidate root: ${cwd}\nUNCOMMITTED CHANGES (git status --porcelain, ${lines.length}):\n${shown}${more}\n\nDIFF STAT:\n${stat.trim()}`
  return { tracked: true, summary, digest: sha256(`${status}\n${diff}`) }
}
