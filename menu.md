# 项目导航 · DialogueContextBridge

> 本文件说明仓库内各目录与关键文件的作用，方便新贡献者或宿主集成方快速定位。

## 根目录

| 文件/目录 | 作用 |
| --- | --- |
| `src/` | 插件源码（见下文分层说明） |
| `tests/` | Vitest 单元测试与契约测试（见下文） |
| `docs/` | 面向使用者与宿主开发者的设计文档 |
| `website/` | GitHub Pages 静态站点与图片资源 |
| `package.json` | 包元数据、依赖脚本、Cordis 插件导出入口 |
| `tsconfig.json` | TypeScript 编译配置（严格模式、路径别名等） |
| `tsup.config.ts` | 构建配置：产出 ESM / CJS / d.ts 到 `lib/` |
| `.eslintrc.cjs` | ESLint 配置：`airbnb-base` + `@typescript-eslint/recommended` |
| `commitlint.config.cjs` | Conventional Commits 提交规范校验 |
| `vitest.config.ts` | 单元测试配置 |
| `README.md` | 项目主说明：功能、快速开始、命令参考、配置项 |
| `LICENSE` | MIT 许可证 |
| `menu.md` | 本文件：目录与文件导航 |
| `.gitignore` | 忽略规则（`node_modules/`、`lib/`、运行时临时产物） |
| `.github/workflows/` | GitHub Actions：CI 四门验证 + Pages 文档站点部署 |

---

## `src/` 源码分层

### 入口与配置

| 文件 | 作用 |
| --- | --- |
| `index.ts` | **Cordis 插件入口**。导出 `apply`、`Config`、`Schema`、类型；负责注册命令、创建服务、生命周期 `ready`/`dispose` |
| `config.ts` | **Schemastery 配置 Schema**。定义 `dataDir`、`maxTokens`、`encryption`、`merge.policy`、`versioning.enabled` 等可热改配置 |
| `service.ts` | **编排层 / 业务门面**。`BridgeService` 的实现：编译→预览→落库→检索→构建导入简报的完整工作流 |
| `types.ts` | **三层快照数据模型**。`Snapshot`、`Layer`、`Preference`、`Message`、`CompileRequest` 等结构 |

### `src/commands/` 命令层

| 文件 | 作用 |
| --- | --- |
| `index.ts` | 统一注册全部 **14 个命令**（`/compile`、`/save`、`/dcb-save`、`/snapshot.search`、`/snapshot.list`、`/snapshot.show`、`/snapshot.remove`、`/snapshot.history`、`/snapshot.rollback`、`/import`、`/dcb-merge`、`/dcb`、`/dcb-export`、`/dcb-import`）。**每个命令都声明 `input` 输入提示**，因此手打带参命令也会被宿主直接拦截执行、不再误发模型（根治历史 `/import ... --mode merge` 烧 token 问题），菜单点选与手打行为一致 |
| `compile.ts` | `/compile`：把当前对话按三层结构编译为快照草稿（内存中，预览但不落库） |
| `save.ts` | `/save`：把草稿写入 SQLite，或在没有草稿时即时编译并保存 |
| `search.ts` | `/snapshot.search`：基于 FTS5 的关键词全文检索 |
| `manage.ts` | `/snapshot.list`、`/snapshot.show`、`/snapshot.remove`、`/snapshot.history`、`/snapshot.rollback` |
| `import.ts` | `/import`、`/dcb-merge` 与 `/dcb`：把历史快照注入当前对话。其中 `/dcb-merge <id>` 是 `/import <id> --mode merge` 的**高频单步别名**（少一次交互），支持 `--policy newWins\|snapshotWins\|timestamp` 与 `--dry-run`；`/dcb` 不带 id 时显示记忆库总览与快捷操作。全部支持 `inject`/`merge` 双模式与冲突裁决 |
| `format.ts` | 面向用户的输出文案集中编排；DSH 命令回执按**纯文本**渲染（不解析 Markdown），故所有文案不使用任何 Markdown 标记，避免暴露 `**`、反引号、表格等源码符号 |
| `card.ts` | 纯文本卡片渲染助手：emoji 标题 + `─` 分隔线 + `·` 项目符号 + `→` 引导的精致卡片（`card`/`kvTable`/`snapshotTable`/`actionList`），支撑全部命令回执统一为纯文本卡片 |
| `shared.ts` | 命令参数解析、错误包装、宿主依赖对象 `CommandDeps` |

### `src/core/` 纯逻辑核心（不依赖 DSH 宿主）

