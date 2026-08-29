import { describe, it, expect } from 'vitest';
import type { LlmRuntime, StreamChunk, LlmModelInfo, GenerateOptions } from '@deepseek-ai/dsh-llm';
import { createDshLlmClient } from '../src/dsh/llm';
import { createLlmSummarizer } from '../src/core/llm-summarizer';
import { createExtractiveSummarizer, type SummarizeInput } from '../src/core/summarize';

/** 构造一个 text-delta 分片。 */
function td(text: string, index = 0): StreamChunk {
  return { type: 'text-delta', index, text } as StreamChunk;
}

interface FakeRuntime {
  runtime: LlmRuntime;
  /** 每次 listModels 调用收到的 provider。 */
  listModelsCalls: string[];
  /** 每次 stream 调用收到的完整 GenerateOptions。 */
  streamCalls: GenerateOptions[];
}

/**
 * 用纯内存桩模拟 dsh 的 `LlmRuntime`：
 * - `listModels` 返回预设的模型列表，并记录被调用的 provider；
 * - `stream` 把预设的分片序列按序 yield 出来，记录收到的 options。
 * 便于断言「分片拼接」「默认模型惰性解析」「purpose 路由」等行为。
 *
 * 用 `as unknown as LlmRuntime` 绕开 Cordis Service 的结构性约束——
 * 这里只关心被测代码实际用到的两个方法。
 */
function makeFakeRuntime(models: LlmModelInfo[], chunks: StreamChunk[]): FakeRuntime {
  const listModelsCalls: string[] = [];
  const streamCalls: GenerateOptions[] = [];
  const runtime = {
    async listModels(provider: string): Promise<LlmModelInfo[]> {
      listModelsCalls.push(provider);
      return models;
    },
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      streamCalls.push(options);
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as LlmRuntime;
  return { runtime, listModelsCalls, streamCalls };
}

const ONE_MODEL: LlmModelInfo[] = [
  { provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' },
];

describe('createDshLlmClient · DSH LLM 客户端适配', () => {
  it('把多个 text-delta 分片按序拼接为完整文本', async () => {
    const { runtime, streamCalls } = makeFakeRuntime(ONE_MODEL, [
      td('## 背景与目标\n'),
      td('- 用户想做跨会话桥接插件\n'),
      td('- 目标是可移植知识单元'),
    ]);
    const client = createDshLlmClient(runtime, { provider: 'deepseek', model: 'deepseek-chat' });

    const out = await client.complete('SYS_PROMPT', 'USER_CONTENT');

    expect(out).toBe('## 背景与目标\n- 用户想做跨会话桥接插件\n- 目标是可移植知识单元');
    expect(streamCalls).toHaveLength(1);
  });

  it('请求带 purpose=compaction 并透传 system / provider / 生成参数', async () => {
    const { runtime, streamCalls } = makeFakeRuntime(ONE_MODEL, [td('ok')]);
    const client = createDshLlmClient(runtime, {
      provider: 'deepseek',
      model: 'deepseek-chat',
      maxTokens: 512,
      temperature: 0.1,
    });

    await client.complete('SYS', 'USER');

    const opts = streamCalls[0];
    expect(opts.purpose).toBe('compaction');
    expect(opts.provider).toBe('deepseek');
    expect(opts.model).toBe('deepseek-chat');
    expect(opts.system).toBe('SYS');
    expect(opts.maxTokens).toBe(512);
    expect(opts.temperature).toBe(0.1);
    expect(opts.messages).toHaveLength(1); // 用户内容被包成单条 user message
  });

  it('显式 model 时不再调用 listModels', async () => {
    const { runtime, listModelsCalls, streamCalls } = makeFakeRuntime(ONE_MODEL, [td('ok')]);
    const client = createDshLlmClient(runtime, { provider: 'deepseek', model: 'deepseek-chat' });

    await client.complete('s', 'u');

    expect(listModelsCalls).toEqual([]);
    expect(streamCalls[0].model).toBe('deepseek-chat');
  });

  it('未给 model 时惰性取 listModels 第一个，并跨多次调用缓存', async () => {
    const models: LlmModelInfo[] = [
      { provider: 'p', id: 'model-a', name: 'A' },
      { provider: 'p', id: 'model-b', name: 'B' },
    ];
    const { runtime, listModelsCalls, streamCalls } = makeFakeRuntime(models, [td('ok')]);
    const client = createDshLlmClient(runtime, { provider: 'p' });

    await client.complete('s1', 'u1');
    await client.complete('s2', 'u2');

    // 惰性解析 + 缓存：只查询一次，且两次都用第一个模型
    expect(listModelsCalls).toEqual(['p']);
    expect(streamCalls[0].model).toBe('model-a');
    expect(streamCalls[1].model).toBe('model-a');
  });

  it('provider 下没有任何模型时抛出 DCB_LLM_NO_MODEL', async () => {
    const { runtime } = makeFakeRuntime([], [td('never')]);
    const client = createDshLlmClient(runtime, { provider: 'p' });

    await expect(client.complete('s', 'u')).rejects.toThrow(/DCB_LLM_NO_MODEL/);
  });

  it('端到端：经 createLlmSummarizer 把流式输出解析为 SummarySection', async () => {
    const chunks = [
      td('## 背景与目标\n'),
      td('- 用户想做跨会话桥接插件\n'),
      td('- 目标是可移植的知识单元\n'),
      td('## 冲突裁决\n'),
      td('- 支持 newWins / snapshotWins / timestamp'),
    ];
    const { runtime, streamCalls } = makeFakeRuntime(ONE_MODEL, chunks);
    const client = createDshLlmClient(runtime, { provider: 'deepseek', model: 'deepseek-chat' });
    const summarizer = createLlmSummarizer({
      client,
      fallback: createExtractiveSummarizer(),
    });

    const input: SummarizeInput = {
      maxBulletsPerSection: 6,
      candidates: [
        {
          layer: 'summary',
          text: '用户想做跨会话桥接插件',
          source: { role: 'user', id: 'm1', content: '', createdAt: 1 },
        },
        {
          layer: 'summary',
          text: '目标是可移植的知识单元',
          source: { role: 'assistant', id: 'm2', content: '', createdAt: 2 },
        },
        {
          layer: 'summary',
          text: '冲突裁决支持 newWins、snapshotWins、timestamp',
          source: { role: 'user', id: 'm3', content: '', createdAt: 3 },
        },
      ],
    };

    const sections = await summarizer(input);

    expect(streamCalls[0].purpose).toBe('compaction'); // 确认走的是真实 DSH 适配层
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe('背景与目标');
    expect(sections[0].bullets).toContain('用户想做跨会话桥接插件');
    expect(sections[1].heading).toBe('冲突裁决');
    expect(sections[1].bullets[0]).toContain('newWins');
  });
});
