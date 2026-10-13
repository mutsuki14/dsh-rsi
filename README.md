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
| `deep` | Phase 2 · DRS | A fresh Actor attempts an immutable target (optionally replaying `target_fixtures`). FAIL is terminal for the attempt; UNVERIFIED asks the same Actor for evidence leads. Repeated UNVERIFIED rounds or an actionless Actor stall the attempt: one forced inspection follows, then a fresh-context resume with a work log (optionally on an escalation model, with the Verifier swapped to the Actor's model). The same Actor distills, reconciles, writes a diagnosis for the Curriculum, and only then is memory promoted. The Curriculum picks practice (with fixtures and a read-only original-fixture view for its Verifier) until `READY_FOR_TARGET` or `STALLED`. After any practice, a fresh retry of the unchanged target is mandatory, also when the practice budget runs out. |
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

At each handoff, a role calls `rsi_handoff(text)`. That tool call stays pending until the engine sends the next message, which becomes the tool result; closing the context resolves it and concludes the turn without another model call. A segment that ends without a handoff is steered back into the **same** context (RSIAgent's same-context continuation). Three consecutive segments without any tool action end the context as unscored infrastructure, as in RSIAgent; there is no fixed retry count.

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

Verifiers get no memory tools, no delegation tools, and none of the tools in `verifier.denyTools` (default: `write`, `edit`, `web_fetch`, `web_search`).

Commands (human-only; command results never reach the model):

- `/rsi`: memory location, isolation mode, inventory, task state, recent commits.
- `/rsi-freeze` and `/rsi-unfreeze`: freeze memory; unfreezing first checks the frozen tree hash.
- `/rsi-eval <lineage>`: sealed evaluation of a finished deep lineage.

## Verifier isolation

`verifier.isolation` (default `auto`):

- `sandbox`: the Verifier child is pinned to dsh's `read-only` sandbox mode at creation, before its first step. Its file tools, bash, background jobs, terminals, and `run_code` cannot write anywhere, and escalation is rejected; the Actor keeps its own policy. File tools also refuse Actor-private paths. Fails loudly when the profile has no sandbox policy or the dsh version cannot reserve child ids.
- `rollback`: the Verifier may write; the harness restores the candidate afterwards.
- `auto`: `sandbox` when available, otherwise `rollback`.

In every mode the interactive candidate (tracked and untracked-but-not-ignored files) is checkpointed before an inspection and restored if it changed; practice and target project roots are copied and restored the same way.

## Configuration

Override the row by id in your profile's `cordis.patch.yml`. An override replaces the **whole** `config`, so restate every key you set.

```yaml
- id: dsh-rsi
  name: dsh-rsi
  config:
    mode: learn                # frozen = Phase 3 test-time reuse
    stateDir: .dsh-rsi         # workspace dir for lineage project roots only
    memoryDir: ''              # '' = $DSH_HOME/rsi/<project>-<hash>, outside the workspace
    subagentProvider: spawn
    roles:                     # optional model routes; a different Verifier model strengthens independence
      verifier: { provider: deepseek, model: deepseek-pro }
      escalation: { provider: deepseek, model: deepseek-pro }
    verifier:
      isolation: auto          # sandbox | rollback | auto
      allowUnverified: true
      taskMessages: 3
      denyTools: [write, edit, web_fetch, web_search]
    transport:
      actionlessLimit: 3       # RSIAgent: three actionless segments are infrastructure
      ceiling: 24              # emergency bound, not a retry count
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
  drafts/<episode>[.json] learning-phase working copies and their metadata
  journal.jsonl          append-only commits: episode, kind, outcome, before/after tree hashes, delta
  history/NNNN/          full snapshot after each commit (memory.keepHistory)
  reports/<sha256>.md    content-addressed Verifier reports, re-hashed on read
  frozen.json            freeze marker with the frozen tree hash
  lineages/<id>/         events.jsonl, result.json, curriculum_notes.md, fixture captures, wave snapshots
  sealed/<id>/<run>/     sealed evaluations (candidate copy, task, evaluation.json)
<project>/.dsh-rsi/lineages/<id>/   practice and target project roots (what roles work in)
```

The tree hash matches RSIAgent's `tree_sha256` byte for byte, and a unit test checks this.

## Remaining differences from RSIAgent

These follow from what dsh provides today; each is stated so nothing claims more than it delivers.

- **No private writable scratch for a sandboxed Verifier.** dsh's read-only mode has no extra writable root, so the Verifier cannot write even to `/tmp` (as RSIAgent's practice Verifiers). RSIAgent's target Verifier also gets a private `VERIFIER_SCRATCH` tmpfs. Use `rollback` isolation when verification needs writes.
- **Read hiding and network/process isolation are not mechanical.** dsh confines writes only. File tools refuse Actor-private paths and those paths live outside the workspace and are never disclosed, but a determined `bash` could still read them, reach local services, or signal other processes; RSIAgent uses namespaces.
- **Interactive Verifier continuity spans one main-agent turn.** dsh hosts wait for children at the turn boundary, so the live context closes there; in a later turn a fresh context continues from its own published reports. Lineage Verifiers persist for the whole attempt.
- **Evidence leads are `NOT_RUN`.** The harness forwards CLAIM/PROBE pairs but does not execute them; RSIAgent classifies them by running the Actor's validated checks.
- **A memory conflict asks for a new learning phase.** If canonical memory changed after a draft was opened, the draft is discarded and the Actor relearns against current memory; RSIAgent's recovery path refuses instead.
- **Exploration lineages are not resumable after a restart**; interactive learning phases are.
- **On dsh 0.2.0-rc.2**, `rsi_explore` is refused (role children cannot start in their own project root) and Verifier isolation is `rollback`.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) maps each RSIAgent mechanism to its implementation here.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run test     # unit tests, plus real-runtime tests (agent loop, sub-agents, sandbox stack, restart)
pnpm run e2e      # offline end-to-end: real dsh headless against scripts/mock-deepseek.mjs

# the 0.2.0-rc.2 line, as CI runs it
node scripts/use-dsh.mjs 0.2.0-rc.2 && pnpm install --no-frozen-lockfile
pnpm run typecheck:legacy && DSH_LEGACY=1 pnpm run test && DSH_VERSION=0.2.0-rc.2 pnpm run e2e
```

`src/engine/` and `src/memory/` do not depend on the harness. They are exported as `dsh-rsi/engine`; implement `RoleRuntime` to drive them from another runtime.

## License

Apache-2.0. The role prompts and protocol are adapted from RSIAgent (Apache-2.0); see [NOTICE](NOTICE).
