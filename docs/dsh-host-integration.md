# DSH 宿主联调指南

本文档回答一个问题：**插件做好了，怎么在真实的 DSH（DeepSeek Harness）宿主里跑起来？**

DialogueContextBridge 的核心逻辑（编译 / 存储 / 加密）完全不依赖宿主，可以在纯
Node 下测试；但「命令注册」「读取当前对话」「把背景简报注入系统提示」三件事必须由
宿主提供。这套依赖在 `src/dsh/types.ts` 里被收敛成一个**最小接口接缝**（seam），
本指南就是这份接缝的「对照表 + 联调清单」。

---

## 0. 前置条件：你需要一个真实的 DSH 运行时，以及你具体要做什么

DialogueContextBridge 只是**一个 Cordis 插件**，**不能独立运行**——它必须被一个
DSH（DeepSeek Harness，面向大语言模型的智能体运行时）宿主加载后才能工作。所以在
「联调」之前，先分清两件事：**插件方（本仓库）已经做完的事**，和**你（宿主方）必须
提供的事**。

### 0.1 你手上需要什么

1. **一个真实的 DSH 运行时**：即一个已经实现了 `ctx.commands.register` / `agent.session` /
   `agent.inject` 三件套的宿主程序。本仓库**不包含**宿主，只提供插件。
2. **本仓库构建产物 `lib/`**（见 0.2）。
3. 宿主侧一个能注册 `apply` 的插件接入点。

> 如果你还没有 DSH 运行时，见 0.5——在那之前所有「联调」都只能走到「接缝验证」，
> 无法真正把简报注入真实模型的系统提示。

### 0.2 构建插件（插件方）

```bash
npm install
npm run build      # 产出 lib/（ESM index.js + CJS index.cjs + index.d.ts）
```

`lib/` 是一个标准 Cordis 插件包：已声明 `"type": "module"`、`main/module/types` 指向
`lib/`，`peerDependencies` 含 `cordis`，`files` 仅含 `lib` + `README` + `LICENSE`。

### 0.3 你（宿主方）具体要做的三件事

1. **实现三个接缝**（契约见第 1 节）：
   - `ctx.commands.register(def)`：标准 DSH 命令注册器（`def` 含 `name` / `description` /
     `input` / `handler`）。
   - `agent.session.deriveMessages()` → `{ id, role, content, createdAt }[]`
     （`role` 为 `user` / `assistant`）：读取当前对话历史。
   - `agent.inject(userMessage)`：把背景简报作为模型可见输入注入下一轮请求。
2. **在加载期挂好接缝**：宿主启动时，先准备好 `ctx.commands`（以及要启用上下文注入时
   提供 `agent.inject`），**再**调用插件的 `apply(ctx, config)`。插件在 `apply` 时通过
   `createDshCommandRegistry(ctx)` 拿到 `ctx.commands`，并在命令执行时经 `invocation.agent`
   取用 `session` 与 `inject`（第 4.1 节）。
3. **注册插件**：把导出的 `apply` 加入宿主的插件加载流程（典型做法：宿主插件清单引用
   本包，调用 `ctx.plugin(apply)` 或宿主等价的注册 API）。

### 0.4 联调验证顺序

- **第一步（接缝对齐）**：把 `tests/dsh-host.test.ts` 里的 `createDshMockHost` 换成你宿主
  的真实实现，跑通即证明三件套形状对齐（`/compile` 走 `session.deriveMessages`、`/import` 走真实
  `agent.inject`）。这是最小可移植样板。
- **第二步（真机清单）**：按第 4 节逐项核对——命令可见、`/compile` 有内容、`/dcb <id>`
  简报进入系统提示头部（而非普通消息）、缺 `agent.inject` 时降级提示、数据落盘 `~/.dsh/`、
  加密开关生效。

### 0.5 如果你还没有 DSH 运行时

本仓库只提供插件，不内置宿主。可选路径：

