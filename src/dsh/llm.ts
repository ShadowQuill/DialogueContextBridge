import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { LlmSummarizeClient } from '../core/llm-summarizer';

/** 构造 DSH LLM 客户端所需的参数。 */
export interface DshLlmClientOptions {
  /** provider 路由（需宿主已在该 provider 下配置可用的 API Key）。 */
  provider: string;
  /**
   * 模型 id；留空时从 `runtime.listModels(provider)` 取第一个可用模型
   * （适用于「让宿主决定用哪个默认模型」的场景）。
   */
  model?: string;
  /** 单次摘要生成的最大 token 数。 */
  maxTokens?: number;
  /** 采样温度，越低越确定。 */
  temperature?: number;
}

/**
 * 把 DSH 的 `LlmRuntime` 适配为核心层需要的 {@link LlmSummarizeClient}。
 *
 * 通过 `runtime.stream(GenerateOptions)` 发一次性补全请求，拼装 `text-delta`
 * 增量得到纯文本输出；`purpose: 'compaction'` 让宿主把这次调用识别为「压缩/
 * 摘要」类辅助调用，便于按用途做独立的生成策略与计量。
 *
 * 模型 id 在首次调用时惰性解析：显式给定则直接用；为空则从 `listModels`
 * 取该 provider 的第一个模型，从而无需用户精确记忆模型字符串。
 *
 * @param runtime - dsh 的 LLM 运行时（`ctx.llm`）。
 * @param options - provider / model / 生成参数。
 * @returns 符合核心层契约的 LLM 摘要客户端。
 */
export function createDshLlmClient(runtime: LlmRuntime, options: DshLlmClientOptions): LlmSummarizeClient {
  const { provider, model = '', maxTokens = 1024, temperature = 0.2 } = options;
  let resolvedModel: string | undefined;

  const resolveModel = async (): Promise<string> => {
    if (resolvedModel) return resolvedModel;
    if (model) {
      resolvedModel = model;
      return resolvedModel;
    }
    const models = await runtime.listModels(provider);
    if (models.length === 0) {
      throw new Error(`DCB_LLM_NO_MODEL: provider=${provider} 下没有任何可用模型，请检查宿主 LLM 配置`);
    }
    resolvedModel = models[0].id;
    return resolvedModel;
  };

  return {
    async complete(system: string, user: string): Promise<string> {
      const modelId = await resolveModel();
      const messages = [
        createUserMessage({
          content: [{ type: 'text', text: user }],
          source: { kind: 'user' },
        }),
      ];

      const stream = runtime.stream({
        provider,
        model: modelId,
        system,
        messages,
        maxTokens,
        temperature,
        purpose: 'compaction',
      });

      let text = '';
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text;
      }
      return text;
    },
  };
}
