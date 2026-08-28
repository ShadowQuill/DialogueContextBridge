# 架构与设计决策

> DialogueContextBridge（对话上下文桥接）Phase 1：把一次对话的「已了解信息」编译为可移植的三层快照，落库到本地 SQLite（FTS5），并支持关键词检索。

本文档说明整体架构、分层边界与关键设计取舍。Phase 1–4 均已在此架构上落地，本文 §7 记录各阶段的接缝与实现要点。

---

## 1. 问题域

DeepSeek 等智能体在复杂、长期项目（软件开发、学术研究、产品设计）中经常跨多个对话会话工作。当前每次新对话都要重新介绍背景，导致：

- **效率低下**：反复手动复制粘贴历史上下文；
- **信息丢失**：关键决策、代码、偏好在摘要中丢失；
- **体验割裂**：长期项目的连续性被打断。

核心思路：把某次对话的「已了解信息」打包为一个**可移植的知识单元**，在新对话里一键引入，且保证**关键信息零丢失**。

---

## 2. 三层快照模型

快照被设计为一个**结构化复合体**，而非对话日志的平铺转储。三层分别是：

| 层 | 文件中的标记 | 承载内容 | 压缩程度 |
| --- | --- | --- | --- |
| ① 原文层（verbatim） | `<!-- dcb:layer:verbatim -->` | 不可压缩、需精确复现的内容：敲定的代码片段、关键决策结论、具体技术参数、硬性指令 | 不压缩，逐字保留 |
| ② 摘要层（summary） | `<!-- dcb:layer:summary -->` | 冗长讨论背景、推理推导、中间试错、已排除方案，压缩为层级分明的要点 | 高度压缩 |
| ③ 偏好层（preference） | `<!-- dcb:layer:preference -->` | 风格偏好（「代码加详细注释」）、角色设定（「你是资深架构师」）、项目约束（「必须兼容 Python 3.8」） | 抽取为 `(scope, key, value)` 三元组 |

> **为什么分三层？** 原文层保证「原子级细节不丢」，摘要层承载「来龙去脉」，偏好层为 Phase 3 的冲突消解提供**稳定的键（key）**——当新旧信息出现矛盾时，引擎可依据 `scope+key` 判定「这是同一条偏好，按裁决规则取舍」，而不必做脆弱的文本相似度比对。

### 偏好键的稳定性

偏好条目形如 `(scope, key, value, explicit)`，其中：

- `scope ∈ {style, role, constraint}`
- `key` 是**稳定、归一化**的标识（例如 `comment-style`、`persona`、`min-python`）；
- `explicit` 标记是用户明言还是系统推断。

同一 `(scope, key)` 的多次出现，编译时按「后写覆盖先写、显式覆盖隐式」归并——这是未来「合并模式」消歧的基础。

---

## 3. 工作流（Phase 1 闭环）

```
┌─────────────────┐   /compile    ┌──────────────────┐
│  源对话消息流    │ ───────────▶  │  编译草稿(内存)   │
│ (Conversation)  │              │ 三层快照 + 预览   │
└─────────────────┘              └────────┬─────────┘
                                          │ /save （用户确认）
                                          ▼
                                  ┌──────────────────┐
                                  │  SQLite + FTS5    │
                                  │  (本地 ~/.dsh)    │
                                  └────────┬─────────┘
                                          │ /snapshot-search
                                          ▼
                                  ┌──────────────────┐
                                  │  关键词检索结果    │
                                  └──────────────────┘
```

- **编译（/compile）**：对当前会话全部消息做语义扫描与结构化提取，产出三层快照草稿，**仅驻留内存**，不写盘。设计上刻意与 `/save` 分离——快照一旦落库就可能被其他对话引入，必须用户确认内容后再持久化。
- **保存（/save）**：把草稿写入本地数据库，并**同步 FTS5 索引**。配置 `autoSave: true` 可让 `/compile` 自动落库。
- **检索（/snapshot-search）**：优先走 FTS5 `MATCH`（带 bm25 列权重：标题 > 描述 > 标签 > 摘要 > 偏好 > 原文）；当关键词因 trigram 长度限制无法构造 MATCH 时，自动回退到 `LIKE` 扫描，保证「搜两个汉字」不会直接返回空。