- **团队已有 DSH / DeepSeek Harness 部署**：按其插件接入文档加载本包（0.2 + 0.3）。
- **从零搭最小验证宿主**：基于 Cordis 写一个仅实现三接缝的桩（直接参考
  `tests/dsh-host.test.ts` 的 mock 实现即可）。但这是「接缝验证」，不是「真实 LLM 对话
  桥接」——真正的桥接需要宿主把简报注入  真实模型的系统提示，且 `/compile` 要能读到你与
  模型的真实对话历史。

### 0.6 如何获得并安装 DeepSeek Harness（真实运行时）

DeepSeek Harness（`dsh`）是 DeepSeek AI 开源（MIT 许可）的、基于 Cordis 的智能体
运行时，「一切皆插件」。本插件就是为它写的——获取与启动：

```bash
# 1) 环境：Node.js 22.19+ 或 24+
node -v

# 2) 全局安装 dsh（开发者预览，建议锁定版本，API 可能变更）
npm install -g @deepseek-ai/dsh

# 3) 启动本地 Web UI（默认 http://127.0.0.1:3080）
dsh --profile web

#    后台运行且不自动开浏览器：
dsh --profile web --no-open
```

启动后在 **设置** 里填入模型 API Key（DeepSeek 或任意 OpenAI 兼容端点），即是一个可对话的
真实 LLM 宿主。

把本插件装进 dsh：

```bash
# 1) 先构建（产出 lib/）
npm install && npm run build

# 2) 用 dsh 的插件命令从本地目录安装
dsh plugin --profile web add ./DialogueContextBridge

# 3) 重启 dsh，在 设置 → 插件 中开启 DialogueContextBridge
dsh --profile web
```

> ⚠️ **对接前必须核对的一件事（关键风险）**：本插件在 `src/dsh/types.ts` 里把接缝命名为
> `ctx.commands.register` / `agent.session.deriveMessages()` / `agent.inject()`，已对照
> `@deepseek-ai/dsh` 0.1.1-rc.2 的真实 API 对齐（非早期推断）。但 dsh 仍处于开发者预览，
> 不同版本的服务名 / 调用形态可能变化。**在真机联调前，务必先读 dsh 源码或参考官方
> `dsh-plugin-memory` 等插件的写法，确认 dsh 实际提供哪些 `ctx.*` 服务、命令如何注册、
> 对话历史如何读取、上下文如何注入，再把我们的适配层对齐过去。** 建议锁定 dsh 版本、
> 以发布时的源码为准。

---

## 1. 宿主必须提供的三项能力

插件在 `apply(ctx, config)` 时通过 `createDshCommandRegistry(ctx)` 等适配函数，对接宿主提供的以下能力（完整类型见 `src/dsh/types.ts`）：

| 上下文成员 | 类型 | 必需 | 作用 |
| --- | --- | --- | --- |
| `ctx.commands` | `CommandRuntime`（`register(def)`） | **必需** | 注册全部 **17 个命令**（见下）。缺失时 `createDshCommandRegistry` 抛 `DCB_HOST_CAPABILITY_MISSING`。 |
| `agent.session` | `Session`（`deriveMessages()`） | 可选 | 读取当前对话消息，供 `/compile` 与 `/import --mode merge` 使用。缺失时命令返回可读提示而非崩溃。 |
| `agent.inject` | `(userMessage) => void` | 可选 | 把背景简报作为模型可见输入注入下一轮请求。缺失时降级为以消息形式下发（`createSessionInjector`）。 |

> 接缝的完整类型定义见 `src/dsh/types.ts`。插件**不**对宿主做 duck-typing 猜测：
> `createDshCommandRegistry` 在能力缺失时抛可读错误，而不是静默降级。
>
> 全部 17 个命令：`/compile`、`/save`、`/dcb-save`、`/snapshot-search`、`/snapshot-list`、
> `/snapshot-show`、`/snapshot-remove`、`/snapshot-history`、`/snapshot-rollback`、`/snapshot-weight`、
> `/import`、`/dcb-merge`、`/dcb`、`/dcb-export`、`/dcb-import`、
> `/dcb-import-last`、`/dcb-merge-last`。

