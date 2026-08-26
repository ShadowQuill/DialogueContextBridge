# 快照文档格式规范

> 本文定义 DialogueContextBridge 在磁盘（以及跨对话传递）中的**快照文档**格式。它是纯文本 Markdown + 自描述 Schema 头，任何能读取纯文本的 AI 智能体均可直接接手处理。

设计三条硬约束：

1. **自描述**：文档头是 YAML 风格 Schema 头，解析器无需外部信息即可还原结构；
2. **可读**：正文是标准 Markdown，人类可直接阅读与手工编辑；
3. **可移植**：不含任何平台专有字段，不依赖特定宿主。

---

## 1. 整体结构

```
---                         ← Schema 头开始
dcb_schema: "1.0"
snapshot_id: <uuid>
source_conversation_id: <conv-id>
title: <单行标题>
description: <单行描述，可含空格>
tags: [tag1, tag2]
created_at: 2026-08-26T15:52:02.000Z
token_estimate: 4096
encrypted: false
checksum: <sha256-hex>
layers: [verbatim, summary, preference]
---                         ← Schema 头结束（其后空行被校验和逻辑吞掉）

# <标题>

> <描述（可选）>

<!-- dcb:layer:verbatim -->
## 1. 关键消息原文
...

<!-- dcb:layer:summary -->
## 2. 结构化摘要
### <小节标题>
- ...

<!-- dcb:layer:preference -->
## 3. 用户偏好与设定
- **[scope] key** (explicit|inferred) — value <!-- at=1693069922000 -->

<!-- dcb:end -->
```

- 层边界用 HTML 注释标记 `<!-- dcb:layer:* -->` 与 `<!-- dcb:end -->`：既不影响 Markdown 渲染，也便于机械切分。
- Schema 头与正文之间、各层之间的分隔均为标准空行。

---

## 2. Schema 头字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `dcb_schema` | string | 快照 Schema 版本，当前固定 `"1.0"` |
| `snapshot_id` | string | 快照唯一 id（`utils/id.ts` 中生成） |
| `source_conversation_id` | string | 来源对话 id |
| `title` | string | 标题（单行，换行被压缩） |
| `description` | string | 描述（单行，换行被压缩） |
| `tags` | `[a, b, c]` | 标签数组字面量 |
| `created_at` | ISO-8601 | 生成时间 |
| `token_estimate` | integer | token 估算值（见 §6） |
| `encrypted` | `true`/`false` | 正文是否为密文（仅元数据，密文本身在 `document` 字段） |
| `checksum` | hex | 正文的 sha256 摘要（见 §5） |
| `layers` | `[...]` | 固定为 `[verbatim, summary, preference]`，声明层顺序 |

> `encrypted` 描述的是**落盘正文**（`snapshots.document` 列）是否密文；Markdown 文档本身的 `<!-- dcb:layer -->` 标记始终是明文结构。当 `encrypted=true` 时，调用方通常不写入明文 FTS 索引（见 `architecture.md` §5.3）。

---

## 3. 原文层（verbatim）

每条原文是一条带属性注释的块：

```
<!-- dcb:entry id=v-1 kind=decision role=user src=msg-42 at=1693069922000 -->
最终采用方案 A：基于 FTS5 的本地检索。
```

### 3.1 条目头属性

| 属性 | 含义 | 是否必填 |
| --- | --- | --- |
| `id` | 条目 id | 否（缺省回退 `v-<序号>`） |
| `kind` | `decision` \| `code` \| `parameter` \| `directive` | 否（缺省 `decision`） |
| `role` | 来源消息角色（`user`/`assistant`/…） | 否（缺省 `user`） |
| `src` | 来源消息 id | 否 |
| `at` | 创建时间 epoch 毫秒 | 否（缺省 0） |
| `lang` | 仅 `kind=code` 生效，代码语言 | 否 |

### 3.2 代码条目

`kind=code` 的条目用 Markdown 围栏包裹，语言来自 `lang` 属性：

```
<!-- dcb:entry id=v-2 kind=code lang=typescript src=msg-51 at=1693069988000 -->
```typescript
export function add(a: number, b: number): number {
  return a + b;
}
```
```

