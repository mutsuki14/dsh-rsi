# dsh-rsi

[English](README.md) | 中文

**面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的递归自我改进插件。** 它把 [RSIAgent](https://github.com/AetherLabsAI/RSIAgent)（arXiv:2609.15364）中与具体评测基准无关的机制移植成一个 dsh 插件 bundle：

- **执行者自有的经验记忆**：记录操作流程、可复用脚本、环境事实和失败教训。它按项目存放在工作区之外；执行者工作期间只读，只有在独立判定之后的学习阶段才能修改。
- **独立且副作用隔离的验证者智能体**：一个被固定在 dsh 只读沙箱里的子智能体。它只看到用户的原话请求和 harness 采集的变更事实，看不到执行者的推理、自检和记忆，然后给出 `PASS` / `FAIL` / `UNVERIFIED`。
- **课程智能体驱动的探索**：Phase 1 广度探索（按波次）和 Phase 2 深度探索（以目标为条件），对应论文中的 BRS / DRS。每个练习项目的输入文件由课程智能体构建，harness 按字节采集并回放。
- **冻结模式与封存评测**：对应论文 Phase 3 的测试期复用；可选的宿主侧评测器，其结果永远不会到达任何智能体。

模型参数始终不变，能力的提升全部来自被验证过的经验，并通过记忆跨任务传递。

## 工作方式

### 日常任务（交互模式）

主智能体就是执行者。插件会把 RSI 协议加入它的系统提示，把记忆清单（只有文件名和大小）放进运行时上下文。

```
用户任务 → 执行者完成工作（读取记忆作为提示）
        → rsi_submit：先给候选结果打检查点，再由隔离的验证者子智能体检查实时结果
              它只看到最近几条用户原话和 git 变更事实
        → PASS / FAIL（附报告，执行者据此修复）/ UNVERIFIED（要求 CLAIM/PROBE 证据线索）
              —— 同一个回合内，同一个验证者上下文检查每一次修订
        → rsi_learn：打开学习阶段（草稿是当前记忆的副本）
        → rsi_memory_write / rsi_memory_delete：蒸馏
        → rsi_memory_commit（第一次）：对整个记忆库做调和
        → rsi_memory_commit（第二次）：原子提交，写入日志，并记录前后两次的树哈希
```

任务状态（验证者代数、报告引用、判定、学习阶段）是一个**会话投影**，由 dsh 会话日志里的工具结果折叠而来；草稿和报告存放在磁盘上。所以学习阶段可以跨进程重启或会话恢复继续进行。

### 探索谱系（`rsi_explore`，需要 dsh ≥ 0.2.1-alpha.2）

| phase | 论文阶段 | 流程 |
|---|---|---|
| `broad` | Phase 1 · BRS | 课程智能体按波次编写彼此独立的练习项目，并为每个项目构建输入文件树。harness 检查文件树形状，私下采集，再回放到全新的项目根目录。同一波的分支都从同一份记忆快照出发，各自由全新的执行者完成、全新的验证者判定。整波都拿到判定后（**波次屏障**），各执行者在自己原来的上下文里，按编写顺序**串行**蒸馏，每次都基于最新的记忆。 |
| `deep` | Phase 2 · DRS | 一个全新的执行者尝试一个不变的目标（可选回放 `target_fixtures`）。FAIL 是这次尝试的终局；UNVERIFIED 会让同一个执行者提供证据线索。连续多次 UNVERIFIED 或执行者不再行动，会让尝试进入停滞：先做一次强制检查，然后带着工作日志在全新上下文里续跑（可选换到升级模型，同时把验证者换成执行者原来的模型）。同一个执行者负责蒸馏、调和，并给课程智能体写学习诊断，之后才提交记忆。课程智能体随后选择练习（带输入文件，练习验证者还能看到原始输入的只读视图），直到判断 `READY_FOR_TARGET` 或 `STALLED`。只要做过练习，就必须用全新上下文重试原目标，练习预算耗尽时也一样。 |
| — | Phase 3 | 在配置里设 `mode: frozen`，或者执行 `/rsi-freeze`。`/rsi-eval <谱系>` 运行配置好的封存评测器。 |

停止策略：

- `curriculum_review`（默认）：目标 PASS 之后，课程智能体仍可以要求更多练习。
- `verifier_pass`：目标 PASS 并提交记忆后立即停止。
- 基础设施故障永远不会被当作 PASS 或 FAIL，也不会提交记忆，会以 `infra` 或 `quarantined` 记录在谱系的 `result.json` 里。

### 角色上下文如何在 dsh 中保持连续

每个角色（执行者、验证者、课程智能体）都是一个子智能体，通过 `ctx.subagents.startActivation` 启动：

- 使用 `spawn` provider，不继承父对话；
- `caller` 交付，结果直接返回给插件，不通知父模型；
- 子智能体 ID 预先保留，创建钩子可以在它第一步之前完成隔离；
- 工具过滤器移除所有委派工具（`subagent`、`workflow`、`send_message` 等）以及交互模式的 RSI 工具。

角色需要交接时会调用 `rsi_handoff(text)`。这个工具调用一直挂起，直到引擎发出下一条消息，那条消息就是工具的返回结果；关闭上下文时它会被解开，并直接结束回合，不再调用模型。没有交接就结束的片段会被引导回**同一个**上下文继续（RSIAgent 的同上下文续写）。连续三个没有任何工具动作的片段会把该上下文判为不计分的基础设施故障，与 RSIAgent 一致；没有固定的重试次数。

## 安装

需要 Node `^22.19 || >=24`，以及 dsh `0.2.0-rc.2`（`npx @deepseek-ai/dsh` 默认安装的版本）或 `0.2.1-alpha.x`（≥ alpha.2）。探索谱系需要 alpha 线。

```sh
# 从本地检出安装
git clone https://github.com/mutsuki14/dsh-rsi && cd dsh-rsi
pnpm install && pnpm run build
dsh plugin --profile web add "$PWD"

# 或者直接从 GitHub 安装（会运行 prepare 构建，需要在 profile 的
# pnpm-workspace.yaml 里允许：allowBuilds: { dsh-rsi: true }）
dsh plugin --profile web add github:mutsuki14/dsh-rsi#<commit>

dsh --profile web --dump-config | grep -A6 '== dsh-rsi'   # 确认 bundle 层已组合进去
dsh web                                                   # 或者 dsh headless "任务"
```

## 工具

| 工具 | 谁用 | 作用 |
|---|---|---|
| `rsi_memory_list` / `rsi_memory_read` / `rsi_memory_search` | 执行者、课程智能体（除非 `curriculumMemoryAccess: none`） | 查看记忆（学习阶段看到的是草稿） |
| `rsi_memory_write` / `rsi_memory_delete` | 执行者，仅限学习阶段 | 编辑草稿 |
| `rsi_submit` | 主执行者 | 请求独立验证；UNVERIFIED 之后传入 `evidence_leads`（claim + probe 对） |
| `rsi_learn` | 主执行者 | 拿到终局判定后打开学习阶段 |
| `rsi_memory_commit` | 主执行者 | 第一次调用进入调和，第二次调用原子提交 |
| `rsi_explore` | 主执行者 | 运行 `broad` / `deep` 探索谱系（前台运行，阻塞到结束） |
| `rsi_handoff` | 角色子智能体 | 向引擎交接，并等待下一条消息 |
| `rsi_notes` | 课程智能体 | 替换它私有的搜索笔记（执行者和验证者永远看不到） |

验证者没有记忆工具、没有委派工具，也没有 `verifier.denyTools` 里列出的工具（默认 `write`、`edit`、`web_fetch`、`web_search`）。

命令（仅供人使用，命令结果不会进入模型）：

- `/rsi`：记忆位置、隔离模式、记忆清单、任务状态、最近的提交。
- `/rsi-freeze` 和 `/rsi-unfreeze`：冻结记忆；解除冻结前会先校验冻结时记录的树哈希。
- `/rsi-eval <谱系>`：对一个已结束的 deep 谱系做封存评测。

## 验证者隔离

`verifier.isolation`（默认 `auto`）：

- `sandbox`：验证者子智能体在创建时、第一步之前就被固定在 dsh 的 `read-only` 沙箱模式。它的文件工具、bash、后台任务、终端和 `run_code` 都无法写入任何位置，提权请求会被拒绝；执行者保持自己的策略。文件工具还会拒绝访问执行者私有路径。如果 profile 没有沙箱策略，或者当前 dsh 版本无法预留子智能体 ID，会直接报错。
- `rollback`：验证者可以写，harness 事后恢复候选结果。
- `auto`：可用时用 `sandbox`，否则用 `rollback`。

在所有模式下，交互任务的候选结果（已跟踪文件，以及未跟踪且未被忽略的文件）都会在检查前打检查点，若被改动则恢复；练习和目标项目的根目录也以同样方式复制和恢复。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖。注意：覆盖会**整体替换** `config`，需要把所有要设置的键都写全。

```yaml
- id: dsh-rsi
  name: dsh-rsi
  config:
    mode: learn                # frozen = Phase 3 测试期复用
    stateDir: .dsh-rsi         # 工作区内的目录，只存放谱系的项目根目录
    memoryDir: ''              # '' = $DSH_HOME/rsi/<项目>-<哈希>，在工作区之外
    subagentProvider: spawn
    roles:                     # 可选的模型路由；验证者换一个模型可以增强独立性
      verifier: { provider: deepseek, model: deepseek-pro }
      escalation: { provider: deepseek, model: deepseek-pro }
    verifier:
      isolation: auto          # sandbox | rollback | auto
      allowUnverified: true
      taskMessages: 3          # 交给验证者的最近几条用户原话
      denyTools: [write, edit, web_fetch, web_search]
    transport:
      actionlessLimit: 3       # RSIAgent：三个没有动作的片段视为基础设施故障
      ceiling: 24              # 紧急上限，不是重试次数
    exploration:
      waveCeiling: 16          # 宿主容量；课程智能体在此之下自行决定波次宽度
      waveConcurrency: 1
      broadProjectBudget: 12   # 只在波次边界检查
      deepPracticeBudget: 6    # 紧急上限；练习之后一定会有一次全新的目标测试
      targetCycleBudget: 6
      unverifiedRounds: 3      # RSIAgent 的 max_consec_done
      targetResumes: 1
      stopPolicy: curriculum_review
      curriculumMemoryAccess: read_only   # 或 none（RSIAgent 的消融设置）
    evaluation:
      command: []              # 例如 [python3, /abs/path/grade.py]；最后一行输出 {"score": n}
      timeoutSec: 900
    audit:
      sealedTexts: []          # 记忆中引用这些材料（按 8 词 shingle 匹配）会被静默隔离
```

完整字段见 [`src/config.ts`](src/config.ts)。

## 落盘布局

```
$DSH_HOME/rsi/<项目>-<哈希>/     （memoryDir；不在任何角色的工作目录之内）
  memory/                 规范记忆树（执行者自有，结构不限）
  drafts/<episode>[.json] 学习阶段的工作副本及其元数据
  journal.jsonl           只追加的提交记录：episode、种类、结果、前后树哈希、增删改
  history/NNNN/           每次提交后的完整快照（memory.keepHistory）
  reports/<sha256>.md     按内容寻址的验证报告，读取时重新校验哈希
  frozen.json             冻结标记，带有冻结时的树哈希
  lineages/<id>/          events.jsonl、result.json、curriculum_notes.md、输入文件采集、波次快照
  sealed/<id>/<run>/      封存评测（候选副本、任务、evaluation.json）
<项目>/.dsh-rsi/lineages/<id>/   练习和目标项目的根目录（角色在这里工作）
```

树哈希与 RSIAgent 的 `tree_sha256` 逐字节一致（有单元测试覆盖）。

## 与 RSIAgent 仍然存在的差异

这些差异来自 dsh 目前提供的能力；逐条写明，不夸大实际效果。

- **沙箱模式下的验证者没有私有的可写临时目录。** dsh 的只读模式没有额外的可写根，所以验证者连 `/tmp` 都不能写（RSIAgent 的练习验证者同样如此），而 RSIAgent 的目标验证者另有一个私有的 `VERIFIER_SCRATCH` tmpfs。验证需要写入时请使用 `rollback` 隔离。
- **读取隐藏、网络和进程隔离不是机械保证的。** dsh 只限制写入。文件工具会拒绝执行者私有路径，这些路径也在工作区之外且从不披露，但刻意构造的 `bash` 仍可能读到它们、访问本地服务或给其他进程发信号；RSIAgent 用的是命名空间。
- **交互模式下验证者的连续性只持续一个主智能体回合。** dsh 宿主会在回合边界等待子智能体结束，所以活着的上下文在那里关闭；下一个回合会由一个全新的上下文接着它自己发布过的报告继续。谱系里的验证者则在整个尝试期间保持存活。
- **证据线索标记为 `NOT_RUN`。** harness 会转发 CLAIM/PROBE 对，但不执行它们；RSIAgent 会运行执行者已验证过的检查来给线索分类。
- **记忆冲突时要求重新学习。** 如果草稿打开之后规范记忆被改动，草稿会被丢弃，执行者基于当前记忆重新学习；RSIAgent 的恢复路径则直接拒绝。
- **探索谱系在进程重启后不能恢复**；交互模式的学习阶段可以。
- **在 dsh 0.2.0-rc.2 上**，`rsi_explore` 会被拒绝（角色子智能体无法在自己的项目根目录启动），验证者隔离为 `rollback`。

每个 RSIAgent 机制在本项目中的实现位置见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm run test     # 单元测试，以及基于真实运行时的测试（agent loop、子智能体、沙箱栈、重启恢复）
pnpm run e2e      # 离线端到端：真实的 dsh headless 加上 scripts/mock-deepseek.mjs

# 按 CI 的方式测试 0.2.0-rc.2 线
node scripts/use-dsh.mjs 0.2.0-rc.2 && pnpm install --no-frozen-lockfile
pnpm run typecheck:legacy && DSH_LEGACY=1 pnpm run test && DSH_VERSION=0.2.0-rc.2 pnpm run e2e
```

`src/engine/` 和 `src/memory/` 不依赖 harness，可以通过 `dsh-rsi/engine` 在其他运行时里复用：实现 `RoleRuntime` 接口即可。

## 许可

Apache-2.0。角色提示词和协议改写自 RSIAgent（Apache-2.0），详见 [NOTICE](NOTICE)。
