/**
 * Transport-only token parsers.
 *
 * Role outputs stay free-form; the harness recognizes one lexical token and
 * never reinterprets the rest of the text. Tokens inside Markdown fences or
 * indented code blocks are examples, not decisions. Repeating the same token is
 * idempotent; conflicting tokens make the output invalid (RSIAgent
 * `_parse_unique_handoff` / `_parse_agentic_verifier_report`).
 */

export type Verdict = 'PASS' | 'FAIL' | 'UNVERIFIED'

export interface UniqueTokenOptions {
  /** Regular expression matched against a whole trimmed line; group 1 is the token value. */
  pattern: RegExp
}

/** Lines that are neither inside a fenced block nor indented as code. */
function prose(text: string): string[] {
  const out: string[] = []
  let fence: string | undefined
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim()
    if (stripped.startsWith('```') || stripped.startsWith('~~~')) {
      const marker = stripped.slice(0, 3)
      if (fence === undefined) fence = marker
      else if (marker === fence) fence = undefined
      continue
    }
    if (fence !== undefined || line.startsWith('\t') || line.startsWith('    ')) continue
    out.push(stripped)
  }
  return out
}

/**
 * Returns the single standalone token value, or `undefined` when the text has
 * none or carries conflicting values.
 */
export function parseUniqueToken(text: string, { pattern }: UniqueTokenOptions): string | undefined {
  const anchored = new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace('g', ''))
  const values = new Set<string>()
  for (const line of prose(text)) {
    const match = anchored.exec(line)
    if (match?.[1] !== undefined) values.add(match[1].toUpperCase())
  }
  if (values.size !== 1) return undefined
  return [...values][0]
}

const VERDICT_TOKEN = /VERDICT:\s*(PASS|FAIL|UNVERIFIED)/i

/** Parses a Verifier report. `UNVERIFIED` is accepted only when the protocol allows it. */
export function parseVerdict(report: string, allowUnverified: boolean): Verdict | undefined {
  const value = parseUniqueToken(report, { pattern: VERDICT_TOKEN })
  if (value === 'UNVERIFIED' && !allowUnverified) return undefined
  return value as Verdict | undefined
}

export interface ParsedDecision<D extends string> {
  decision: D
  /** Everything after the decision line, verbatim apart from outer whitespace. */
  body: string
}

/**
 * Parses a first-non-empty-line `DECISION: <TOKEN>` handoff (Curriculum
 * `project_next.md`). Only the listed tokens are valid.
 */
export function parseDecision<D extends string>(text: string, allowed: readonly D[]): ParsedDecision<D> | undefined {
  const lines = text.split(/\r?\n/)
  const first = lines.findIndex(line => line.trim() !== '')
  if (first < 0) return undefined
  const match = /^DECISION:\s*([A-Z_]+)$/.exec(lines[first]!.trim())
  if (!match) return undefined
  const token = match[1] as D
  if (!allowed.includes(token)) return undefined
  return { decision: token, body: lines.slice(first + 1).join('\n').trim() }
}