### 1.1 三者的语义契约

- **`commands.register(def)`**：注册一个人类命令。`def` 形如
  `{ name, description, input?, handler }`。`handler(invocation)` 拿到 `invocation.agent`
  与 `invocation.rawInput`，返回 `{ kind: 'success', text }` 或 `{ kind: 'error', text }`。
  - **`input` 字段是关键交互契约**：声明 `input: { hint, images? }` 后，宿主客户端
    （`dsh-client-ui-commands` 的 `matchEnter`）会在用户**手打带参命令并回车**时也走宿主拦截
    执行，而非把整行当作普通消息发给 LLM。本插件对全部**带参**命令统一声明 `input`（无参命令 `/dcb-import-last`、`/dcb-merge-last` 不声明，由命令面板点选即执行），从根上避免
    历史上 `/import <id> --mode merge` 被模型当成聊天、烧 token 的问题。
- **`agent.session.deriveMessages()`**：返回时间升序的消息数组，单条映射为
  `{ id, role, content, createdAt }`（`role` 取 `user` / `assistant`）。
- **`agent.inject(userMessage)`**：`userMessage` 是已渲染好的只读背景简报（纯文本，
  带 `<!-- dcb:import -->` 标记）。注入后，新对话的产出**不应**反向写回快照。

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
3. 宿主按自身插件清单把 `apply` 注册进去，并**在加载期**提供 `ctx.commands`；
   如要启用「上下文注入」，还需保证命令回调拿到的 `agent` 上挂载了 `session` 与 `inject`
   （见第 4 节对齐要点）。

> 本仓库的 `package.json` 已声明 `"type": "module"`、`main`/`module`/`types` 指向
> `lib/`，以及 `files` 仅含 `lib` + `README` + `LICENSE`，可直接作为 DSH 插件包发布。

---

## 3. 本地契约测试（无需真机）

真实 DSH 运行时不在本仓库内，但接缝已被 **完全可测**。两份测试覆盖了从「加载」到
「真实注入路径」的全过程：

| 测试 | 验证内容 |
| --- | --- |
| `tests/plugin-load.test.ts` | `apply` 打开数据库、把服务挂到 `ctx.dcb`、注册全部 17 个命令、`dispose` 释放连接；并端到端跑通「编译落库 → 检索 → 读取 → 导入 → 删除」。 |
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

- [ ] **命令可见**：`/compile` `/save` `/dcb-save` `/import` `/dcb-merge` `/dcb` /
      `/dcb-export` `/dcb-import` `/dcb-import-last` `/dcb-merge-last` 以及 `snapshot-search` / `snapshot-list` / `snapshot-show` /
      `snapshot-remove` / `snapshot-history` / `snapshot-rollback` / `snapshot-weight` 共 17 个命令均出现在宿主命令列表。
- [ ] **`/compile` 有内容**：在一段已有对话里执行 `/compile`，应回显三层预览，
      而不是「当前对话没有可编译的消息」（后者说明 `agent.session.deriveMessages()` 没接通）。
- [ ] **`/import` 接入系统提示**：执行 `/dcb <id>`，确认背景简报出现在**新对话的系统
      上下文头部**（而非作为普通消息），且新对话产出不回写快照。需要宿主实现
      `agent.inject(userMessage)`——见下。
- [ ] **注入降级提示**：若宿主暂不提供 `inject`，`/import` 应回显「会话消息降级下发」，
      功能演示仍可用。
- [ ] **`/import --mode merge` 需要对话历史**：融合模式会调用 `agent.session.deriveMessages()`，
      无对话服务时应给出「⚠️ 宿主未提供对话服务」提示。
- [ ] **数据落盘**：快照写入 `config.dataDir`（默认 `~/.dsh/...`），不上传服务器。
- [ ] **加密（可选）**：开启 `encryption.enabled` 后，SQLite 中存密文，索引仍可检索。

