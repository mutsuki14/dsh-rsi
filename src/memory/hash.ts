import { createHash } from 'node:crypto'

/** Per-file digests keyed by POSIX relative path. */
export type TreeHashes = Record<string, string>

const SHA256 = /^[0-9a-f]{64}$/

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Canonical JSON: sorted keys, no insignificant whitespace (matches Python `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Root digest of a memory tree (RSIAgent `tree_sha256`): SHA-256 of the
 * canonical JSON `{relpath: sha256(file)}` mapping. An empty tree has a
 * well-defined digest too.
 */
export function treeSha256(hashes: TreeHashes): string {
  for (const [rel, digest] of Object.entries(hashes)) {
    if (rel === '' || rel.startsWith('/') || rel.split('/').includes('..') || !SHA256.test(digest)) {
      throw new Error(`invalid tree-hash entry: ${rel}`)
    }
  }
  return sha256(canonicalJson(hashes))
}
