# dsh-rsi

[English](README.md) | 中文

**面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的递归自我改进插件。** 它把 [RSIAgent](https://github.com/AetherLabsAI/RSIAgent)（arXiv:2609.15364）中与具体评测基准无关的机制移植成一个 dsh 插件 bundle：

- **执行者自有的经验记忆**：记录操作流程、可复用脚本、环境事实和失败教训。它按项目落盘；工作期间只读，只有在独立判定之后的学习阶段才能修改。
- **独立的验证者智能体**：一个全新的子智能体，只看到用户的原话请求和 harness 采集的变更事实，看不到执行者的推理、自检和记忆，然后给出 `PASS` / `FAIL` / `UNVERIFIED`。
- **课程智能体驱动的探索**：Phase 1 广度探索（按波次）和 Phase 2 深度探索（以目标为条件），对应论文中的 BRS / DRS。
- **冻结模式**：对应论文 Phase 3 的测试期复用。记忆只读，不再学习。

模型参数始终不变，能力的提升全部来自被验证过的经验，并通过记忆跨任务传递。

## 工作方式

### 日常任务（交互模式）

主智能体就是执行者，插件会把 RSI 协议加入它的系统提示，把记忆清单（只有文件名和大小）放进运行时上下文。

```
用户任务 → 执行者完成工作（读取记忆作为提示）
        → rsi_submit：启动全新的验证者子智能体
              它只看到最近几条用户原话和 git 变更事实，看不到执行者的推理、自检和记忆
        → PASS / FAIL（附报告，执行者据此修复后再提交）/ UNVERIFIED（要求可复现的证据）
        → rsi_learn：打开学习阶段（草稿是当前记忆的副本）
        → rsi_memory_write / rsi_memory_delete：蒸馏
        → rsi_memory_commit（第一次）：对整个记忆库做调和
        → rsi_memory_commit（第二次）：原子提交，写入日志，并记录前后两次的树哈希
```

### 探索谱系（`rsi_explore`）

| phase | 论文阶段 | 流程 |
|---|---|---|
| `broad` | Phase 1 · BRS | 课程智能体按波次编写彼此独立的练习项目。同一波的分支都从同一份记忆快照出发，各自由全新的执行者完成、全新的验证者判定。整波都拿到判定后（**波次屏障**），各执行者在自己原来的上下文里，按编写顺序**串行**蒸馏并提交，每次都基于最新的记忆。 |
| `deep` | Phase 2 · DRS | 一个全新的执行者尝试一个不变的目标。无论 PASS 还是 FAIL，都由同一个执行者学习，并给课程智能体写一份学习诊断。课程智能体随后选择练习，直到判断 `READY_FOR_TARGET` 或 `STALLED`。只要中途做过练习，就必须用全新的上下文重试原目标。 |
| — | Phase 3 | 在配置里设 `mode: frozen`，或者执行 `/rsi-freeze`。 |

停止策略：

- `curriculum_review`（默认）：目标 PASS 之后，课程智能体仍可以要求更多练习。
- `verifier_pass`：目标 PASS 并提交记忆后立即停止。
- 基础设施故障永远不会被当作 PASS 或 FAIL，也不会触发记忆提交。

### 角色上下文如何在 dsh 中保持连续

每个角色（执行者、验证者、课程智能体）都是一个子智能体，通过 `ctx.subagents.startActivation` 启动：

- 使用 `spawn` provider，不继承父对话；
- 结果直接返回给调用方，不通知父模型；
- 子智能体 ID 预先保留。

角色需要"交接"时会调用 `rsi_handoff(text)`。这个工具调用会一直挂起，直到引擎发出下一条消息，那条消息就是工具的返回结果。这样，同一个执行者能在同一个上下文里完成工作、等待判定、蒸馏和调和，与 RSIAgent 要求的同上下文学习一致。Phase 1 的波次屏障也靠它实现：各分支挂起在交接点上，等全部分支验证完再依次放行。

## 安装

需要 Node `^22.19 || >=24`，以及 dsh `0.2.1-alpha.x`（dsh 的 API 仍处于 pre-stable 阶段）。

```sh
# 从本地检出安装
git clone https://github.com/mutsuki14/dsh-rsi && cd dsh-rsi
pnpm install && pnpm run build
dsh plugin --profile web add "$PWD"

# 或者直接从 GitHub 安装（会运行 prepare 构建，需要在 profile 的 pnpm-workspace.yaml 里允许）
#   allowBuilds:
#     dsh-rsi: true
dsh plugin --profile web add github:mutsuki14/dsh-rsi#<commit>

dsh --profile web --dump-config | grep -A6 '== dsh-rsi'   # 确认 bundle 层已组合进去
dsh web                                                   # 或者 dsh headless "任务"
```

## 工具

| 工具 | 谁用 | 作用 |
|---|---|---|
| `rsi_memory_list` / `rsi_memory_read` / `rsi_memory_search` | 执行者、课程智能体 | 查看记忆（学习阶段看到的是草稿） |
| `rsi_memory_write` / `rsi_memory_delete` | 执行者，仅限学习阶段 | 编辑草稿 |
| `rsi_submit` | 主执行者 | 请求独立验证；UNVERIFIED 之后可以附上 `evidence_leads` |
| `rsi_learn` | 主执行者 | 拿到终局判定后打开学习阶段 |
| `rsi_memory_commit` | 主执行者 | 第一次调用进入调和，第二次调用原子提交 |
| `rsi_explore` | 主执行者 | 运行 `broad` / `deep` 探索谱系（前台运行，阻塞到结束） |
| `rsi_handoff` | 角色子智能体 | 向引擎交接，并等待下一条消息 |

验证者看不到任何记忆工具，也看不到 `verifier.denyTools` 里列出的写文件工具（默认是 `write` 和 `edit`）。

命令：

- `/rsi`：查看记忆状态。
- `/rsi-freeze`：冻结记忆。
- `/rsi-unfreeze`：解除冻结，解除前会先校验冻结时记录的树哈希。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖。注意：覆盖会**整体替换** `config`，需要把所有要设置的键都写全。

```yaml
- id: dsh-rsi
  name: dsh-rsi
  config:
    mode: learn                # frozen = Phase 3 测试期复用
    stateDir: .dsh-rsi         # 相对于会话的原始工作目录
    subagentProvider: spawn
    roles:                     # 可选：给验证者换一个模型，增强独立性
      verifier: { provider: deepseek, model: deepseek-pro }
    verifier:
      allowUnverified: true
      taskMessages: 3          # 交给验证者的最近几条用户原话
      denyTools: [write, edit]
    exploration:
      maxWaveProjects: 4
      waveConcurrency: 1
      broadProjectBudget: 12   # 只在波次边界检查
      deepPracticeBudget: 6
      targetCycleBudget: 4
      stopPolicy: curriculum_review
    audit:
      sealedTexts: []          # 记忆中不得出现的封存材料（例如留出的评测题）；按 8 词 shingle 匹配，命中则整个提交作废
```

完整字段见 [`src/config.ts`](src/config.ts)。

## 落盘布局

```
<项目>/.dsh-rsi/
  memory/            规范记忆树（执行者自有，结构不限）
  drafts/<episode>/  学习阶段的草稿
  journal.jsonl      只追加的提交记录：episode、种类、结果、前后树哈希、增删改
  history/NNNN/      每次提交后的完整快照（memory.keepHistory）
  frozen.json        冻结标记，带有冻结时的树哈希
  lineages/<id>/     探索谱系：events.jsonl、result.json，以及每个练习项目的 project/ 目录
```

树哈希与 RSIAgent 的 `tree_sha256` 逐字节一致（有单元测试覆盖）。可以把 `.dsh-rsi/memory` 提交进 git 与团队共享，也可以把整个 `.dsh-rsi/` 加进 `.gitignore`。

## 与 RSIAgent 的差异

- **验证者隔离**：
  - 练习项目和目标项目：验证者检查之前，先给候选目录打检查点；检查之后如果候选目录被改动，就回滚到检查点。
  - 交互任务：只能检测到工作区被改动，无法回滚。验证者看不到写文件工具，但 `bash` 仍然可能改动文件。
- **交互模式的验证者**：每次检查都启动一个新的上下文，并带上它自己此前发布过的报告，不保持同一个活着的上下文。
- **课程智能体**：不会在单独的机器上构建练习用的初始文件。练习项目的指令只描述输入，项目放在 `.dsh-rsi/lineages/` 下。
- **没有封存的官方评测器**：这在 dsh 场景里不适用。泄漏审计可以选择开启。
- **兜底**：如果某个角色子智能体没有调用 `rsi_handoff` 就自己结束了回合，会用完整的交接记录重放出一个新的上下文，并记录 `ROLE_CONTEXT_REPLAYED` 事件。
- **进程重启**：交互任务的学习阶段状态只保存在进程内存里，重启后未提交的草稿会被丢弃，规范记忆不受影响。

更细的映射见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm run test     # 单元测试，以及基于真实 agent loop、子智能体管理器和 spawn provider 的集成测试
pnpm run e2e      # 离线端到端：真实的 dsh headless 加上 scripts/mock-deepseek.mjs
```

`src/engine/` 和 `src/memory/` 不依赖 harness，可以通过 `dsh-rsi/engine` 在其他运行时里复用：实现 `RoleRuntime` 接口即可。

## 许可

Apache-2.0。角色提示词和协议改写自 RSIAgent（Apache-2.0），详见 [NOTICE](NOTICE)。
