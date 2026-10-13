import type { MemoryStore, CommitRecord, EpisodeKind, TerminalOutcome } from '../memory/store.ts'
import { parseUniqueToken, parseVerdict } from '../protocol/tokens.ts'
import { distillationMessage, learningDiagnosisMessage, reconciliationMessage } from '../roles/actor.ts'
import { verifierCharter, verifierTransportContinuation, type VerifierCharterInput } from '../roles/verifier.ts'
import type { MemoryBinding, RoleConversation, VerificationResult } from './types.ts'
import { InfraError } from './types.ts'

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

export const HANDOFF_CONTINUATION = `SAME-CONTEXT TRANSPORT CONTINUATION. Your turn ended without a handoff whose first non-empty
line is exactly "STATUS: SUBMIT". If project work remains, continue it; when you decide to stop, end your
turn with the complete handoff.`

/** Runs an Actor work phase until it publishes a SUBMIT handoff; an actionless lineage is infrastructure, not a verdict. */
export async function runHandoffPhase(actor: RoleConversation, opening: string, retries: number, signal?: AbortSignal): Promise<string> {
  let reply = await actor.send(opening, signal)
  for (let attempt = 0; ; attempt++) {
    const handoff = parseSubmitHandoff(reply)
    if (handoff !== undefined) return handoff
    if (attempt >= retries) throw new InfraError('the Actor Agent never published a STATUS: SUBMIT handoff')
    reply = await actor.send(HANDOFF_CONTINUATION, signal)
  }
}

export interface VerifyOptions extends VerifierCharterInput {
  allowUnverified: boolean
  retries: number
  signal?: AbortSignal
}

/**
 * One inspection by a (possibly persistent) Verifier context. A report without
 * a valid verdict after the transport retries is infrastructure, never PASS or FAIL.
 */
export async function inspect(verifier: RoleConversation, options: VerifyOptions): Promise<VerificationResult> {
  let report = await verifier.send(verifierCharter(options), options.signal)
  for (let attempt = 0; ; attempt++) {
    const verdict = parseVerdict(report, options.allowUnverified)
    if (verdict !== undefined) return { kind: 'verdict', verdict, report }
    if (attempt >= options.retries) return { kind: 'infra', reason: 'the Verifier Agent did not publish exactly one valid verdict' }
    report = await verifier.send(verifierTransportContinuation(options.allowUnverified), options.signal)
  }
}

export interface LearnOptions {
  store: MemoryStore
  binding: MemoryBinding
  episode: string
  kind: EpisodeKind
  outcome: TerminalOutcome
  report: string
  /** Phase 2 asks the same Actor for a Curriculum-facing diagnosis after the commit. */
  diagnosis: boolean
  signal?: AbortSignal
}

export interface LearnResult {
  commit: CommitRecord
  diagnosis?: string
}

/**
 * Same-context learning (RSIAgent `_promote_learning`): the Actor that did the
 * work distills into a draft opened from the *current* canonical memory,
 * reconciles the whole corpus, and the harness promotes the draft atomically.
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
    const commit = await options.store.commit(draft, { kind: options.kind, outcome: options.outcome })
    options.binding.access = 'read'
    options.binding.draft = undefined
    options.binding.readDir = options.store.canonicalDir
    const result: LearnResult = { commit }
    if (options.diagnosis) result.diagnosis = await actor.send(learningDiagnosisMessage(options.outcome), options.signal)
    return result
  } catch (error) {
    await options.store.discardDraft(options.episode)
    options.binding.access = 'none'
    options.binding.draft = undefined
    throw error
  }
}