- 围栏长度由 `fenceFor()` 动态计算，**长于内容中最长的连续反引号串**，因此内容中的反引号不会破坏围栏；
- 非代码条目直接以纯文本放在条目头下一行。

### 3.3 正文转义

正文中若字面出现 `<!--`，序列化时转义为 `&lt;!--`，解析时还原。这避免用户内容中的注释起始符破坏层标记解析。

---

## 4. 摘要层（summary）

按小节组织，每节一个 `###` 标题 + 一组 `-` 要点：

```
<!-- dcb:layer:summary -->
## 2. 结构化摘要
### 背景与动机
- 用户在做跨会话的长期项目，反复粘贴上下文效率低。
- 希望关键信息零丢失地迁移到新对话。
### 已排除的方案
- 直接拼接完整对话日志（token 爆炸且噪声大）。
```

- 由 `core/summarize.ts` 的抽取式摘要器生成（TF 权重 + 时效加权 + 去重 + 关键词提取，兼容中文/英文）；
- 每小节要点数受配置 `maxBulletsPerSection` 约束；
- 仅保留有要点的小节（无要点的空小节在解析时被过滤）。

---

## 5. 偏好层（preference）与校验和

### 5.1 偏好条目

```
<!-- dcb:layer:preference -->
## 3. 用户偏好与设定
- **[style] comment-style** (explicit) — 代码要加详细注释 <!-- at=1693070000000 -->
- **[role] persona** (inferred) — 你是一位资深架构师 <!-- at=1693070100000 -->
- **[constraint] min-python** (explicit) — 必须兼容 Python 3.8 <!-- at=1693070200000 -->
```

- 格式：`- **[<scope>] <key>** (<explicit|inferred>) — <value> <!-- at=<epoch> -->`；
- `scope ∈ {style, role, constraint}`，`key` 为稳定归一化标识，`explicit` 表示用户明言、`inferred` 表示系统推断；
- 多个相同 `(scope, key)` 编译时按「后写覆盖先写、显式覆盖隐式」归并。

### 5.2 校验和

- `checksum` 是对 **Schema 头之后的正文（body）** 计算出的 sha256（hex）；
- 序列化时**就地重算并写入** Schema 头，因此返回的 `checksum` 始终与正文一致；
- `verifySnapshotDocument(markdown)` 重新计算并比对，用于判定文档是否被篡改或磁盘腐坏；
- 解析切分正则 `FRONT_MATTER_PATTERN` 会吞掉 `---` 之后的所有空行，确保「切出的正文」与「参与校验和计算的正文」逐字节一致——这是早期一个真实 bug 的修复点。

---

## 6. token 估算与预算

- `utils/tokens.ts` 的 `estimateTokens()`：CJK 按 1:1、拉丁文按约 3.6 字符/token 的启发式估算；
- `core/budget.ts` 的 `applyTokenBudget()` 在序列化前按优先级裁剪：
  - 优先级：`directive` > `decision` > `code` > `parameter`；
  - 偏好层占预算封顶 20%；
  - 超出预算时丢弃低优先级内容，并在 `BudgetReport` 中记录被裁剪项，供用户复核；
- 默认上限 `maxTokens = 4096`，可配置扩展至 8192（config 上限 32768）。

---

## 7. 加密信封格式（落盘时）

当 `encryption.enabled=true`，`snapshots.document` 列存储的是**密文信封**，而非上述 Markdown 明文。信封格式由 `security/crypto.ts` 定义：

```
dcb1.<salt>.<iv>.<tag>.<ciphertext>
```

- `dcb1` 为版本前缀；
- `salt`：scrypt 派生密钥的盐（base64url）；
- `iv`：GCM 初始化向量（base64url）；
- `tag`：认证标签（base64url）；
- `ciphertext`：AES-256-GCM 密文（base64url）；
- 密钥由 `encryption.passphrase` 经 scrypt 派生，**口令不落盘**；丢弃口令即等价于加密擦除，快照不可恢复。

> 注意：Markdown 文档格式（本文 §1–§5）描述的是**快照对象**，无论是否加密都适用；加密只作用于「落盘的那份 document」，还原时由 `Cipher.open()` 解密回 Markdown 后再走 §1–§5 的解析流程。
