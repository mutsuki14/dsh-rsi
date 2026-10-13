import type { CommitRecord, EpisodeKind, MemoryStore, TerminalOutcome } from '../memory/store.ts'
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

/** Extracts CLAIM/PROBE pairs; a PROBE continues until the next CLAIM or PROBE line. */
export function parseLeads(handoff: string): Lead[] {
  const leads: Lead[] = []
  let claim: string | undefined
  let probe: string[] | undefined
  const flush = () => {
    if (claim !== undefined && probe !== undefined && probe.join('\n').trim() !== '') leads.push({ claim, probe: probe.join('\n').trim() })
    probe = undefined
  }
  for (const line of handoff.split(/\r?\n/)) {
    const claimMatch = /^\s*CLAIM:\s*(.*)$/.exec(line)
    const probeMatch = /^\s*PROBE:\s*(.*)$/.exec(line)
    if (claimMatch) {
      flush()
      claim = claimMatch[1]!.trim()
    } else if (probeMatch) {
      flush()
      probe = [probeMatch[1]!]
    } else if (probe !== undefined) {
      probe.push(line)
    }
  }
  flush()
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
}

/**
 * Same-context learning (RSIAgent `_promote_learning`): the Actor that did the
 * work distills into a draft opened from the *current* canonical memory,
 * reconciles the whole corpus, writes its diagnosis, and only then does the
 * harness promote the draft atomically.
 */
export async function learn(actor: RoleConversation, options: LearnOptions): Promise<LearnResult> {
  const draft = await options.store.openDraft(options.episode)
  options.binding.access = 'draft'
  options.binding.draft = draft
  options.binding.readDir = draft.dir
  options.binding.promotion = 'engine'
  try {
    await actor.send(distillationMessage(options.outcome, options.report, 'engine'), options.signal)
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
    // Promotion closes the draft view before the commit, so nothing writes into a tree being installed.
    options.binding.access = 'read'
    options.binding.draft = undefined
    options.binding.readDir = options.store.canonicalDir
    const commit = await options.store.commit(draft, { kind: options.kind, outcome: options.outcome })
    return diagnosis === undefined ? { commit } : { commit, diagnosis }
  } catch (error) {
    await options.store.discardDraft(options.episode)
    options.binding.access = 'none'
    options.binding.draft = undefined
    throw error
  }
}
