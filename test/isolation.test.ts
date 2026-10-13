import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceCheckpoint } from '../src/host/checkpoint.ts'
import { workspaceState } from '../src/host/git.ts'
import { decideIsolation, physicalPath, privatePathGuard } from '../src/host/isolation.ts'

const limits = { maxBytes: 1024 * 1024, maxFiles: 100 }

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' })
}

let root: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-rsi-iso-')))
})

describe('WorkspaceCheckpoint', () => {
  it('restores changed files and removes only what the inspection created', async () => {
    git(root, 'init', '-q')
    await writeFile(join(root, '.gitignore'), 'secret.env\n')
    await writeFile(join(root, 'app.txt'), 'original')
    await writeFile(join(root, 'secret.env'), 'TOKEN=1')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'init')
    const checkpoint = await WorkspaceCheckpoint.take(root, [], limits)
    await writeFile(join(root, 'app.txt'), 'mutated')
    await writeFile(join(root, 'stray.tmp'), 'debris')
    // The inspection rewrote .gitignore, so the pre-existing ignored file becomes visible: it must survive.
    await writeFile(join(root, '.gitignore'), '')
    const changed = await checkpoint.restore()
    await checkpoint.dispose()
    expect(changed).toEqual(['.gitignore', 'app.txt', 'secret.env', 'stray.tmp'])
    expect(await readFile(join(root, 'app.txt'), 'utf8')).toBe('original')
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('secret.env\n')
    expect(existsSync(join(root, 'stray.tmp'))).toBe(false)
    expect(await readFile(join(root, 'secret.env'), 'utf8')).toBe('TOKEN=1')
  })

  it('reports nothing for an unchanged tree above the file cap, and reads no file contents there', async () => {
    for (let i = 0; i < 6; i++) await writeFile(join(root, `f${i}.txt`), 'x')
    const checkpoint = await WorkspaceCheckpoint.take(root, [], { maxBytes: 1024, maxFiles: 3 })
    expect(checkpoint.restores).toBe(false)
    expect(await checkpoint.changes()).toEqual([])
    await writeFile(join(root, 'f5.txt'), 'changed!')
    expect(await checkpoint.changes()).toEqual(['f5.txt'])
  })

  it('switches to detect-only above the byte cap without buffering large files', async () => {
    await writeFile(join(root, 'small.txt'), 'x')
    const { truncate } = await import('node:fs/promises')
    await writeFile(join(root, 'huge.bin'), '')
    await truncate(join(root, 'huge.bin'), 3 * 1024 * 1024 * 1024)
    const checkpoint = await WorkspaceCheckpoint.take(root, [], limits)
    expect(checkpoint.restores).toBe(false)
    expect(await checkpoint.changes()).toEqual([])
    await rm(join(root, 'huge.bin'))
  })

  it('tolerates ordinary workspace states: a tracked directory replaced by a file, unreadable files', async () => {
    git(root, 'init', '-q')
    await mkdir(join(root, 'cfg'))
    await writeFile(join(root, 'cfg', 'a.txt'), 'a')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'init')
    await rm(join(root, 'cfg'), { recursive: true })
    await writeFile(join(root, 'cfg'), 'now a file')
    await writeFile(join(root, 'locked.txt'), 'x')
    await chmod(join(root, 'locked.txt'), 0)
    const checkpoint = await WorkspaceCheckpoint.take(root, [], limits)
    expect(await checkpoint.changes()).toEqual([])
    await checkpoint.dispose()
    await chmod(join(root, 'locked.txt'), 0o644)
  })
})

describe('host-side git', () => {
  it('never runs repository-planted filter, diff, or textconv programs', async () => {
    git(root, 'init', '-q')
    await writeFile(join(root, 'a.txt'), 'hi')
    git(root, 'add', 'a.txt')
    git(root, 'commit', '-qm', 'init')
    const marker = join(root, '..', `${root.split('/').at(-1)}-ran`)
    const evil = join(root, '..', `${root.split('/').at(-1)}-evil.sh`)
    await writeFile(evil, `#!/bin/sh\necho ran >> ${marker}\ncat\n`)
    await chmod(evil, 0o755)
    for (const [key, value] of [['filter.x.clean', evil], ['filter.x.process', evil], ['diff.external', evil], ['diff.y.textconv', evil], ['diff.y.command', evil]]) {
      git(root, 'config', key!, value!)
    }
    await writeFile(join(root, '.gitattributes'), '* filter=x diff=y\n')
    await writeFile(join(root, 'a.txt'), 'changed')
    const state = await workspaceState(root)
    const checkpoint = await WorkspaceCheckpoint.take(root, [], limits)
    await checkpoint.changes()
    await checkpoint.dispose()
    expect(state.tracked).toBe(true)
    expect(state.summary).toContain('M a.txt')
    expect(existsSync(marker)).toBe(false)
    await rm(evil, { force: true })
  })
})

