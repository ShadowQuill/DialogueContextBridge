/**
 * 对话上下文桥接（DialogueContextBridge）核心数据模型。
 *
 * 快照（Snapshot）是本插件的数据核心，它不是对话日志的转储，而是一个
 * 高度结构化的三层复合体：
 *
 * 1. `verbatim`   —— 关键消息原文层：不可压缩、需精确复现的原子级内容。
 * 2. `summary`    —— 结构化摘要层：讨论背景、推导过程、已排除方案的压缩概要。
 * 3. `preferences`—— 用户偏好与设定层：风格偏好、角色设定、硬性约束。
 *
 * 所有类型均为纯数据结构（plain object），可直接 JSON / Markdown 双向序列化，
 * 以保证「任何能读纯文本的 Agent 都能接手」。
 *
 * @packageDocumentation
 */

/** 快照三层结构的层标识。 */
export type SnapshotLayer = 'verbatim' | 'summary' | 'preference';

/** 快照文档的 Schema 版本号，用于向后兼容解析。 */
export const SNAPSHOT_SCHEMA_VERSION = '1.0';

/** 对话消息角色。 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * 由 DSH 宿主提供的一条对话消息。
 *
 * 这是插件与宿主之间唯一的输入契约：只要宿主能提供该结构的数组，
 * 编译器即可工作，因此本插件不依赖任何特定的对话存储实现。
 */
export interface ConversationMessage {
  /** 宿主侧的消息唯一标识。 */
  id: string;
  /** 消息角色。 */
  role: MessageRole;
  /** 消息纯文本内容（Markdown）。 */
  content: string;
  /** 消息创建时间（epoch 毫秒），用于冲突裁决与排序。 */
  createdAt: number;
}

/** 关键消息原文的语义类别。 */
export type VerbatimKind =
  /** 代码片段、配置片段、命令行。 */
  | 'code'
  /** 最终敲定的决策结论。 */
  | 'decision'
  /** 具体的技术参数、阈值、版本号。 */
  | 'parameter'
  /** 用户明确下达的硬性指令。 */
  | 'directive';

/** 原文层条目：逐字保留，禁止摘要压缩。 */
export interface VerbatimEntry {
  /** 条目标识（快照内唯一）。 */
  id: string;
  /** 来源消息 id，便于回溯原始对话。 */
  sourceMessageId: string;
  /** 来源消息角色。 */
  sourceRole: MessageRole;
  /** 语义类别。 */
  kind: VerbatimKind;
  /** 代码语言标识（仅 `kind === 'code'` 时有值）。 */
  language?: string;
  /** 逐字原文。 */
  content: string;
  /** 来源消息时间戳（epoch 毫秒）。 */
  createdAt: number;
}

/** 摘要层的一个逻辑小节。 */
export interface SummarySection {
  /** 小节标题，例如「背景与目标」。 */
  heading: string;
  /** 该小节下的要点列表，每条为一句自洽的陈述。 */
  bullets: string[];
}

/** 偏好层条目的作用域。 */
export type PreferenceScope =
  /** 输出风格偏好，如「代码要加详细注释」。 */
  | 'style'
  /** 角色扮演设定，如「你是一位资深架构师」。 */
  | 'role'
  /** 项目硬性约束，如「必须兼容 Python 3.8」。 */
  | 'constraint';

/** 偏好层条目。 */
export interface PreferenceEntry {
  /** 稳定的偏好键，用于跨快照去重与冲突裁决，例如 `style.code-comments`。 */
  key: string;
  /** 偏好的自然语言表述。 */
  value: string;
  /** 作用域。 */
  scope: PreferenceScope;
  /** 是否为用户明示（false 表示由系统从对话中推断）。 */
  explicit: boolean;
  /** 首次出现的时间戳（epoch 毫秒）。 */
  createdAt: number;
}

/** 快照元信息（对应 Markdown 文档的自描述 Schema 头）。 */
export interface SnapshotMeta {
  /** 快照唯一标识。 */
  snapshotId: string;
  /** 来源对话 id。 */
  sourceConversationId: string;
  /** 人类可读标题。 */
  title: string;
  /** 一句话描述，用于列表展示与检索。 */
  description: string;
  /** 标签，用于分类检索。 */
  tags: string[];
  /** 快照生成时间（epoch 毫秒）。 */
  createdAt: number;
  /** 快照文档 Schema 版本。 */
  schemaVersion: string;
  /** 三层内容的 token 估算值（不含 Schema 头）。 */
  tokenEstimate: number;
  /** 落库时正文是否为 AES-256-GCM 密文。 */
  encrypted: boolean;
  /** 正文校验和（`sha256:<hex>`），用于完整性校验。 */
  checksum: string;
  /**
   * 合并优先级（用户主动标记的权重），默认 0。
   *
   * 在 `/import --mode merge --policy weighted` 下，冲突时 `weight` 高的一方胜；
   * 平局回退到「当前对话胜」。该字段在 `/snapshot-weight` 命令中设置，随快照落盘。
   */
  weight?: number;
}

/** 完整的三层对话上下文快照。 */
export interface ContextSnapshot {
  /** 元信息。 */
  meta: SnapshotMeta;
  /** 第一层：关键消息原文。 */
  verbatim: VerbatimEntry[];
  /** 第二层：结构化摘要。 */
  summary: SummarySection[];
  /** 第三层：用户偏好与设定。 */
  preferences: PreferenceEntry[];
}

/** token 预算裁剪过程中被丢弃的内容统计。 */
export interface BudgetReport {
  /** 被丢弃的原文条目数。 */
  droppedVerbatim: number;
  /** 被丢弃的摘要要点数。 */
  droppedBullets: number;
  /** 被丢弃的偏好条目数。 */
  droppedPreferences: number;
  /** 裁剪后的 token 估算值。 */
  tokenEstimate: number;
  /** 生效的 token 上限。 */
  budget: number;
}
