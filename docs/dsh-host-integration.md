# DSH 宿主联调指南

本文档回答一个问题：**插件做好了，怎么在真实的 DSH（DeepSeek Harness）宿主里跑起来？**

DialogueContextBridge 的核心逻辑（编译 / 存储 / 加密）完全不依赖宿主，可以在纯
Node 下测试；但「命令注册」「读取当前对话」「把背景简报注入系统提示」三件事必须由
宿主提供。这套依赖在 `src/dsh/types.ts` 里被收敛成一个**最小接口接缝**（seam），
本指南就是这份接缝的「对照表 + 联调清单」。

---

## 1. 宿主必须提供的三项能力

插件在 `apply(ctx, config)` 时通过 Cordis 的模块增强读取以下上下文成员：

| 上下文成员 | 类型 | 必需 | 作用 |
| --- | --- | --- | --- |
| `ctx.command` | `(decl, desc?) => CommandBuilder` | **必需** | 注册 `/compile` `/save` `/import` `/dcb` `/snapshot.*` 等命令。缺失时 `requireCommandRegistry` 抛 `DCB_HOST_CAPABILITY_MISSING`。 |
| `ctx.conversation` | `ConversationService` | 可选 | `history(id, opts)` 读取对话消息，供 `/compile` 与 `/import --mode merge` 使用。缺失时命令返回可读提示而非崩溃。 |
| `ctx.injector` | `InjectionService` | 可选 | `inject(conversationId, brief)` 把背景简报注入目标对话的系统提示头部。缺失时降级为以消息形式下发（`createSessionInjector`）。 |

> 接缝的完整类型定义见 `src/dsh/types.ts`。插件**不**对宿主做 duck-typing 猜测：
> `requireCommandRegistry` 在能力缺失时抛可读错误，而不是静默降级。

### 1.1 三者的语义契约

- **`command`**：标准 Cordis 命令注册。声明形如 `import <snapshotId:text>`，
  链式 `.option()` / `.alias()` / `.usage()` / `.example()` / `.action()`。
  回调签名 `(argv, ...args)`，其中 `argv.session.conversationId` 是当前对话 id，
  `argv.options` 是解析后的选项，`argv.session.send(md)` 向当前对话发消息。
- **`conversation.history(id, { limit, since })`**：返回时间升序的消息数组，
  单条为 `{ id, role, content, createdAt }`（`role` 取 `user` / `assistant`）。
- **`injector.inject(id, brief)`**：`brief` 是已渲染好的 Markdown 只读背景简报
  （带 `<!-- dcb:import -->` 标记）。注入后，新对话的产出**不应**反向写回快照。

---

## 2. 把插件装进 DSH 运行时

插件本身是一个标准 Cordis 插件，导出了 `apply` / `Config` / `name` / `inject`：

```ts
// src/index.ts 导出
export default { name, inject, Config, apply };
```

DSH 加载插件的典型方式（具体以宿主的插件清单格式为准）：

1. 构建产物：`npm run build` 产出 `lib/`（ESM `index.js` + CJS `index.cjs` + `index.d.ts`）。
2. 插件包通过 `peerDependencies` 声明 `cordis`，由宿主提供运行时。
3. 宿主按自身插件清单把 `apply` 注册进去，并**在加载期**提供 `ctx.command`；
   如要启用「系统提示注入」，还需提供 `ctx.injector`（见第 4 节对齐要点）。

> 本仓库的 `package.json` 已声明 `"type": "module"`、`main`/`module`/`types` 指向
> `lib/`，以及 `files` 仅含 `lib` + `README` + `LICENSE`，可直接作为 DSH 插件包发布。

---

## 3. 本地契约测试（无需真机）

真实 DSH 运行时不在本仓库内，但接缝已被 **完全可测**。两份测试覆盖了从「加载」到
「真实注入路径」的全过程：

| 测试 | 验证内容 |
| --- | --- |
| `tests/plugin-load.test.ts` | `apply` 打开数据库、把服务挂到 `ctx.dcb`、注册全部 10 个命令、`dispose` 释放连接；并端到端跑通「编译落库 → 检索 → 读取 → 导入 → 删除」。 |
| `tests/dsh-host.test.ts` | 用**贴合 DSH 形态的 mock 宿主**驱动 `apply`，并实际触发 `/compile`、`/import` 回调：证明 `/compile` 走 `conversation` 服务、`/import` 在宿主提供 `injector` 时走真实 `InjectionService.inject`（而非消息降级）、缺失 `injector` 时降级为 `session.send`。 |