describe('private-path guard', () => {
  it('resolves .. physically, so a path through a symlink cannot reach a hidden root', async () => {
    const hidden = join(root, 'home', '.dsh', 'rsi', 'proj')
    await mkdir(join(hidden, 'memory'), { recursive: true })
    await writeFile(join(hidden, 'memory', 'x.md'), 'private')
    await mkdir(join(root, 'home', 'proj'), { recursive: true })
    await mkdir(join(root, 'elsewhere'), { recursive: true })
    // `link/..` is the parent of the link's TARGET (root/home), not the directory holding the link.
    await symlink(join(root, 'home', 'proj'), join(root, 'elsewhere', 'link'))
    // Spelled raw: path.join would collapse the `..` lexically, which is exactly the mistake under test.
    const sneaky = `${root}/elsewhere/link/../.dsh/rsi/proj/memory/x.md`
    expect(physicalPath(root, sneaky)).toBe(join(hidden, 'memory', 'x.md'))
    const guard = privatePathGuard([hidden], () => root)
    expect(guard({ name: 'read', arguments: { file_path: sneaky } })).toContain('private to the Actor Agent')
    expect(guard({ name: 'grep', arguments: { path: join(root, 'home') } })).toContain('private to the Actor Agent')
    expect(guard({ name: 'read', arguments: { file_path: join(root, 'home', 'proj', 'a.txt') } })).toBeUndefined()
  })
})

describe('decideIsolation', () => {
  const ctxWith = (services: Record<string, unknown>) => ({ get: (name: string) => services[name] }) as never
  const working = { confine: async (argv: readonly string[]) => ({ argv }) }
  const broken = {
    confine: async () => {
      throw Object.assign(new Error('sandbox mode "read-only" is requested but no sandbox backend is usable on this host'), { code: 'SANDBOX_UNAVAILABLE' })
    },
  }

  it('chooses sandbox only when a backend actually confines a read-only command', async () => {
    expect(await decideIsolation(ctxWith({ sandboxPolicy: {}, sandbox: working }), 'auto', true, root)).toEqual({ mode: 'sandbox' })
    const fallback = await decideIsolation(ctxWith({ sandboxPolicy: {}, sandbox: broken }), 'auto', true, root)
    expect(fallback.mode).toBe('rollback')
    expect(fallback.unavailable).toContain('no sandbox backend')
    // An explicit sandbox setting reports the problem instead of silently weakening isolation.
    expect(await decideIsolation(ctxWith({ sandboxPolicy: {}, sandbox: broken }), 'sandbox', true, root)).toMatchObject({ mode: 'sandbox', unavailable: expect.stringContaining('no sandbox backend') })
    expect(await decideIsolation(ctxWith({ sandboxPolicy: {}, sandbox: working }), 'auto', false, root)).toMatchObject({ mode: 'rollback' })
    expect(await decideIsolation(ctxWith({}), 'rollback', true, root)).toEqual({ mode: 'rollback' })
  })
})

describe('host-side git and the user configuration', () => {
  // Creating a repository owned by another uid needs root.
  it.skipIf(process.getuid?.() !== 0)('keeps system-scope settings such as safe.directory', async () => {
    git(root, 'init', '-q')
    await writeFile(join(root, 'a.txt'), 'x')
    git(root, 'add', 'a.txt')
    git(root, 'commit', '-qm', 'init')
    await writeFile(join(root, 'a.txt'), 'changed')
    const system = join(root, '..', `${root.split('/').at(-1)}-system.gitconfig`)
    await writeFile(system, '[safe]\n\tdirectory = *\n')
    execFileSync('chown', ['-R', '65534:65534', root])
    const prior = process.env.GIT_CONFIG_SYSTEM
    process.env.GIT_CONFIG_SYSTEM = system
    try {
      const state = await workspaceState(root)
      expect(state.tracked).toBe(true)
      expect(state.summary).toContain('M a.txt')
    } finally {
      if (prior === undefined) delete process.env.GIT_CONFIG_SYSTEM
      else process.env.GIT_CONFIG_SYSTEM = prior
      await rm(system, { force: true })
    }
  })
})

describe('WorkspaceCheckpoint and unreadable directories', () => {
  it.skipIf(process.getuid?.() === 0)('never deletes files of a directory it could not read when the checkpoint was taken', async () => {
    await mkdir(join(root, 'vol'))
    await writeFile(join(root, 'vol', 'data'), 'user data')
    await chmod(join(root, 'vol'), 0)
    const checkpoint = await WorkspaceCheckpoint.take(root, [], limits)
    await chmod(join(root, 'vol'), 0o755)
    const changed = await checkpoint.restore()
    await checkpoint.dispose()
    expect(changed).toContain('vol/data')
    expect(await readFile(join(root, 'vol', 'data'), 'utf8')).toBe('user data')
  })
})
