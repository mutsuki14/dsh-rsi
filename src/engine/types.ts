import type { MemoryDraft } from '../memory/store.ts'
import type { Verdict } from '../protocol/tokens.ts'

export type RoleKind = 'actor' | 'verifier' | 'curriculum'

/** Which configured model route a context uses; `escalation` serves a resumed target Actor. */
export type RoleRoute = RoleKind | 'escalation'

/**
 * What the `rsi_memory_*` tools of one role context can see and change.
 * The engine mutates the binding of the same Actor context when its learning
 * phase opens, mirroring RSIAgent's canonical-memory re-push before distillation.
 */
export interface MemoryBinding {
  /** `none` hides memory entirely (Verifier); `read` exposes `readDir`; `draft` exposes a writable draft. */
  access: 'none' | 'read' | 'draft'
  /** Directory the read tools inspect (canonical tree or a wave snapshot). */
  readDir?: string
  draft?: MemoryDraft
  /** `engine`: the harness promotes the draft after reconciliation; `actor`: the Actor calls rsi_memory_commit. */
  promotion?: 'engine' | 'actor'
}

export interface OpenRoleOptions {
  role: RoleKind
  /** Human-readable label, e.g. `wave-2/csv-merge actor`. */
  label: string
  /** Role identity prompt, contributed in addition to the harness's own. */
  system: string
  /** Working directory of the role's tools. */
  cwd: string
  memory: MemoryBinding
  /** Model route; defaults to the role's own. */
  route?: RoleRoute
  /** File the Curriculum's rsi_notes tool maintains. */
  notesFile?: string
}

/** One role reply: the handoff text and how many tool actions preceded it in this segment. */
export interface RoleReply {
  text: string
  actions: number
}

/** One persistent role context. `send` delivers a message and resolves to the role's next handoff. */
export interface RoleConversation {
  send(message: string, signal?: AbortSignal): Promise<RoleReply>
  close(): Promise<void>
}

/** The harness adapter: dsh sub-agents in production, scripted fakes in tests. */
export interface RoleRuntime {
  open(options: OpenRoleOptions): Promise<RoleConversation>
}

export type VerificationResult =
  | { kind: 'verdict', verdict: Verdict, report: string }
  | { kind: 'infra', reason: string }

/** Infrastructure: never a PASS or FAIL, never a memory commit. */
export class InfraError extends Error {}

/** Transport exhaustion: consecutive actionless segments or the emergency ceiling. */
export class TransportInfraError extends InfraError {}

/**
 * RSIAgent's transport rule: no fixed retry count; consecutive actionless
 * segments end the context as infrastructure, and a large ceiling bounds cost.
 */
export interface TransportPolicy {
  actionlessLimit: number
  ceiling: number
}

export interface EngineEvent {
  type: string
  [key: string]: unknown
}

export type EngineObserver = (event: EngineEvent) => void
