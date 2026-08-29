# Changelog

All notable changes to the **DialogueContextBridge** DSH plugin are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-08-29

### Features
- **LLM 摘要器（`summary.mode = llm`）**：`/compile` 与 `/import --mode merge` 的摘要层新增 LLM 增强压缩模式，调用宿主 LLM 生成更连贯、更擅长跨片段归纳的摘要；失败时自动回退内置抽取式（零依赖、确定性可复现）。新增 `src/core/llm-summarizer.ts` 与 `src/dsh/llm.ts`，provider / model / maxTokens / temperature 经 DSH 设置面板热改。
- **加权合并裁决（`merge.policy = weighted`）**：快照粒度 `weight` 字段（经 `/snapshot-weight` 标记，继承到其全部条目）；合并冲突时权重高者胜，平局回退当前对话胜。新增命令 `/snapshot-weight`，命令总数 14 → 15。

### Fixes
- **应用配置兜底（`apply`）**：`apply` / `applyLive` 顶部统一 `Config(config)` 套用 Schema 默认值，兜底宿主传入残缺 config（如缺 `summary` 段）导致的崩溃，对真实 dsh（已填默认）幂等无害。
- **CI（pnpm build / Node）**：修复 CI 在干净环境下 `verify` 矩阵全红——pnpm 9 默认不运行未列入白名单的依赖 build script，CI 从未批准过 `better-sqlite3` 的 build，致原生模块未编译、`require` 失败；`package.json` 新增 `pnpm.onlyBuiltDependencies: ["better-sqlite3"]` 令 CI 自动编译。Node 矩阵 `[18,20,22] → [20,22]`（`better-sqlite3@11` 需 Node 20+），`engines.node` 同步改为 `>=20`。另修正配置兜底引入的参数重赋值（`no-param-reassign`）lint 错误。

### Docs
- 对齐 docs / website 到最新代码（`/dcb-merge`、纯文本卡片、input 拦截），新增「已知限制」章节；README / menu / 命令 docstring 同步命令计数。

### Verification
- `lint` / `typecheck` 通过；100 个单元测试 + 端到端 e2e 卡片预览通过；真实 `dsh@0.1.1-rc.2` 宿主启动并监听 `127.0.0.1:3080`，插件 `apply()` 成功加载（数据库打开、命令注册、设置面板接入）。

## [0.1.0] - 2026-08-26

初始发布：三层快照（verbatim / summary / preference）编译与导入注入闭环，SQLite + FTS5 存储，15 个命令，设置面板热改，AES-256-GCM 静态加密，记忆库 git 版本控制。
