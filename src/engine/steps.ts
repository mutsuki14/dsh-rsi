import { MemoryLimitError, type CommitRecord, type EpisodeKind, type MemoryStore, type TerminalOutcome } from '../memory/store.ts'
import { parseUniqueToken, parseVerdict } from '../protocol/tokens.ts'
import { distillationMessage, learningDiagnosisMessage, reconciliationMessage, transportContinuation } from '../roles/actor.ts'
import { verifierCharter, verifierTransportContinuation, type VerifierCharterInput } from '../roles/verifier.ts'
import { converse } from './converse.ts'
import { InfraError, type MemoryBinding, type RoleConversation, type TransportPolicy, type VerificationResult } from './types.ts'

const STATUS_SUBMIT = /STATUS:\s*(SUBMIT)/

/** First non-empty line must be `STATUS: SUBMIT` (RSIAgent `_run_handoff_phase`). */
export function parseSubmitHandoff(text: string): string | undefined {
  const lines = text.split(/\r?\n/)
  const first = lines.findIndex(line => line.trim() !== '')
  if (first < 0 || !/^STATUS:\s*SUBMIT$/.test(lines[first]!.trim())) {
    // Accept a single unambiguous standalone token anywhere in prose as a lenient fallback.
    return parseUniqueToken(text, { pattern: STATUS_SUBMIT }) === 'SUBMIT' ? text.trim() : undefined
  }
  return lines.slice(first + 1).join('\n').trim()
}

export interface Lead {
  claim: string
  probe: string
}

/**
 * Extracts CLAIM/PROBE pairs. A probe is the rest of its PROBE: line, or — when
 * that is empty — the fenced code block right after it. Every other line
 * (narrative before, between, or after the pairs) is dropped, so only the
 * pairs reach the Verifier.
 */
export function parseLeads(handoff: string): Lead[] {
  const leads: Lead[] = []
  const lines = handoff.split(/\r?\n/)
  let claim: string | undefined
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const claimMatch = /^\s*CLAIM:\s*(.*)$/.exec(line)
    if (claimMatch) {
      claim = claimMatch[1]!.trim()
      continue
    }
    const probeMatch = /^\s*PROBE:\s*(.*)$/.exec(line)
    if (!probeMatch || claim === undefined) continue
    let probe = probeMatch[1]!.trim()
    if (probe === '' || /^(`{3,}|~{3,})/.test(probe)) {
      // A multi-line probe: the fenced block opening on this line or the next non-empty one.
      let open = probe === '' ? index + 1 : index
      while (probe === '' && open < lines.length && lines[open]!.trim() === '') open++
      const fence = /^\s*(`{3,}|~{3,})/.exec(probe === '' ? lines[open] ?? '' : probe)
      if (!fence) continue
      const body: string[] = []
      let end = open + 1
      while (end < lines.length && !lines[end]!.trim().startsWith(fence[1]!)) body.push(lines[end++]!)
      if (end >= lines.length) continue
      probe = body.join('\n').trim()
      index = end
    }
    if (probe !== '') leads.push({ claim, probe })
    claim = undefined
  }
  return leads
}

/** RSIAgent's LEAD blocks (loop.py:459-464); the harness does not execute probes, so each is NOT_RUN. */
export function formatLeads(leads: readonly Lead[]): string {
  return leads.map((lead, index) => `LEAD ${index + 1}
Actor-stated claim: ${lead.claim}
Exact reproducible probe proposed by Actor:
--- BEGIN PROBE ---
${lead.probe}
--- END PROBE ---
Harness execution classification: NOT_RUN`).join('\n\n')
}

export interface HandoffOptions {
  signal?: AbortSignal
  /** Extra transport check of a parsed handoff, e.g. the project-root shape gate. */
  validate?: (body: string) => Promise<string | undefined>
}

/** Runs an Actor work phase in the same context until it publishes a usable SUBMIT handoff. */
export async function runHandoffPhase(actor: RoleConversation, opening: string, policy: TransportPolicy, options: HandoffOptions = {}): Promise<string> {
  return converse(
    actor,
    opening,
    async reply => {
      const body = parseSubmitHandoff(reply.text)
      if (body === undefined) return { ok: false, detail: 'the first non-empty line of the handoff must be exactly "STATUS: SUBMIT"' }
      const problem = await options.validate?.(body)
      return problem === undefined ? { ok: true, value: body } : { ok: false, detail: problem }
    },
    detail => transportContinuation('ACTOR', detail),
    policy,
    'Actor Agent',
    options.signal,
  )
}

