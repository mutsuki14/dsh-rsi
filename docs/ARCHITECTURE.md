# Architecture

dsh-rsi has two layers.

- **Engine** (`src/engine`, `src/memory`, `src/roles`, `src/protocol`): does not depend on any harness. It holds the role prompts, the transport parsers, the memory store, fixtures, and the lineage state machines.
- **Host** (`src/host`, `src/index.ts`): a dsh adapter that implements the engine's `RoleRuntime` seam, isolates role children, and exposes everything as Cordis registrations.

## Source map

| Path | Responsibility | RSIAgent counterpart |
|---|---|---|
| `src/protocol/tokens.ts` | Unique standalone `VERDICT:` / `DECISION:` / `STATUS:` tokens, ignoring fences and indented code | `practice_loop._parse_unique_handoff`, `verifier._parse_agentic_verifier_report` |
| `src/protocol/wave.ts` | Wave JSON envelope (`WAVE` / `SATURATED` / `STALLED`), id rules, `<PROJECT_ROOT>` requirement; wave width is the Curriculum's choice | `phase1_wave.parse_wave_handoff` |
| `src/memory/hash.ts` | Canonical JSON and `treeSha256` (byte-compatible) | `explore/memory_hash.py` |
| `src/memory/store.ts` | Canonical tree, persisted drafts with base manifests, limits, stage-and-rename install, journal, history, content-addressed reports, freeze, crash recovery, serialized commits | `practice_loop._atomic_install_memory`, `commit.journal`, Phase 3 frozen-memory checks |
| `src/memory/audit.ts` | Optional 8-word shingle leakage tripwire; a hit quarantines the commit with a neutral message | `commit.silent_audit` |
| `src/roles/*.ts` | Epistemic core, memory preamble (inventory only), Actor / Verifier / Curriculum charters, runtime contracts, resume and stall messages, distillation, reconciliation, diagnosis | `core/actor.py`, `core/verifier_runtime.py`, `explore/charter.py` |
| `src/engine/converse.ts` | Same-context continuation: re-prompt the same context until it publishes a parseable handoff; three actionless segments are infrastructure; a ceiling bounds runaway contexts | `_run_handoff_phase` transport loop |
| `src/engine/fixtures.ts` | Fixture shape gate, private capture with manifest, byte-exact replay, read-only original-fixture view, infra attempts moved aside | `phase1_wave` fixture capture / replay, Phase 2 original-view |
| `src/engine/steps.ts` | `STATUS: SUBMIT` handoffs, CLAIM/PROBE leads as `NOT_RUN` LEAD blocks, one inspection, same-context learning (distill → reconcile → diagnosis → commit) | `_run_handoff_phase`, `loop.py` lead blocks, `_promote_learning` |
| `src/engine/lineage.ts` | Phase 1 waves (snapshot, barrier, serial learning, RSIAgent outcome texts); Phase 2 attempts with persistent Verifier, UNVERIFIED rounds, stall → forced inspection → resume (handoff or pivot), escalation route and Verifier swap; both stop policies; `result.json` | `phase1_wave.py`, `core/self_evolving_loop.py`, `unified_evolution.evolve_until_ready` |
| `src/engine/workspace.ts` | Project manifests, mechanical change context, discardable copies | `loop._surface_delta` |
| `src/host/channel.ts` | Parked-handoff channel that turns one sub-agent turn into a multi-message role context; `close()` concludes the turn | persistent `messages` lists per role |
| `src/host/registry.ts` | Per-child role context: binding, channel, read-only flag, actionless and stop counters | — |
| `src/host/subagent-runtime.ts` | `RoleRuntime` on `ctx.subagents.startActivation` (spawn provider, caller delivery, reserved child id, `toolFilter`, persona, model route); `start()` fallback for 0.2.0-rc.2 | fresh VM plus model client per role |
| `src/host/isolation.ts` | Isolation decision (`sandbox` / `rollback`), read-only sandbox pin at creation, private-path guard on file tools | Verifier VM with read-only candidate mount |
| `src/host/checkpoint.ts` | Workspace checkpoint (git-aware, bounded) and restore after an inspection | `_verify_candidate` rollback |
| `src/host/git.ts` | Hardened git invocations; interactive change facts excluding private state | `_surface_delta` |
| `src/host/stores.ts` | Per-project memory roots under `$DSH_HOME/rsi`, outside every workspace | per-run memory directory |
| `src/host/task-state.ts` | Interactive task state as a session projection folded from `tool/result` meta | Actor/Verifier loop state |
| `src/host/sealed.ts` | Sealed evaluation of a frozen candidate; the score never reaches an agent | official evaluator, `officialEvaluatorCalls = 0` during training |
| `src/index.ts` | Tools, prompt section, runtime-context inventory, projections, lifecycle hooks (isolation at `agent/created`, stall steering at `agent/turn-stopping`), commands | host harness |