---

## 4. 技术栈与约束

| 维度 | 选型 | 理由 |
| --- | --- | --- |
| 语言 | TypeScript（strict） | DSH 插件生态标准 |
| 框架 | Cordis（DSH 底层框架） | `apply(ctx, config)` 生命周期、服务注入、配置热更新 |
| 配置 | schemastery | 声明式 Schema → DSH 设置面板自动渲染表单 |
| 数据格式 | Markdown + 自描述 Schema 头 | 人类可读、可手工编辑、任何能读文本的 Agent 可接手 |
| 存储 | SQLite（FTS5） | 本地化、零依赖服务、全文检索 |
| 加解密 | AES-256-GCM | 静态加密 + 加密擦除（cryptographic erasure） |
| 风格 | 函数式优先（工厂函数替代 class） | 见 §6 |

---

## 5. 关键设计决策

### 5.1 FTS5 分词器：trigram 优先

- `unicode61` 不对中文分词，会把整段中文当成一个 token，中文关键词检索几乎不可用；
- `trigram` 以 3 字符滑窗建索引，天然支持中文子串匹配；
- 因此在 `detectTokenizer()` 中优先探测 `trigram`，仅当 SQLite 版本过低（< 3.34）时回退 `unicode61`；
- 配套地，`toMatchExpression()` 对 trigram 要求词项长度 ≥ 3，短词直接返回 `undefined` 由调用方回退 `LIKE`，避免 FTS 抛出异常。

### 5.2 token 预算裁剪

- 默认 `maxTokens = 4096`，可配置扩展至 8192（config 上限 32768）；
- 裁剪按**优先级**保序：指令（directive）> 决策（decision）> 代码（code）> 参数（parameter）；
- 偏好层占预算封顶 20%，防止偏好条目挤占原文/摘要空间；
- `budget.ts` 在序列化前对三层内容做裁剪，并返回裁剪报告（被丢弃了什么、原因），便于用户复核。

### 5.3 加密与索引的张力

加密存储时，落库正文是密文（`dcb1.` 信封格式）。此处存在一个**安全性与可检索性的根本权衡**：

- 默认 `encryption.indexPlaintext = false`：不写明文索引 → 密文快照**不可被全文检索**，但绝不泄漏内容；
- 仅当用户明确理解风险并开启 `indexPlaintext` 时，才额外写入明文摘要字段供检索。

这是有意的「安全默认」，索引写入与否由 `service.persist()` 依据 `shouldIndex` 决定，仓储层据此判断是否调用 `extractIndexText()`。

### 5.4 校验和（checksum）机制

- 序列化时先用 `checksum(body)` 重算正文摘要并写入 Schema 头；
- 解析/读取时 `verifySnapshotDocument()` 重新校验，检测传输或磁盘腐坏；
- 因此「快照被手工编辑后内容是否与校验和一致」可被直接判定——这是「用户可编辑、AI 不自动学习」约束的技术保障。

---

## 6. 模块边界与扩展接缝

