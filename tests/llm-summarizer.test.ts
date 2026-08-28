import { describe, expect, it, vi } from 'vitest';
import { classifyConversation } from '../src/core/classifier';
import type { ConversationMessage } from '../src/types';
import {
  createLlmSummarizer,
  parseLlmSummary,
  type LlmSummarizeClient,
} from '../src/core/llm-summarizer';
import { createExtractiveSummarizer } from '../src/core/summarize';

/** 构造一条对话消息（供分类器产出 summary 层候选）。 */
function msg(id: number, role: ConversationMessage['role'], content: string): ConversationMessage {
  return { id: String(id), role, content, createdAt: id };
}

/** 取分类结果中的 summary 层候选（与 compiler.ts 的过滤一致）。 */
function summaryCandidates(messages: readonly ConversationMessage[]) {
  return classifyConversation(messages).filter((item) => item.layer === 'summary');
}

/** 一个返回固定 Markdown 的桩客户端。 */
function stubClient(text: string): LlmSummarizeClient {
  return { complete: async () => text };
}

describe('parseLlmSummary', () => {
  it('解析 ## 标题 + - 要点 为结构化小节', () => {
    const raw = '## 背景与目标\n- 要做一个跨会话桥接插件\n- 解决上下文丢失\n\n## 讨论与推导\n- 采用三层快照';
    const sections = parseLlmSummary(raw);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe('背景与目标');
    expect(sections[0].bullets).toEqual(['要做一个跨会话桥接插件', '解决上下文丢失']);
    expect(sections[1].heading).toBe('讨论与推导');
  });

  it('要点前无标题时归入兜底小节', () => {
    const sections = parseLlmSummary('- 孤立的要点');
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe('其他上下文');
    expect(sections[0].bullets).toEqual(['孤立的要点']);
  });

  it('过滤空小节', () => {
    expect(parseLlmSummary('## 空小节\n\n## 有内容\n- 一条')).toHaveLength(1);
  });
});

describe('createLlmSummarizer', () => {
  const messages = [
    msg(1, 'user', '我们要做一个跨会话的上下文桥接插件，解决反复复制背景的问题。'),
    msg(2, 'assistant', '可以用三层快照结构来组织：原文、摘要、偏好。'),
  ];
  const candidates = summaryCandidates(messages);

  it('把模型输出解析为 SummarySection[]', async () => {
    const client = stubClient('## 背景与目标\n- 做一个跨会话桥接插件\n- 解决背景复制问题');
    const summarize = createLlmSummarizer({ client });
    const sections = await summarize({ candidates, maxBulletsPerSection: 6 });
    expect(sections).toHaveLength(1);
    expect(sections[0].bullets).toContain('做一个跨会话桥接插件');
  });

  it('按 maxBulletsPerSection 截断要点', async () => {
    const client = stubClient('## 小节\n- a\n- b\n- c\n- d');
    const summarize = createLlmSummarizer({ client });
    const sections = await summarize({ candidates, maxBulletsPerSection: 2 });
    expect(sections[0].bullets).toHaveLength(2);
  });

  it('调用失败时回退到抽取式摘要器', async () => {
    const client: LlmSummarizeClient = { complete: async () => { throw new Error('network'); } };
    const fallback = vi.fn(createExtractiveSummarizer());
    const summarize = createLlmSummarizer({ client, fallback });
    const sections = await summarize({ candidates, maxBulletsPerSection: 6 });
    expect(fallback).toHaveBeenCalledOnce();
    expect(Array.isArray(sections)).toBe(true);
  });

  it('模型返回空内容时回退', async () => {
    const client = stubClient('   \n');
    const fallback = vi.fn(createExtractiveSummarizer());
    const summarize = createLlmSummarizer({ client, fallback });
    await summarize({ candidates, maxBulletsPerSection: 6 });
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('候选为空时直接返回空数组，不触发模型调用', async () => {
    const complete = vi.fn(async () => '## x\n- y');
    const summarize = createLlmSummarizer({ client: { complete } });
    const sections = await summarize({ candidates: [], maxBulletsPerSection: 6 });
    expect(sections).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });
});