运行：

```bash
npx vitest run tests/dsh-host.test.ts   # 或 npx vitest run 跑全部
```

**思路**：把 `tests/dsh-host.test.ts` 里的 `createDshMockHost` 替换为真实宿主提供的
同一组 `command` / `conversation` / `injector` 实现，即可在真机上做等价验证——这是
联调的最小可移植样板。

---

## 4. 真实运行时联调清单

在真机上加载后，逐项核对：

- [ ] **命令可见**：`/compile` `/save` `/import` `/dcb` 以及 `snapshot.search` /
      `snapshot.list` / `snapshot.show` / `snapshot.remove` / `snapshot.history` /
      `snapshot.rollback` 均出现在宿主命令列表。
- [ ] **`/compile` 有内容**：在一段已有对话里执行 `/compile`，应回显三层预览，
      而不是「当前对话没有可编译的消息」（后者说明 `ctx.conversation.history` 没接通）。
- [ ] **`/import` 接入系统提示**：执行 `/dcb <id>`，确认背景简报出现在**新对话的系统
      上下文头部**（而非作为普通消息），且新对话产出不回写快照。需要宿主实现
      `ctx.injector.inject`——见下。
- [ ] **注入降级提示**：若宿主暂不提供 `injector`，`/import` 应回显「会话消息降级下发」，
      功能演示仍可用。
- [ ] **`/import --mode merge` 需要对话历史**：融合模式会调用 `ctx.conversation.history`，
      无对话服务时应给出「⚠️ 宿主未提供对话服务」提示。
- [ ] **数据落盘**：快照写入 `config.dataDir`（默认 `~/.dsh/...`），不上传服务器。
- [ ] **加密（可选）**：开启 `encryption.enabled` 后，SQLite 中存密文，索引仍可检索。

### 4.1 对齐要点（最容易踩的偏差）

1. **`injector` 必须在加载期就存在**。插件在 `apply` 时把 `ctx.injector` 快照进命令
   依赖（`deps.injector`），不是每次命令执行时现读。若宿主的注入能力是运行时才就绪，
   需在加载插件前就把它挂到 `ctx.injector`。
2. **`conversation.history` 的消息形状**。必须是 `{ id, role, content, createdAt }`；
   `role` 用 `user` / `assistant`。若宿主用别的字段名（如 `author` / `type`），需要在
   宿主侧或 `src/dsh/types.ts` 的适配层做一次映射。
3. **`command` 声明语法**。声明的参数写法（如 `<snapshotId:text>`）需宿主的命令行解析器
   支持；若宿主声明语法不同，调整 `src/commands/import.ts` 等处的 `registry(...)` 字符串。
4. **`session.send` 的语义**。降级路径下 `send` 接收 Markdown 文本；若宿主 `send` 期望
   结构化对象而非字符串，需在 `createSessionInjector` 适配。

---

## 5. 已知边界（联调时会暴露、但属设计权衡）

- **版本控制依赖真实 git**：开启 `versioning.enabled` 后，记忆库变更会 `git commit` 到
  数据目录下的 `snapshots/` 子仓库。该子仓库是数据目录内的独立仓库，与插件源码仓库无关。
  真机需确保 `git` 可用，或保持 `versioning.enabled: false`。
- **静态加密与明文索引**：`encryption.enabled` 时快照以 AES-256-GCM 落盘；若同时要 FTS5
  检索，需 `encryption.indexPlaintext: true`（用明文摘要建索引，正文仍密文）。这是安全/
  可检索性的明确权衡，联调时按宿主合规要求选择。
- **`ctx.conversation` 缺失是可接受的降级**：`/compile` 与 `/import --mode merge` 需要它，
  但 `/import`（inject 模式）和 `/dcb` 不需要——它们只渲染已存快照。

---

## 6. 小结

联调的本质，就是让真实宿主的 `command` / `conversation` / `injector` 三件套，满足
`src/dsh/types.ts` 里的最小接口。先把 `tests/dsh-host.test.ts` 的 mock 换成真机实现跑通，
再按第 4 节清单逐项核对，即可确认「上下文桥接」在真实 DSH 里端到端可用。