## Authority boundaries

| Role | Can | Cannot |
|---|---|---|
| Actor | work with the harness's tools; read memory; write the **draft** during learning | change canonical memory directly; grade itself; delegate |
| Verifier | inspect the live candidate with read and execute tools inside a read-only sandbox (or under rollback); publish one verdict | see memory, Actor-private paths, the Actor's conversation, self-checks, or handoff narrative; write; delegate; use `verifier.denyTools` |
| Curriculum | build fixtures; read memory as evidence (unless `none`); keep private notes; choose the next experiment or the stop | write or approve memory; grade candidates; author solutions or checks |
| Host | capture and replay fixtures, checkpoint and restore candidates, commit memory at valid boundaries, run the sealed evaluator | turn infrastructure failures, readiness, or `STALLED` into a verdict |

## Invariants

1. **Memory is immutable during work.** Writes go to a draft opened from the current canonical tree. A draft whose base is no longer canonical is refused (`MemoryConflictError`); the interactive Actor relearns against current memory. Commits are serialized.
2. **Wave barrier.** No branch of a wave learns until every branch has a verdict. A branch whose runtime fails before a verdict gets one unscored restart (the failed attempt is moved aside); transport exhaustion or a second failure blocks the whole wave and no memory is merged.
3. **Infrastructure is unscored.** A context that never publishes a parseable handoff, three actionless segments, a child that ends abnormally, or a failed start raises `InfraError`. It is never PASS or FAIL and never commits memory; lineages record it in `result.json`.
4. **A FAIL teaches but never counts as success.** Both outcomes distill, and the outcome is recorded in the journal.
5. **Readiness is not correctness.** `READY_FOR_TARGET` returns control to the target; after any practice, a fresh target attempt is mandatory, also when the practice budget runs out. `STALLED` buys exactly one final target test.
6. **Verification has no lasting effects.** Every candidate is checkpointed before an inspection and restored if it changed (`VERIFIER_EFFECTS_ROLLED_BACK`); with `sandbox` isolation the Verifier cannot write at all.
7. **Sealed means sealed.** The evaluator runs only on a frozen candidate, from a human command, and its result is written to disk for the human.
8. **Model-visible ⟺ logged.** Every role exchange travels through tool results (`rsi_handoff`, `rsi_*`) or prompt contributions, so it appears in a dsh session log. Role children are ordinary dsh sessions and can be inspected.

## Why `rsi_handoff`

dsh sub-agents run one activation per prompt, and caller-delivery results return once. RSIAgent needs one context to span several harness-driven phases: the Actor works, waits for a verdict, gives evidence leads, distills, reconciles, and writes a diagnosis; the Verifier spans UNVERIFIED rounds; the Curriculum spans the whole lineage.

Each role therefore stays inside a single long turn and yields through a tool call that the engine resolves. When a role ends a segment without handing off, `agent/turn-stopping` steers it back into the same context; closing the channel resolves the pending call and concludes the turn without another model request. This changes nothing in `agent-loop`.
