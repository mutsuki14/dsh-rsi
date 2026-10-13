# dsh-rsi

English | [中文](README.zh.md)

**Recursive self-improvement for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).** This bundle ports the benchmark-independent mechanisms of [RSIAgent](https://github.com/AetherLabsAI/RSIAgent) (arXiv:2609.15364) to a dsh plugin:

- **Actor-owned experience memory**: procedures, reusable scripts, environment facts, and failure lessons, stored per project. It is read-only while the Actor works and changes only in a learning phase after an independent verdict.
- **An independent Verifier Agent**: a fresh sub-agent that sees the user's verbatim request and harness-captured change facts, never the Actor's reasoning, self-checks, or memory. It returns `PASS`, `FAIL`, or `UNVERIFIED`.
- **Curriculum-driven exploration**: Phase 1 broad waves and Phase 2 deep, target-conditioned practice (BRS / DRS in the paper).
- **Frozen mode**: test-time reuse (Phase 3). Memory stays readable and nothing is learned.

Model parameters never change. Improvement comes only from verified experience that memory carries across tasks.

## How it works

### Everyday tasks (interactive)

The main agent is the Actor. The plugin adds the RSI protocol to its system prompt and puts a names-and-sizes memory inventory in the runtime context.

```
task → Actor works (memory read as hints)
     → rsi_submit: a fresh Verifier sub-agent inspects the live result against
       the recent user messages plus git change facts; it never sees the
       Actor's reasoning, self-checks, or memory
     → PASS / FAIL (a report the Actor repairs against) / UNVERIFIED (asks for reproducible evidence)
     → rsi_learn: opens a learning phase on a copy of the current memory
     → rsi_memory_write / rsi_memory_delete: distill
     → rsi_memory_commit (first call): reconcile the whole corpus
     → rsi_memory_commit (second call): atomic promotion, journal entry, before/after tree hashes
```

### Exploration lineages (`rsi_explore`)

| phase | paper | flow |
|---|---|---|
| `broad` | Phase 1 · BRS | The Curriculum authors waves of independent practice projects. Every branch of a wave starts from the same memory snapshot and gets a fresh Actor and a fresh Verifier. After the complete wave is verified (the **wave barrier**), the same Actor contexts distill **serially** in authored order, each against the latest memory. |
| `deep` | Phase 2 · DRS | A fresh Actor attempts an immutable target. That same Actor learns from the PASS or FAIL and writes a diagnosis for the Curriculum. The Curriculum then picks practice until it returns `READY_FOR_TARGET` or `STALLED`. After any practice, a fresh retry of the unchanged target is mandatory. |
| — | Phase 3 | Set `mode: frozen`, or run `/rsi-freeze`. |

Stop policies:

- `curriculum_review` (default): after a target PASS, the Curriculum may still ask for more practice.
- `verifier_pass`: stops right after a target PASS and its memory commit.
- Infrastructure failures are never mapped to PASS or FAIL and never commit memory.

### How role contexts stay continuous in dsh

Every role (Actor, Verifier, Curriculum) is a sub-agent started with `ctx.subagents.startActivation`:

- the `spawn` provider, so the child starts without the parent conversation;
- `caller` delivery, so the result returns to the plugin without notifying the parent model;
- a reserved child id.

At each handoff, a role calls `rsi_handoff(text)`. That tool call stays pending until the engine sends the next message, which becomes the tool result. One Actor therefore works, waits for its verdict, distills, and reconciles in one continuous context, as RSIAgent requires. The Phase 1 wave barrier uses the same mechanism: each branch stays parked at its handoff until every branch is verified, and then they are released one at a time.

## Install

Requires Node `^22.19 || >=24` and dsh `0.2.1-alpha.x`; dsh APIs are pre-stable.

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
| `rsi_memory_list` / `rsi_memory_read` / `rsi_memory_search` | Actor, Curriculum | inspect memory (the draft, during a learning phase) |
| `rsi_memory_write` / `rsi_memory_delete` | Actor, learning phase only | edit the draft |
| `rsi_submit` | main Actor | request independent verification; pass `evidence_leads` after an UNVERIFIED |
| `rsi_learn` | main Actor | open the learning phase after a terminal verdict |
| `rsi_memory_commit` | main Actor | first call: reconcile; second call: promote atomically |
| `rsi_explore` | main Actor | run a `broad` or `deep` lineage (foreground; blocks until it settles) |
| `rsi_handoff` | role sub-agents | hand off to the engine and wait for its next message |

Verifiers get no memory tools and none of the file-mutating tools listed in `verifier.denyTools` (default: `write`, `edit`).

Commands:

- `/rsi`: show memory status.
- `/rsi-freeze`: freeze memory.
- `/rsi-unfreeze`: remove the freeze, after checking the tree hash recorded when memory was frozen.

## Configuration

Override the row by id in your profile's `cordis.patch.yml`. An override replaces the **whole** `config`, so restate every key you set.

```yaml
- id: dsh-rsi
  name: dsh-rsi
  config:
    mode: learn                # frozen = Phase 3 test-time reuse
    stateDir: .dsh-rsi         # relative to the session's original working directory
    subagentProvider: spawn
    roles:                     # optional: a different Verifier model strengthens independence
      verifier: { provider: deepseek, model: deepseek-pro }
    verifier:
      allowUnverified: true
      taskMessages: 3          # how many recent user messages the Verifier receives verbatim
      denyTools: [write, edit]
    exploration:
      maxWaveProjects: 4
      waveConcurrency: 1
      broadProjectBudget: 12   # checked only at wave boundaries
      deepPracticeBudget: 6
      targetCycleBudget: 4
      stopPolicy: curriculum_review
    audit:
      sealedTexts: []          # sealed material memory must never quote; an 8-word shingle overlap quarantines the commit
```

Every field is documented in [`src/config.ts`](src/config.ts).

## On-disk layout

```
<project>/.dsh-rsi/
  memory/            canonical tree (Actor-owned, no imposed schema)
  drafts/<episode>/  learning-phase working copies
  journal.jsonl      append-only commits: episode, kind, outcome, before/after tree hashes, delta
  history/NNNN/      full snapshot after each commit (memory.keepHistory)
  frozen.json        freeze marker with the frozen tree hash
  lineages/<id>/     events.jsonl, result.json, and one project/ directory per practice project
```

The tree hash matches RSIAgent's `tree_sha256` byte for byte, and a unit test checks this. You can commit `.dsh-rsi/memory` to share learned experience with your team, or add `.dsh-rsi/` to `.gitignore`.

## Differences from RSIAgent

- **Verifier isolation**:
  - Practice and target projects: the candidate is checkpointed before inspection and rolled back if the Verifier changed it.
  - Interactive tasks: changes to the working tree are detected but not rolled back. The Verifier has no file-writing tools, but `bash` can still modify files.
- **Interactive Verifier**: each inspection starts a fresh context that receives the Verifier's own earlier reports, rather than keeping one live context.
- **Curriculum**: it does not build fixture files on a separate machine. Project instructions describe the inputs, and projects live under `.dsh-rsi/lineages/`.
- **No sealed official evaluator**: it does not apply in dsh. The leakage audit is optional.
- **Fallback**: if a role ends its turn without calling `rsi_handoff`, a fresh context is started from the full handoff transcript, and a `ROLE_CONTEXT_REPLAYED` event is recorded.
- **Restarts**: interactive learning state lives in process memory. A restart discards an unpromoted draft; canonical memory is untouched.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) maps each RSIAgent mechanism to its implementation here.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run test     # unit tests, plus integration tests on the real agent loop, sub-agent manager, and spawn provider
pnpm run e2e      # offline end-to-end: a real dsh headless run against scripts/mock-deepseek.mjs
```

`src/engine/` and `src/memory/` do not depend on the harness. They are exported as `dsh-rsi/engine`; implement `RoleRuntime` to drive them from another runtime.

## License

Apache-2.0. The role prompts and protocol are adapted from RSIAgent (Apache-2.0); see [NOTICE](NOTICE).
