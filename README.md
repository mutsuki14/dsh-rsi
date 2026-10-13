# dsh-rsi

English | [中文](README.zh.md)

**Recursive self-improvement for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).** This bundle ports the benchmark-independent mechanisms of [RSIAgent](https://github.com/AetherLabsAI/RSIAgent) (arXiv:2609.15364) to a dsh plugin:

- **Actor-owned experience memory**: procedures, reusable scripts, environment facts, and failure lessons, stored per project outside the workspace. It is read-only while the Actor works and changes only in a learning phase after an independent verdict.
- **An independent, effect-isolated Verifier Agent**: a sub-agent pinned to dsh's read-only sandbox. It sees the user's verbatim request and harness-captured change facts, never the Actor's reasoning, self-checks, or memory, and returns `PASS`, `FAIL`, or `UNVERIFIED`.
- **Curriculum-driven exploration**: Phase 1 broad waves and Phase 2 deep, target-conditioned practice (BRS / DRS in the paper). The Curriculum builds each project's input fixtures; the harness captures and replays them byte for byte.
- **Frozen mode and sealed evaluation**: test-time reuse (Phase 3) with an optional host-only evaluator whose result never reaches an agent.

Model parameters never change. Improvement comes only from verified experience that memory carries across tasks.

## How it works

### Everyday tasks (interactive)

The main agent is the Actor. The plugin adds the RSI protocol to its system prompt and puts a names-and-sizes memory inventory in the runtime context.

```
task → Actor works (memory read as hints)
     → rsi_submit: an isolated Verifier sub-agent inspects the live result against the
       recent user messages plus git change facts; the candidate is checkpointed first
     → PASS / FAIL (a report the Actor repairs against) / UNVERIFIED (asks for CLAIM/PROBE evidence leads)
       — within one turn the same Verifier context inspects every revision
     → rsi_learn: opens a learning phase on a copy of the current memory
     → rsi_memory_write / rsi_memory_delete: distill
     → rsi_memory_commit (first call): reconcile the whole corpus
     → rsi_memory_commit (second call): atomic promotion, journal entry, before/after tree hashes
```

The task state (Verifier generation, report references, verdict, learning stage) is a **session projection** folded from the tool results in the dsh session log, and drafts and reports live on disk. A learning phase therefore survives a process restart or a resumed session.

### Exploration lineages (`rsi_explore`, dsh ≥ 0.2.1-alpha.2)

| phase | paper | flow |
|---|---|---|
| `broad` | Phase 1 · BRS | The Curriculum authors waves of independent projects and builds each project's fixture tree. The harness checks each tree's shape, captures it privately, and replays it into a fresh project root. Every branch starts from the same memory snapshot and gets a fresh Actor and a fresh Verifier. After the complete wave is verified (the **wave barrier**), the same Actor contexts distill **serially** in authored order, each against the latest memory. |
| `deep` | Phase 2 · DRS | A fresh Actor attempts an immutable target (optionally replaying `target_fixtures`). FAIL is terminal for the attempt; UNVERIFIED asks the same Actor for evidence leads. Repeated UNVERIFIED rounds or an actionless Actor stall the attempt: one forced inspection follows. A terminal verdict is then learned by the same, held Actor; otherwise a fresh-context resume gets the latest work log (optionally on an escalation model, with the Verifier swapped once to the Actor's model). The same Actor distills, reconciles, writes a diagnosis for the Curriculum, and only then is memory promoted. The Curriculum picks practice (with fixtures and a read-only original-fixture view for its Verifier) until `READY_FOR_TARGET` or `STALLED`. After any practice, a fresh retry of the unchanged target is mandatory, also when the practice budget runs out. |
| — | Phase 3 | Set `mode: frozen`, or run `/rsi-freeze`. `/rsi-eval <lineage>` runs the configured sealed evaluator. |

Stop policies:

- `curriculum_review` (default): after a target PASS, the Curriculum may still ask for more practice.
- `verifier_pass`: stops right after a target PASS and its memory commit.
- Infrastructure failures are never mapped to PASS or FAIL, never commit memory, and are recorded in the lineage's `result.json` as `infra` or `quarantined`.

### How role contexts stay continuous in dsh

Every role (Actor, Verifier, Curriculum) is a sub-agent started with `ctx.subagents.startActivation`:

- the `spawn` provider, so the child starts without the parent conversation;
- `caller` delivery, so the result returns to the plugin without notifying the parent model;
- a reserved child id, so creation hooks can isolate it before its first step;
- a tool filter that removes every delegation tool (`subagent`, `workflow`, `send_message`, …) and the interactive RSI tools.

At each handoff, a role calls `rsi_handoff(text)`. That tool call stays pending until the engine sends the next message, which becomes the tool result; closing the context resolves it and concludes the turn without another model call. Only one handoff per model message is accepted, so a duplicated call never answers a message the role has not read.

A segment that ends without a handoff is steered back into the **same** context (RSIAgent's same-context continuation). Three consecutive segments without any tool action end the *phase* as unscored transport infrastructure, as in RSIAgent, but not the context: the harness holds the child at its turn boundary, so after a stalled target attempt the forced inspection's verdict is learned by the same Actor that did the work. Both bounds (`actionlessLimit`, `ceiling`) count per handoff phase, and stops that follow a tool step in a turn that hit the output limit are not counted. There is no fixed retry count.

Role contexts take input only from the harness: `send_message`/`interrupt_agent` addressed to a role child are refused, and agent messages never enter a role's steps.

## Install

Requires Node `^22.19 || >=24` and dsh `0.2.0-rc.2` (what `npx @deepseek-ai/dsh` installs) or `0.2.1-alpha.x` (≥ alpha.2). Exploration needs the alpha line.

```sh
# from a local checkout
git clone https://github.com/mutsuki14/dsh-rsi && cd dsh-rsi
pnpm install && pnpm run build
dsh plugin --profile web add "$PWD"

# or straight from GitHub (the prepare script builds it; allow that build in the
# profile's pnpm-workspace.yaml:  allowBuilds: { dsh-rsi: true })
dsh plugin --profile web add github:mutsuki14/dsh-rsi#<commit>

dsh --profile web --dump-config | grep -A6 '== dsh-rsi'   # check that the bundle layer is composed
dsh web                                                   # or: dsh headless "task"
```

## Tools

| tool | used by | purpose |
|---|---|---|
| `rsi_memory_list` / `rsi_memory_read` / `rsi_memory_search` | Actor, Curriculum (unless `curriculumMemoryAccess: none`) | inspect memory (the draft, during a learning phase) |
| `rsi_memory_write` / `rsi_memory_delete` | Actor, learning phase only | edit the draft |
| `rsi_submit` | main Actor | request independent verification; pass `evidence_leads` (claim + probe pairs) after an UNVERIFIED |
| `rsi_learn` | main Actor | open the learning phase after a terminal verdict |
| `rsi_memory_commit` | main Actor | first call: reconcile; second call: promote atomically |
| `rsi_explore` | main Actor | run a `broad` or `deep` lineage (foreground; blocks until it settles) |
| `rsi_handoff` | role sub-agents | hand off to the engine and wait for its next message |
| `rsi_notes` | Curriculum | replace its private search notes (never shown to the Actor or Verifier) |

Verifiers work from an allow-list (`verifier.allowTools`: read, search, and confined-execution tools) minus `verifier.denyTools` (default: `write`, `edit`, `web_fetch`, `web_search`). They get no memory, delegation, or MCP tools: MCP servers act outside the sandbox. A global guard enforces this for tools registered after a child started and for `run_code` sub-calls.

Commands (human-only; command results never reach the model):

- `/rsi`: memory location, isolation mode, inventory, task state, recent commits.
- `/rsi-freeze` and `/rsi-unfreeze`: freeze memory; unfreezing first checks the frozen tree hash.
- `/rsi-eval <lineage>`: sealed evaluation of a finished deep lineage.

## Verifier isolation

`verifier.isolation` (default `auto`):

- `sandbox`: the Verifier child is pinned to dsh's `read-only` sandbox mode at creation, before its first step. Its file tools, bash, background jobs, terminals, and `run_code` cannot write anywhere, and escalation is rejected; the Actor keeps its own policy. File tools also refuse Actor-private paths (memory, session logs, projection caches; `..` is resolved physically, as the filesystem does). Chosen only when a preflight shows a sandbox backend really confines a read-only command; an explicit `sandbox` fails loudly otherwise.
- `rollback`: the Verifier may write; the harness restores the candidate afterwards.
- `auto`: `sandbox` when available, otherwise `rollback`.

In every mode the interactive candidate (the session's project: tracked and untracked-but-not-ignored files) is checkpointed before an inspection and restored if it changed; files that existed before (ignored ones included) are never deleted, and a workspace too large to copy is compared by size and time and reported. Practice and target project roots are copied whole and restored when anything in them changed, `.git` and dependency trees included.

Host-side `git` (change facts, checkpoints) never runs repository-planted programs: hooks, fsmonitor, external diff, and the filter, diff, and textconv drivers the repository defines are disabled. Global and system configuration (line endings, LFS, `safe.directory`) still applies.

## Configuration

Override the row by id in your profile's `cordis.patch.yml`. An override replaces the **whole** `config`, so restate every key you set.

```yaml
- id: dsh-rsi
  name: dsh-rsi
  config:
    mode: learn                # frozen = Phase 3 test-time reuse
    stateDir: ''               # '' = <project>/.dsh-rsi/work: lineage project roots (role agents can write only in the workspace)
    memoryDir: ''              # '' = $DSH_HOME/rsi/<project>-<hash>, outside the workspace
    subagentProvider: spawn
    roles:                     # optional model routes; a different Verifier model strengthens independence
      verifier: { provider: deepseek, model: deepseek-pro }
      escalation: { provider: deepseek, model: deepseek-pro }
    verifier:
      isolation: auto          # sandbox | rollback | auto
      allowUnverified: true
      taskMessages: 3
      allowTools: [read, read_image, grep, glob, bash, pwsh, job_output, job_list, job_kill, run_code, lsp, skill, todo_write, working_directory]
      denyTools: [write, edit, web_fetch, web_search]
    transport:
      actionlessLimit: 3       # RSIAgent: three actionless segments end a phase as infrastructure
      ceiling: 24              # emergency bound per phase, not a retry count
    exploration:
      waveCeiling: 16          # host capacity; the Curriculum chooses wave width below it
      waveConcurrency: 1
      broadProjectBudget: 12   # checked only at wave boundaries
      deepPracticeBudget: 6    # emergency ceiling; a final fresh target test always follows practice
      targetCycleBudget: 6
      unverifiedRounds: 3      # RSIAgent max_consec_done
      targetResumes: 1
      stopPolicy: curriculum_review
      curriculumMemoryAccess: read_only   # or none (RSIAgent ablation)
    evaluation:
      command: []              # e.g. [python3, /abs/path/grade.py]; prints {"score": n} last
      timeoutSec: 900
    audit:
      sealedTexts: []          # memory that quotes these (8-word shingles) is quarantined silently
```

Every field is documented in [`src/config.ts`](src/config.ts).

## On-disk layout

```
$DSH_HOME/rsi/<project>-<hash>/     (memoryDir; outside every role's working directory)
  memory/                canonical tree (Actor-owned, no imposed schema)
  drafts/<episode>[.json] learning-phase working copies and their metadata (written last, removed first)
  journal.jsonl          append-only commits: episode, kind, outcome, before/after tree hashes, delta
  commit.pending.json    an install in flight; recovery finishes or drops it
  quarantined/<episode>  learning phases the silent audit refused
  history/NNNN/          full snapshot after each commit (memory.keepHistory)
  reports/<sha256>.md    content-addressed Verifier reports, re-hashed on read
  frozen.json            freeze marker with the frozen tree hash
  .lock                  cross-process mutation lock (two dsh processes in one project)
  lineages/<id>/         events.jsonl, result.json, curriculum_notes.md, fixture captures, wave snapshots, final-candidate/
  sealed/<id>/<run>/     sealed evaluations (candidate copy, task, evaluation.json)
<project>/.dsh-rsi/work/lineages/<id>/   practice and target project roots (what roles work in; a separate,
                                          self-ignoring git repository, so the user's status stays clean)
```

The tree hash matches RSIAgent's `tree_sha256` byte for byte, and a unit test checks this. Memory written by dsh-rsi 0.1 inside the workspace (`<project>/.dsh-rsi`) is moved here on first use.

Memory limits (`memory.maxFiles`, `maxTotalBytes`, `maxFileBytes`) are stated in the learning prompts; writes that would grow memory past them are refused (condensing is always allowed), and a draft that still ends up over a limit goes back to the same Actor to trim. The `.lock` is a lease: a lock left by a crashed process is taken over once its heartbeat stops. `/rsi-eval` scores the private `final-candidate/` copy and refuses one whose digest changed after the lineage ended.

## Remaining differences from RSIAgent

These follow from what dsh provides today; each is stated so nothing claims more than it delivers.

- **No private writable scratch for a sandboxed Verifier.** dsh's read-only mode has no extra writable root, so the Verifier cannot write even to `/tmp` (as RSIAgent's practice Verifiers). RSIAgent's target Verifier also gets a private `VERIFIER_SCRATCH` tmpfs. Use `rollback` isolation when verification needs writes.
- **Read hiding and network/process isolation are not mechanical.** dsh confines writes only. File tools refuse Actor-private paths and those paths live outside the workspace and are never disclosed, but a determined `bash` could still read them, reach local services, or signal other processes; RSIAgent uses namespaces. The Verifier is told so and told never to mutate live services.
- **Interactive Verifier continuity spans one main-agent turn.** dsh hosts wait for children at the turn boundary, so the live context closes there; in a later turn a fresh context continues from its own published reports. Lineage Verifiers persist for the whole attempt.
- **Evidence leads are `NOT_RUN`.** The harness forwards CLAIM/PROBE pairs (and nothing else) but does not execute them; RSIAgent classifies them by running the Actor's validated checks.
- **A memory conflict asks for a new learning phase.** If canonical memory changed after a draft was opened, the draft is discarded and the Actor relearns against current memory; RSIAgent's recovery path refuses instead.
- **Exploration lineages are not resumable after a restart**; interactive learning phases are. Drafts of interrupted lineages are swept on the next start; drafts of interactive sessions that are never resumed stay on disk until removed by hand.
- **Forks.** A verdict is learned once across a session and its forks: whichever promotes it first wins, and the others are told it is already learned.
- **On dsh 0.2.0-rc.2**, `rsi_explore` is refused (role children cannot start in their own project root), Verifier isolation is `rollback`, and the interactive tools must be called directly rather than from `run_code` (that version records no structured result for `run_code` sub-calls).

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) maps each RSIAgent mechanism to its implementation here.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run test     # unit tests, plus real-runtime tests (agent loop, sub-agents, sandbox stack, restart, guards)
pnpm run e2e      # offline end-to-end: real dsh headless against scripts/mock-deepseek.mjs

# the 0.2.0-rc.2 line, as CI runs it
node scripts/use-dsh.mjs 0.2.0-rc.2 && rm pnpm-lock.yaml && pnpm install --no-frozen-lockfile
pnpm run typecheck:legacy && DSH_LEGACY=1 pnpm run test && DSH_VERSION=0.2.0-rc.2 pnpm run e2e
```

`src/engine/` and `src/memory/` do not depend on the harness. They are exported as `dsh-rsi/engine`; implement `RoleRuntime` to drive them from another runtime.

## License

Apache-2.0. The role prompts and protocol are adapted from RSIAgent (Apache-2.0); see [NOTICE](NOTICE).
