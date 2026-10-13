# Architecture

dsh-rsi has two layers.

- **Engine**: does not depend on any harness. It holds the role prompts, the transport parsers, the memory store, and the lineage state machines.
- **Host**: a dsh adapter that implements the engine's `RoleRuntime` seam and exposes everything as Cordis registrations.

## Source map

| Path | Responsibility | RSIAgent counterpart |
|---|---|---|
| `src/protocol/tokens.ts` | Unique standalone `VERDICT:` token, ignoring fences and indented code; first-line `DECISION:` parsing | `practice_loop._parse_unique_handoff`, `verifier._parse_agentic_verifier_report` |
| `src/protocol/wave.ts` | Wave JSON envelope (`WAVE` / `SATURATED` / `STALLED`), id rules, `<PROJECT_ROOT>` requirement | `phase1_wave.parse_wave_handoff` |
| `src/memory/hash.ts` | Canonical JSON and `treeSha256` (byte-compatible) | `explore/memory_hash.py` |
| `src/memory/store.ts` | Canonical tree, drafts, limits, stage-and-rename install, journal, history, freeze, crash recovery | `practice_loop._atomic_install_memory`, `commit.journal`, Phase 3 frozen-memory checks |
| `src/memory/audit.ts` | Optional 8-word shingle leakage tripwire; a hit quarantines the commit | `commit.silent_audit` |
| `src/roles/*.ts` | Epistemic core, memory preamble, Actor and Verifier charters, distillation, reconciliation, diagnosis, Curriculum charters | `core/actor.py`, `core/verifier_runtime.py`, `explore/charter.py` |
| `src/engine/steps.ts` | Handoff phase with transport continuations, one inspection, and same-context learning (distill → reconcile → commit → diagnosis) | `_run_handoff_phase`, `_promote_learning` |
| `src/engine/lineage.ts` | Phase 1 waves with snapshot, barrier, and serial commits; Phase 2 `run_self_evolving_loop` with both stop policies | `phase1_wave.py`, `core/self_evolving_loop.py`, `unified_evolution.evolve_until_ready` |
| `src/engine/workspace.ts` | Project manifests, mechanical change context, and candidate checkpoints for rollback | `loop._surface_delta`, `_verify_candidate` |
| `src/host/channel.ts` | Parked-handoff channel that turns one sub-agent turn into a multi-message role context | persistent `messages` lists per role |
| `src/host/subagent-runtime.ts` | `RoleRuntime` on `ctx.subagents.startActivation`: spawn provider, caller delivery, reserved child id, per-role `toolFilter`, persona, and model route | fresh VM plus model client per role |
| `src/host/git.ts` | Interactive mechanical context (git status and diff stat, excluding the state directory) and Verifier side-effect detection | `_surface_delta` |
| `src/index.ts` | Tools, system-prompt section, runtime-context inventory, recent-requests session projection, commands | host harness |

## Authority boundaries

| Role | Can | Cannot |
|---|---|---|
| Actor | work with all of the harness's tools; read memory; write the **draft** during learning | change canonical memory directly; grade itself |
| Verifier | inspect the live candidate with read and execute tools; publish one verdict | see memory, the Actor's conversation, self-checks, or handoff narrative; use `write`/`edit` |
| Curriculum | read memory as evidence; choose the next experiment or the stop | write or approve memory; grade candidates; author solutions or checks |
| Host | capture changes, checkpoint and roll back candidates, commit memory at valid boundaries | turn infrastructure failures, readiness, or `STALLED` into a verdict |

## Invariants

1. **Memory is immutable during work.** Writes go to a draft opened from the current canonical tree. A draft whose base is no longer canonical is refused (`MemoryConflictError`) rather than silently overwriting another commit. Commits are serialized.
2. **Wave barrier.** No branch of a wave learns until every branch has a verdict. Any branch that fails on infrastructure, after one unscored restart, blocks the whole wave, and no memory is merged.
3. **Infrastructure is unscored.** A missing verdict after transport continuations, a sub-agent that stops abnormally, or a failed start raises `InfraError`. It is never PASS or FAIL and never commits memory.
4. **A FAIL teaches but never counts as success.** Both outcomes distill, and the outcome is recorded in the journal.
5. **Readiness is not correctness.** `READY_FOR_TARGET` returns control to the target; after any practice, a fresh target attempt is mandatory. `STALLED` buys exactly one final target test.
6. **Model-visible ⟺ logged.** Every role exchange travels through tool results (`rsi_handoff`, `rsi_*`) or prompt contributions, so it appears in a dsh session log. Role children are ordinary dsh sessions and can be inspected.

## Why `rsi_handoff`

dsh sub-agents run one activation per prompt, and caller-delivery results return once. RSIAgent needs one context to span several harness-driven phases: the Actor works, waits for a verdict, distills, reconciles, and writes a diagnosis; the Verifier spans UNVERIFIED rounds; the Curriculum spans the whole lineage.

Each role therefore stays inside a single long turn and yields through a tool call that the engine resolves. This mirrors how dsh's own `ralph` and workflow tools build fixed loops on `ctx.subagents`, and it changes nothing in `agent-loop`. When a role ends its turn early, the runtime replays the logged exchange into a fresh context and emits `ROLE_CONTEXT_REPLAYED`.