| 文件 | 作用 |
| --- | --- |
| `compiler.ts` | `/compile` 的完整流水线：分类 → 摘要 → 预算裁剪 → 序列化 |
| `classifier.ts` | 消息 → 三层（原文 / 摘要 / 偏好）分类器，可扩展 |
| `summarize.ts` | 摘要器：内置抽取式实现，并预留 LLM 摘要器注入接口 |
| `lexicon.ts` | 语义识别词典（判断消息是否含代码、决策、约束等信号） |
| `budget.ts` | token 预算裁剪，确保快照在 `maxTokens` 限制内 |
| `serializer.ts` | Markdown + Schema 头序列化 / 解析；完整性校验（checksum） |
| `inject.ts` | 注入与融合逻辑：只读简报 `inject`、merge 冲突裁决 `fuseSnapshots` |

### `src/storage/` 持久化层

| 文件 | 作用 |
| --- | --- |
| `database.ts` | `better-sqlite3` 初始化、FTS5 索引创建、版本探测与分词器回退 |
| `migrations.ts` | 数据库 schema 迁移脚本 |
| `repository.ts` | `SnapshotRepository` 实现：增删改查、FTS5 搜索、完整性校验 |

### `src/security/` 安全

| 文件 | 作用 |
| --- | --- |
| `crypto.ts` | AES-256-GCM 信封加解密、密钥派生（scrypt）、加密擦除 |

### `src/versioning/` 版本控制（Phase 4）

| 文件 | 作用 |
| --- | --- |
| `git.ts` | `GitRunner` 接口 + CLI 与内存两种实现 |
| `store.ts` | `VersioningController`：把快照保存/删除/回滚记录为 git 版本 |

### `src/dsh/` 宿主接缝

| 文件 | 作用 |
| --- | --- |
| `types.ts` | DSH 宿主能力的类型契约：`CommandService`、`ConversationService`、`InjectionService`。这是插件与真实运行时之间**唯一需要协商对齐**的文件。其中 `CommandDefinition.input`（`{hint, images?}`）声明后，宿主 `matchEnter` 会在用户**手打带参命令回车**时也走拦截执行——这是「全 14 命令声明 input、根治手打烧 token」的接缝所在 |

### `src/utils/` 工具

| 文件 | 作用 |
| --- | --- |
| `id.ts` | 快照 ID 生成（短、可读、可校验前缀） |
| `tokens.ts` | 简易 token 估算 |
| `paths.ts` | 数据目录、快照目录路径解析 |
| `logger.ts` | 统一日志，支持配置级别 |

---

## `tests/` 测试

| 文件 | 作用 |
| --- | --- |
| `fixtures.ts` | 共享测试数据（消息、快照） |
| `compiler.test.ts` | 编译流水线与三层分类 |
| `serializer.test.ts` | Markdown + Schema 序列化 / 解析 |
| `storage.test.ts` | SQLite + FTS5 增删改查与检索 |
| `crypto.test.ts` | AES-256-GCM 加解密与擦除 |
| `import.test.ts` | `inject` / `merge` 模式与冲突裁决 |
| `versioning.test.ts` | 版本化存储、历史、回滚 |
| `plugin-load.test.ts` | 用轻量 Cordis 上下文桩直接加载真实 `apply` |
| `dsh-host.test.ts` | 用贴合 DSH 形态的 mock 宿主驱动真实命令回调，验证注入路径 |

---

## `docs/` 设计文档

| 文件 | 作用 |
| --- | --- |
| `architecture.md` | 总体架构、三层快照设计、工作流、安全与工程决策 |
| `snapshot-schema.md` | 快照 Markdown 文件格式与自描述 Schema 头规范 |
| `dsh-host-integration.md` | DSH 宿主如何加载本插件、接缝契约与联调清单 |

---

## `website/` 站点与资源

| 文件/目录 | 作用 |
| --- | --- |
| `index.html` | GitHub Pages 落地页：hero、特性、命令表、快速开始 |
| `assets/logo.svg` | 插件 logo（对话桥接抽象图形） |
| `assets/architecture.svg` | 三层快照数据流架构图（用于 README 与站点） |
| `assets/social-preview.svg` | 1280×640 矢量 banner（README 顶部大图） |
| `assets/social-preview.png` | 同一 banner 的 PNG 版本，可上传到仓库 Settings → Social preview |

---

## 关键数据流速查

```
源对话消息
  → /compile
    → src/core/compiler.ts
      → classifier / summarize / budget / serializer
        → src/service.ts 预览草稿
          → /save
            → src/storage/repository.ts + SQLite/FTS5
              → src/versioning/store.ts (可选 git 版本)
                → /snapshot.search 或 /import
                  → src/core/inject.ts 生成简报
                    → InjectionService 注入新对话（或 session.send 降级）
```

---

## 修改建议

- 如果你想**扩展命令**：优先改 `src/commands/` 和 `src/service.ts`。
- 如果你想**接入新的 DSH 运行时**：只改 `src/dsh/types.ts` 的适配实现，不需要碰核心逻辑。
- 如果你想**优化摘要质量**：替换或扩展 `src/core/summarize.ts` 的摘要器实现。
- 如果你想**改 UI 输出**：调 `src/commands/format.ts`。
