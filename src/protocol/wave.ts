/**
 * Phase-1 wave envelope (RSIAgent `parse_wave_handoff`). The JSON shape is a
 * lossless control-plane transport, not a search policy.
 */

export const PROJECT_ROOT_PLACEHOLDER = '<PROJECT_ROOT>'

const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

export interface WaveProject {
  id: string
  instruction: string
}

export type WaveDecision =
  | { decision: 'WAVE', rationale: string, projects: WaveProject[] }
  | { decision: 'SATURATED' | 'STALLED', rationale: string, projects: [] }

/** Extracts the last JSON object from free text (a fenced ```json block or a bare object). */
export function extractJsonObject(text: string): string | undefined {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/g)]
  if (fenced.length > 0) return fenced[fenced.length - 1]![1]!.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  return text.slice(start, end + 1)
}

/** Returns `undefined` for any malformed envelope; callers ask the same context to republish. */
export function parseWave(text: string): WaveDecision | undefined {
  const raw = extractJsonObject(text)
  if (raw === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    // Malformed JSON is a transport failure the caller reports back to the Curriculum.
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const { decision, rationale, projects } = value as Record<string, unknown>
  if (typeof rationale !== 'string' || rationale.trim() === '' || !Array.isArray(projects)) return undefined
  if (decision === 'SATURATED' || decision === 'STALLED') {
    if (projects.length > 0) return undefined
    return { decision, rationale: rationale.trim(), projects: [] }
  }
  if (decision !== 'WAVE' || projects.length === 0) return undefined
  const seen = new Set<string>()
  const parsed: WaveProject[] = []
  for (const record of projects) {
    if (typeof record !== 'object' || record === null) return undefined
    const { id, instruction } = record as Record<string, unknown>
    if (typeof id !== 'string' || !PROJECT_ID.test(id) || seen.has(id)) return undefined
    if (typeof instruction !== 'string' || !instruction.includes(PROJECT_ROOT_PLACEHOLDER)) return undefined
    seen.add(id)
    parsed.push({ id, instruction: instruction.trim() })
  }
  return { decision: 'WAVE', rationale: rationale.trim(), projects: parsed }
}