```
src/
├── core/        # 与宿主完全解耦的纯逻辑（可在纯 Node 下单测）
│   ├── lexicon.ts      # 语义识别词典（VERBATIM_RULES / PREFERENCE_RULES / SUMMARY_BUCKETS）
│   ├── classifier.ts   # 消息 → 三层分类
│   ├── summarize.ts    # 摘要器契约 Summarizer 与内置抽取式实现（可注入 LLM 实现）
│   ├── llm-summarizer.ts # 基于 LLM 的摘要器：LlmSummarizeClient 抽象 + 输出解析 + 失败回退
│   ├── budget.ts       # token 预算裁剪
│   ├── serializer.ts   # Markdown + Schema 头 序列化/解析
│   └── compiler.ts     # /compile 完整流水线（编排以上纯逻辑）
├── storage/     # SQLite + FTS5（可替换为其他 KV/FTS 后端）
├── security/    # AES-256-GCM 封装
├── dsh/         # 宿主能力的「类型接缝」：最小接口 + 模块增强挂到 Cordis Context
│   ├── types.ts  # 命令注册 / 会话读取 / 上下文注入 适配（对齐 dsh 0.1.1-rc.2）
│   └── llm.ts    # 把宿主 ctx.llm 适配为 LlmSummarizeClient 摘要后端
├── commands/    # 命令层（仅此层依赖宿主）
├── service.ts   # 编译→预览→落库→检索的编排层（对外暴露 BridgeService）
├── config.ts    # schemastery 配置 Schema
└── index.ts     # Cordis 插件入口
```

**函数式优先**：除必要的 DI/状态闭包外，模块以**工厂函数**暴露能力（如 `createSnapshotRepository`、`createBridgeService`、`createCipher`）。这样既拿到「实例状态」的收益（预编译语句、草稿缓存），又避免继承与 `this` 语义；ESLint 中 `no-restricted-syntax` 禁用 `ClassDeclaration` 强制这一约束。

**宿主解耦**：核心逻辑（编译/存储/加密）不直接依赖 DSH。命令注册与对话读取才经由 `src/dsh/types.ts` 的**最小接口接缝**——核心代码在纯 Node 下即可单测（见 `tests/`）。宿主 API 变更时只需改这一个文件与命令层的适配代码。

---

## 7. Phase 2 / Phase 3 的扩展点

本骨架已为后续阶段预留接缝：

- **导入注入（Phase 2）**：复用 `parseSnapshot` + `verifySnapshotDocument` 还原快照对象；新增命令读取历史快照并封装进新对话上下文头部（「仅新信息」模式）。
- **智能融合（Phase 3）**：基于本文 §2 的**偏好稳定键**与三层结构的时间戳，实现新旧信息的语义比对与冲突裁决；偏好层支持可配置规则（`newWins` / `snapshotWins` / `timestamp`），裁决清单写入简报「冲突裁决报告」。
- **摘要器可替换**：`compiler.ts` 接受可选的 `summarize` 实现，可注入宿主 LLM 以产出更高质量的摘要层。
- **存储可替换**：`storage/` 通过 `DatabaseHandle` 抽象，未来可换成远程/加密 KV。

### 7.1 Phase 2 / Phase 3 落地情况

导入注入与智能融合均已实现，核心接缝如下：

- **宿主侧 `InjectionService`**（`src/dsh/types.ts`）：宿主通过 `ctx.injector` 提供系统提示注入能力，将背景简报封装进新对话上下文头部；缺失时命令层用 `createSessionInjector` 降级为以消息形式下发（简报本身已带只读标记，语义上仍不回写快照）。
- **纯函数渲染层 `src/core/inject.ts`**：
  - `buildInjectBrief(snapshot)` —— 「仅新信息」模式：把三层结构渲染为带 `<!-- dcb:import mode=inject -->` 标记的只读背景简报，正文分「原文 / 摘要 / 偏好」三节，并声明「新对话产出不回写快照」。
  - `fuseSnapshots(base, overlay, policy)` —— 「合并」模式融合引擎：
    - 偏好层按 `scope+key` 稳定键去重；发生**值冲突**时按 `policy` 裁决（`resolvePreference` 给出依据 `reason`），冲突清单写入返回的 `conflicts`；
    - 原文层取并集并按内容近似去重（折叠重复结论）；
    - 摘要层按 `heading` 合并小节，同一小节要点取并集去重。
    - 原文与摘要属于「可叠加」内容，**不参与裁决**——真正的取舍留给人（新对话）判断。
  - `buildMergeBrief(base, overlay, policy?)` / `renderMergeBrief(...)` —— 把融合结果渲染为带「冲突裁决报告」（Markdown 表格：键 / 历史 / 当前 / 裁决结果 / 依据）的简报，头部用 `<!-- dcb:import mode=merge policy=... -->` 标注。
  - `buildBrief(snapshot, mode, current?, policy?)` —— 统一入口，按 `mode` 选择上述两种渲染，`current` 缺省时 `merge` 退化为 `inject`，结果含 `conflictCount`。