export interface VerifyOptions extends VerifierCharterInput {
  allowUnverified: boolean
  policy: TransportPolicy
  signal?: AbortSignal
}

/**
 * One inspection by a (possibly persistent) Verifier context. A context that
 * never publishes a valid verdict is infrastructure, never PASS or FAIL.
 */
export async function inspect(verifier: RoleConversation, options: VerifyOptions): Promise<VerificationResult> {
  try {
    return await converse(
      verifier,
      verifierCharter(options),
      reply => {
        const verdict = parseVerdict(reply.text, options.allowUnverified)
        return verdict === undefined
          ? { ok: false, detail: 'no single standalone verdict line' }
          : { ok: true, value: { kind: 'verdict' as const, verdict, report: reply.text } }
      },
      () => verifierTransportContinuation(options.allowUnverified),
      options.policy,
      'Verifier Agent',
      options.signal,
    )
  } catch (error) {
    // A context that stalled or ended without a verdict is infrastructure, never a verdict.
    if (error instanceof InfraError) return { kind: 'infra', reason: error.message }
    throw error
  }
}

export interface LearnOptions {
  store: MemoryStore
  binding: MemoryBinding
  episode: string
  kind: EpisodeKind
  outcome: TerminalOutcome
  report: string
  /** Phase 2 asks the same Actor for a Curriculum-facing diagnosis before the commit. */
  diagnosis: boolean
  policy: TransportPolicy
  signal?: AbortSignal
}

export interface LearnResult {
  commit: CommitRecord
  diagnosis?: string
  /** Paths the commit left exactly as they were (RSIAgent MEMORY CHANGES `unchanged`). */
  unchanged: string[]
}

/**
 * Same-context learning (RSIAgent `_promote_learning`): the Actor that did the
 * work distills into a draft opened from the *current* canonical memory,
 * reconciles the whole corpus, writes its diagnosis, and only then does the
 * harness promote the draft atomically. A draft over the store's limits goes
 * back to the same Actor to trim; it never aborts the lineage by itself.
 */
export async function learn(actor: RoleConversation, options: LearnOptions): Promise<LearnResult> {
  const { store, binding } = options
  const draft = await store.openDraft(options.episode, { fresh: true })
  const openDraftView = () => {
    binding.access = 'draft'
    binding.draft = draft
    binding.readDir = draft.dir
    binding.promotion = 'engine'
  }
  openDraftView()
  try {
    await actor.send(distillationMessage(options.outcome, options.report, 'engine', store.limits), options.signal)
    await actor.send(reconciliationMessage('engine'), options.signal)
    let diagnosis: string | undefined
    if (options.diagnosis) {
      diagnosis = await converse(
        actor,
        learningDiagnosisMessage(options.outcome, options.report),
        reply => (reply.text.trim() === '' ? { ok: false, detail: 'the diagnosis was empty' } : { ok: true, value: reply.text.trim() }),
        detail => transportContinuation('ACTOR', detail),
        options.policy,
        'Actor Agent diagnosis',
        options.signal,
      )
    }
    for (let round = 1; ; round++) {
      const final = await store.draftManifest(draft)
      // Promotion closes the draft view before the commit, so nothing writes into a tree being installed.
      binding.access = 'read'
      binding.draft = undefined
      binding.readDir = store.canonicalDir
      try {
        const commit = await store.commit(draft, { kind: options.kind, outcome: options.outcome })
        const changed = new Set([...commit.created, ...commit.modified])
        const unchanged = Object.keys(final).filter(path => !changed.has(path)).sort()
        return diagnosis === undefined ? { commit, unchanged } : { commit, diagnosis, unchanged }
      } catch (error) {
        if (!(error instanceof MemoryLimitError) || round >= options.policy.ceiling) throw error
        openDraftView()
        await converse(
          actor,
          transportContinuation('ACTOR', `the reconciled draft cannot be promoted: ${error.message}. Condense, merge, or delete memory files with rsi_memory_write and rsi_memory_delete, then hand off again`),
          () => ({ ok: true, value: undefined }),
          detail => transportContinuation('ACTOR', detail),
          options.policy,
          'Actor Agent memory limits',
          options.signal,
        )
      }
    }
  } catch (error) {
    await store.discardDraft(options.episode)
    binding.access = 'none'
    binding.draft = undefined
    throw error
  }
}
