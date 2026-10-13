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
  allowUnverified: boolean
  transportRetries: number
}

export interface ExplorationConfig {
  maxWaveProjects: number
  waveConcurrency: number
  broadProjectBudget: number
  deepPracticeBudget: number
  targetCycleBudget: number
  unverifiedRounds: number
  branchRetries: number
  stopPolicy: 'curriculum_review' | 'verifier_pass'
}

export interface Config {
  mode: 'learn' | 'frozen'
  stateDir: string
  promptInventory: number
  memory: MemoryConfig
  audit: AuditConfig
  verifier: VerifierConfig
  exploration: ExplorationConfig
}

export const Config: Schema<Config> = Schema.object({
  mode: Schema.union(['learn', 'frozen']).default('learn')
    .description('`learn` runs verify → distill → reconcile → commit after tasks; `frozen` is test-time reuse: memory is read-only.'),
  stateDir: Schema.string().default('.dsh-rsi')
    .description('Lineage state and durable memory. Relative paths resolve against the agent working directory.'),
  promptInventory: Schema.natural().default(40)
    .description('Memory inventory lines (names and sizes only) placed in the system prompt.'),
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
    allowUnverified: Schema.boolean().default(true)
      .description('Let the Verifier publish UNVERIFIED to request reproducible evidence instead of guessing.'),
    transportRetries: Schema.natural().default(2)
      .description('Same-context continuations when a role reply lacks its transport token.'),
  }).default({}),
  exploration: Schema.object({
    maxWaveProjects: Schema.natural().min(1).default(4),
    waveConcurrency: Schema.natural().min(1).default(1),
    broadProjectBudget: Schema.natural().min(1).default(12),
    deepPracticeBudget: Schema.natural().default(6),
    targetCycleBudget: Schema.natural().min(1).default(4),
    unverifiedRounds: Schema.natural().default(2),
    branchRetries: Schema.natural().default(1),
    stopPolicy: Schema.union(['curriculum_review', 'verifier_pass']).default('curriculum_review'),
  }).default({}),
})
