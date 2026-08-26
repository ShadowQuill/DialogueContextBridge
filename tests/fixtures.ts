import type { ConversationMessage } from '../src/types';

/** 固定基准时间，保证测试可复现。 */
export const BASE_TIME = Date.parse('2026-08-26T08:00:00.000Z');

/**
 * 构造一条对话消息。
 *
 * @param index - 序号，决定 id 与时间偏移。
 * @param role - 消息角色。
 * @param content - 消息内容。
 * @returns 对话消息。
 */
export function message(
  index: number,
  role: ConversationMessage['role'],
  content: string,
): ConversationMessage {
  return {
    id: `msg-${index}`,
    role,
    content,
    createdAt: BASE_TIME + index * 60_000,
  };
}

/**
 * 一段覆盖三层结构的样例对话。
 *
 * 有意包含：代码块、硬性指令、决策结论、技术参数、风格偏好、纯寒暄噪声。
 *
 * @returns 对话消息数组。
 */
export function sampleConversation(): ConversationMessage[] {
  return [
    message(
      1,
      'user',
      '我们要做一个对话上下文桥接插件，背景是跨会话工作时需要反复复制粘贴历史上下文，效率很低。',
    ),
    message(2, 'assistant', '好的'),
    message(
      3,
      'user',
      '你是一位资深架构师。代码要加详细注释，回复请用简体中文。',
    ),
    message(
      4,
      'assistant',
      '考虑到本地优先与全文检索需求，可以对比 SQLite 与 LevelDB 两种方案。LevelDB 没有 FTS 能力，放弃该方案。',
    ),
    message(
      5,
      'user',
      '最终决定采用 SQLite，并且必须启用 FTS5 全文检索。引入的上下文默认不超过 4096 tokens。',
    ),
    message(
      6,
      'assistant',
      '明白了，落库结构如下：\n\n```sql\nCREATE VIRTUAL TABLE snapshot_fts USING fts5(title, summary_text);\n```\n\n下一步需要确认加密方案。',
    ),
  ];
}