### 4.1 对齐要点（最容易踩的偏差）

1. **`agent` 必须在加载期就存在**。插件在 `apply` 时把 `ctx.commands` 注入命令依赖
   （`deps.registry`），并在命令执行时通过 `invocation.agent` 拿到当前 Agent 句柄。
   宿主需保证命令回调拿到的 `agent` 上挂载了 `session.deriveMessages()` 与 `inject()`。
2. **`session.deriveMessages()` 的消息形状**。插件内部映射为 `{ id, role, content, createdAt }`；
   `role` 归一化为 `user` / `assistant` / `system`。若宿主 Agent 的消息结构不同，需在
   `createDshConversationReader` 适配层做一次映射。
3. **命令 `input` 声明**。每个命令都声明了 `input.hint`（兼作菜单占位用法提示）。这是
   「手打带参命令也被宿主拦截、不误发模型」的关键（见 §1.1）；若宿主忽略了 `input`，
   命令面板点选仍可用，但手打带参命令可能退化为普通聊天消息。
4. **命令回执纯文本**。处理器返回 `{ kind: 'success', text }`，`text` 由插件渲染为
   纯文本卡片（emoji + `·`/`→`/`─`，**不含任何 Markdown 标记**）——因为 DSH web 客户端
   不解析 Markdown。若宿主期望结构化卡片，需在宿主侧自行渲染 `text`。

---

## 5. 已知边界（联调时会暴露、但属设计权衡）

- **版本控制依赖真实 git**：开启 `versioning.enabled` 后，记忆库变更会 `git commit` 到
  数据目录下的 `snapshots/` 子仓库。该子仓库是数据目录内的独立仓库，与插件源码仓库无关。
  真机需确保 `git` 可用，或保持 `versioning.enabled: false`。
- **静态加密与明文索引**：`encryption.enabled` 时快照以 AES-256-GCM 落盘；若同时要 FTS5
  检索，需 `encryption.indexPlaintext: true`（用明文摘要建索引，正文仍密文）。这是安全/
  可检索性的明确权衡，联调时按宿主合规要求选择。
- **`agent.session` 缺失是可接受的降级**：`/compile` 与 `/import --mode merge` 需要它，
  但 `/import`（inject 模式）和 `/dcb` 不需要——它们只渲染已存快照。

### 5.1 框架级交互限制（DSH 0.1.x，非插件缺陷，待宿主升级）

以下两点来自 DSH 运行时本身的交互能力边界，不是本插件的逻辑 bug；记录在案以免使用者误判：

- **带参命令气泡常驻「执行中…」**：当命令经 `matchEnter` 拦截路径执行（即用户在输入框**手打
  带参命令**回车）时，rc.2 版本下框架完成命令后未把气泡标记 done，于是气泡一直显示
  「执行中」。但命令结果**已正确返回并注入**，刷新页面或发送下一条消息即可清除该提示。这是
  声明 `input` 以「根治手打烧 token」的必要代价——功能完全正常。菜单点选 / 无参命令无此现象。
- **不支持气泡内可点按钮**：DSH 0.1.x 的命令回执只支持纯文本（`CommandResult.text`），
  无法在气泡里回传可点击的按钮 / 卡片；外部插件也无法注入输入框自定义芯片（client 预编译
  bundle）。因此「零打字」的交互形态是：在输入框按 `/`（或点 `+` 菜单按钮）唤起命令面板，
  鼠标点选即执行——真正的 in-bubble 按钮需等 DSH 升级或自定义 client 构建。

---

## 6. 小结

联调的本质，就是让真实宿主的 `commands.register` / `session.deriveMessages` / `agent.inject`
三件套，满足 `src/dsh/types.ts` 里的最小接口。先把 `tests/dsh-host.test.ts` 的 mock 换成真机实现跑通，
再按第 4 节清单逐项核对，即可确认「上下文桥接」在真实 DSH 里端到端可用。
