import { posix } from 'node:path'

/**
 * Normalizes a model-supplied memory path to a safe POSIX relative path, or
 * throws. Memory never escapes its root: no absolute paths, parent segments,
 * drive letters, NUL bytes, or empty segments.
 */
export function safeRelativePath(input: string): string {
  const raw = input.trim().replace(/\\/g, '/')
  if (raw === '' || raw.includes('\0')) throw new Error('memory path must be a non-empty relative path')
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new Error(`memory path must be relative: ${input}`)
  const segments = raw.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.length === 0) throw new Error('memory path must name a file')
  if (segments.includes('..')) throw new Error(`memory path must not contain "..": ${input}`)
  const normalized = posix.join(...segments)
  if (normalized.length > 240) throw new Error('memory path is too long (max 240 characters)')
  return normalized
}