- **命令 `/import`**：`/import <snapshotId> [--mode inject|merge] [--policy snapshotWins|newWins|timestamp] [--dry-run]`。默认「仅新信息」；`--dry-run` 仅预览简报不注入；`merge` 从当前对话 `history` 取消息现场编译后融合；`policy` 缺省时读取配置项 `merge.policy`（默认 `newWins`）。`service.buildImport()` 只做渲染与编排，注入副作用完全交给命令层，保持服务可单测。
- **编辑权边界**：注入的简报为只读背景，新对话的任何产出都不会反向写入历史快照；用户仍可通过 `/snapshot-show` / `/snapshot-remove` 编辑、删除记忆内容，AI 不会自动学习。冲突裁决报告仅作提示，用户随时可用新指令人工覆盖。

### 7.2 Phase 4 落地情况：记忆库版本控制与一键入口

- **Git 运行器抽象 `src/versioning/git.ts`**：`GitRunner` 接口（`run(args)`）把「对数据目录执行 git 子命令」抽象为可注入能力。`createCliGitRunner(cwd)` 用 `execFile` 调用真实 git（带 `--no-pager` 与 `core.quotepath=false`，中文文件名/信息不转义）；`createMemoryGitRunner(cwd)` 是无需 git 二进制的忠实内存模型——`add` 时从真实文件系统读取文件内容，提交/历史/读取都在内存维护，便于单测。
- **版本控制控制器 `src/versioning/store.ts`**：`createVersioningController({ dataDir, git, enabled })`。
  - `recordSave(id, markdown)` 把快照 Markdown 写入 `<dataDir>/<id>.md` 并 `git add` + `git commit`；
  - `recordRemove(id)` 用 `git rm` 删除文件并提交删除；
  - `history(id)` 解析 `git log --pretty=format:%H%x1f%ad%x1f%s --date=short` 返回版本列表（最新在前）；
  - `readAtRef(id, ref)` 用 `git show <ref>:<file>` 取指定版本内容；
  - `enabled=false` 时全部 no-op。
  - **设计取舍**：被版本化的是快照 Markdown **明文**（本插件自描述的可移植知识单元），而非 SQLite 二进制——明文才有意义的 diff/回滚，且 SQLite 加密时是运行时索引。因此若要求历史也不落明文，应关闭本功能；这是一处明确的安全权衡，由 `versioning.enabled` 决定。
- **服务层接入 `src/service.ts`**：`compileAndSave` 在落库后**await** `versionSave`（保证版本与落库一致）；`saveDraft` 与 `remove` 为 best-effort（失败只告警，不阻断落库）。新增 `history(snapshotId)` 与 `rollback(snapshotId, ref)`——回滚从 git 取回旧版本 Markdown，重新 `parseSnapshot` + 落库，并把这次回滚自身也记一笔版本，历史可继续追溯。
- **命令**：`/snapshot-history <id>`、`/snapshot-rollback <id> [--to <ref>]`（`--to` 省略时回滚到上一个版本）、`/dcb <id>`（一键 inject 导入别名）；设置面板经 Schemastery `Config` 热改集成，无需重启。
- **仓库隔离**：git 仓库独立放在数据目录下的 `snapshots/` 子目录，避免把 SQLite 二进制也纳入版本历史。

> 本插件可基于现有 DSH 插件生态开发，复用 `dsh-plugin-memory` 等插件的底层能力，降低开发成本。
