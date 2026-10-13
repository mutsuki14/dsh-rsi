import Schema from '@deepseek-ai/schemastery'

export interface MemoryConfig {
  maxFileBytes: number
  maxTotalBytes: number
  maxFiles: number
  keepHistory: boolean
}

export interface AuditConfig {
  sealedTexts: string[]
  shingleWords: number
}

export interface VerifierConfig {
  isolation: 'auto' | 'sandbox' | 'rollback'
  allowUnverified: boolean
  taskMessages: number
  denyTools: string[]
  checkpointMaxBytes: number
  checkpointMaxFiles: number
}

export interface RoleRoute {
  provider?: string
  model?: string
}

export interface RolesConfig {
  actor: RoleRoute
  verifier: RoleRoute
  curriculum: RoleRoute
  escalation: RoleRoute
}

export interface TransportConfig {
  actionlessLimit: number
  ceiling: number
}

export interface ExplorationConfig {
  waveCeiling: number
  waveConcurrency: number
  broadProjectBudget: number
  deepPracticeBudget: number
  targetCycleBudget: number
  unverifiedRounds: number
  targetResumes: number
  branchRetries: number
  stopPolicy: 'curriculum_review' | 'verifier_pass'
  curriculumMemoryAccess: 'read_only' | 'none'
}

export interface EvaluationConfig {
  command: string[]
  timeoutSec: number
  retries: number
}

export interface Config {
  mode: 'learn' | 'frozen'
  stateDir: string
  memoryDir: string
  promptInventory: number
  subagentProvider: string
  closeTimeoutMs: number
  roles: RolesConfig
  memory: MemoryConfig
  audit: AuditConfig
  verifier: VerifierConfig
  transport: TransportConfig
  exploration: ExplorationConfig
  evaluation: EvaluationConfig
}

function route(label: string): Schema<RoleRoute> {
  return Schema.object({
    provider: Schema.string(),
    model: Schema.string(),
  }).default({}).description(`Model route for ${label}.`)
}

export const Config: Schema<Config> = Schema.object({
  mode: Schema.union(['learn', 'frozen']).default('learn')
    .description('`learn` runs verify → distill → reconcile → commit after tasks; `frozen` is test-time reuse: memory is read-only.'),
  stateDir: Schema.string().default('.dsh-rsi')
    .description('Workspace directory for lineage project roots. Relative paths resolve against the session project directory.'),
  memoryDir: Schema.string().default('')
    .description('Durable memory, drafts, journal, reports, and lineage records. Empty: $DSH_HOME/rsi/<project>-<hash>, outside the workspace, like RSIAgent host-side memory.'),
  promptInventory: Schema.natural().default(40)
    .description('Memory inventory lines (names and sizes only) placed in the runtime context.'),
  subagentProvider: Schema.string().default('spawn')
    .description('Sub-agent provider for role contexts; it must start fresh children (no parent history).'),
  closeTimeoutMs: Schema.natural().default(30_000)
    .description('How long a closed role context may take to end its turn before it is disposed.'),
  roles: Schema.object({
    actor: route('practice and target Actor Agents'),
    verifier: route('Verifier Agents — a different model than the Actor strengthens independence'),
    curriculum: route('the Curriculum Agent'),
    escalation: route('a resumed target Actor; when it equals the Verifier route, that segment\'s Verifier takes the Actor route'),
  }).default({}).description('Optional provider/model routes per role; empty fields inherit the calling agent route.'),
  memory: Schema.object({
    maxFileBytes: Schema.natural().default(64 * 1024),
    maxTotalBytes: Schema.natural().default(4 * 1024 * 1024),
    maxFiles: Schema.natural().default(400),
    keepHistory: Schema.boolean().default(true).description('Keep a full snapshot of the tree after every commit.'),
  }).default({}),
  audit: Schema.object({
    sealedTexts: Schema.array(Schema.string()).default([])
      .description('Sealed material (e.g. held-out evaluation tasks) that memory must never quote; overlap quarantines a commit.'),
    shingleWords: Schema.natural().min(3).default(8),
  }).default({}),
  verifier: Schema.object({
    isolation: Schema.union(['auto', 'sandbox', 'rollback']).default('auto')
      .description('`sandbox`: the Verifier\'s file tools and processes are read-only (fails loud when unavailable); `rollback`: it may write and the candidate is restored; `auto`: sandbox when available.'),
    allowUnverified: Schema.boolean().default(true)
      .description('Let the Verifier publish UNVERIFIED to request reproducible evidence instead of guessing.'),
    taskMessages: Schema.natural().min(1).max(16).default(3)
      .description('Most recent user messages given verbatim to the interactive Verifier as the authoritative task.'),
    denyTools: Schema.array(Schema.string()).default(['write', 'edit', 'web_fetch', 'web_search'])
      .description('Tools hidden from Verifier contexts in addition to every RSI and delegation tool (unknown names are ignored).'),
    checkpointMaxBytes: Schema.natural().default(256 * 1024 * 1024)
      .description('Interactive candidate checkpoint size above which changes are only detected, not restored.'),
    checkpointMaxFiles: Schema.natural().default(20_000),
  }).default({}),
  transport: Schema.object({
    actionlessLimit: Schema.natural().min(1).default(3)
      .description('Consecutive role segments without a tool action or a usable handoff before the context counts as infrastructure (RSIAgent: 3).'),
    ceiling: Schema.natural().min(1).default(24)
      .description('Emergency bound on same-context continuations in one phase; not a semantic retry count.'),
  }).default({}),
  exploration: Schema.object({
    waveCeiling: Schema.natural().min(1).default(16)
      .description('Host capacity per Phase-1 wave; the Curriculum chooses wave width freely below it.'),
    waveConcurrency: Schema.natural().min(1).default(1),
    broadProjectBudget: Schema.natural().min(1).default(12),
    deepPracticeBudget: Schema.natural().default(6)
      .description('Emergency ceiling on Phase-2 practice; a final fresh target test always follows practice.'),
    targetCycleBudget: Schema.natural().min(1).default(6),
    unverifiedRounds: Schema.natural().min(1).default(3)
      .description('Consecutive UNVERIFIED rounds before an attempt counts as stalled (RSIAgent max_consec_done).'),
    targetResumes: Schema.natural().default(1)
      .description('Fresh-context resumes of a stalled target attempt on the same project root.'),
    branchRetries: Schema.natural().default(1),
    stopPolicy: Schema.union(['curriculum_review', 'verifier_pass']).default('curriculum_review'),
    curriculumMemoryAccess: Schema.union(['read_only', 'none']).default('read_only')
      .description('Whether the Curriculum may read Actor memory as evidence (RSIAgent ablation: none).'),
  }).default({}),
  evaluation: Schema.object({
    command: Schema.array(Schema.string()).default([])
      .description('Human-configured sealed evaluator argv, run by /rsi-eval on a copy of a finished deep lineage\'s candidate; never visible to agents.'),
    timeoutSec: Schema.natural().min(1).default(900),
    retries: Schema.natural().default(2),
  }).default({}),
})
