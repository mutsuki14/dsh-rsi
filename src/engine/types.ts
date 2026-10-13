import type { MemoryDraft } from '../memory/store.ts'
import type { Verdict } from '../protocol/tokens.ts'

export type RoleKind = 'actor' | 'verifier' | 'curriculum'

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
  /** Role system prompt, contributed in addition to the harness's own. */
  system: string
  /** Working directory of the role's tools. */
  cwd: string
  memory: MemoryBinding
}

/** One persistent role context. `send` runs a complete turn and resolves to its final assistant text. */
export interface RoleConversation {
  send(message: string, signal?: AbortSignal): Promise<string>
  close(): Promise<void>
}

/** The harness adapter: dsh sub-agents in production, scripted fakes in tests. */
export interface RoleRuntime {
  open(options: OpenRoleOptions): Promise<RoleConversation>
}

export type VerificationResult =
  | { kind: 'verdict', verdict: Verdict, report: string }
  | { kind: 'infra', reason: string }

export class InfraError extends Error {}

export interface EngineEvent {
  type: string
  [key: string]: unknown
}

export type EngineObserver = (event: EngineEvent) => void
