/**
 * Optional leakage tripwire (RSIAgent `silent_audit`): memory must not carry
 * verbatim fragments of material the deployment marks as sealed, such as
 * held-out evaluation tasks. Word shingles of `shingleWords` length are
 * compared; any overlap quarantines the whole candidate commit.
 */

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

function shingles(text: string, size: number): Set<string> {
  const tokens = words(text)
  const out = new Set<string>()
  for (let i = 0; i + size <= tokens.length; i++) out.add(tokens.slice(i, i + size).join(' '))
  return out
}

export class LeakageAudit {
  readonly #corpus: Set<string>

  constructor(sealedTexts: readonly string[], readonly shingleWords: number) {
    this.#corpus = new Set()
    for (const text of sealedTexts) for (const shingle of shingles(text, shingleWords)) this.#corpus.add(shingle)
  }

  get enabled(): boolean {
    return this.#corpus.size > 0
  }

  /** Paths whose content overlaps the sealed corpus. */
  flagged(files: ReadonlyMap<string, string>): string[] {
    if (!this.enabled) return []
    const hits: string[] = []
    for (const [path, content] of files) {
      for (const shingle of shingles(content, this.shingleWords)) {
        if (this.#corpus.has(shingle)) {
          hits.push(path)
          break
        }
      }
    }
    return hits
  }
}
