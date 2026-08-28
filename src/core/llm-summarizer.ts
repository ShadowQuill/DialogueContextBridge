import type { SummarySection } from '../types';
import type { Classification } from './classifier';
import { createExtractiveSummarizer, type Summarizer, type SummarizeInput } from './summarize';

/**
 * LLM 摘要客户端抽象。
 *
 * 核心层只依赖这个极简契约，不关心底层是 DSH 的 `ctx.llm`、还是某个 OpenAI
 * 兼容端点、还是测试用的桩。这样核心编译逻辑始终是纯 Node、可确定性单测，
 * 而真实的模型调用能力由宿主适配层（`src/dsh/llm.ts`）注入。
 */
export interface LlmSummarizeClient {
  /**
   * 一次性文本补全：给定系统提示与用户内容，返回模型生成的纯文本。
   *
   * @param system - 系统提示（角色与输出格式约束）。
   * @param user - 待摘要的内容（此处为已筛除原文/偏好的摘要层候选片段）。
   * @returns 模型输出文本。
   */
  complete(system: string, user: string): Promise<string>;
}

/** 默认系统提示：约束模型产出可控的「`## 标题` + `- 要点`」格式。 */
export const DEFAULT_SUMMARY_SYSTEM_PROMPT = [
  '你是一个对话摘要引擎。下面是一段对话中被标记为「值得摘要」的片段',
  '（已按时间顺序给出，每条前缀标注了发言角色 user/assistant）。',
  '请把它们压缩为结构化的中文摘要小节。',
  '',
  '要求：',
  '- 用 Markdown 输出；每个小节以 `## 小节标题` 开头，标题要概括该段主题',
  '（如「背景与目标」「讨论与推导」「已排除方案」「待办与风险」，也可自定更贴切的标题）。',
  '- 每个小节下列出若干条要点，每条以 `- ` 开头，是一条自洽、信息完整的陈述句。',
  '- 合并重复与冗余，保留关键结论、决策依据、被排除的方案、遗留风险。',
  '- 不要编造对话中不存在的信息；不要包含代码原文或参数原值',
  '（这些已在快照的原文层保留，无需在此复述）。',
  '- 篇幅克制，小节数量通常 2–5 个。',
  '',
  '只输出摘要本身，不要任何额外说明或代码块围栏。',
].join('\n');

/**
 * 解析 LLM 输出的 Markdown 为结构化小节。
 *
 * 兼容 `## 标题` / `# 标题` 以及 `- ` / `* ` / `· ` 开头的要点；
 * 要点前若没有任何标题，则归入兜底小节「其他上下文」。
 *
 * @param raw - 模型原始输出。
 * @returns 解析出的摘要小节（已过滤空小节）。
 */
export function parseLlmSummary(raw: string): SummarySection[] {
  const sections: SummarySection[] = [];
  let current: SummarySection | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { heading: heading[1].trim(), bullets: [] };
      sections.push(current);
      continue;
    }
    const bullet = /^\s*[-*·]\s+(.+?)\s*$/.exec(line);
    if (bullet) {
      if (!current) {
        current = { heading: '其他上下文', bullets: [] };
        sections.push(current);
      }
      current.bullets.push(bullet[1].trim());
    }
  }

  return sections.filter((section) => section.bullets.length > 0);
}

/** LLM 摘要器的配置。 */
export interface LlmSummarizerOptions {
  /** 模型调用客户端；必填。 */
  client: LlmSummarizeClient;
  /** 系统提示覆盖；缺省用 {@link DEFAULT_SUMMARY_SYSTEM_PROMPT}。 */
  systemPrompt?: string;
  /**
   * 每个小节的最大要点数；缺省读 `SummarizeInput.maxBulletsPerSection`。
   * 仅作为 LLM 输出之外的硬上限——解析后多余要点被截断。
   */
  maxBulletsPerSection?: number;
  /**
   * 调用失败或模型返回空内容时的回退摘要器（通常是内置抽取式）。
   * 不提供时失败会抛出， caller 需自行兜底。
   */
  fallback?: Summarizer;
  /** 可选的告警回调（如回退发生时记录日志）。 */
  logger?: (message: string) => void;
}

/**
 * 创建基于 LLM 的摘要器。
 *
 * 与 {@link createExtractiveSummarizer} 实现同一个 `Summarizer` 契约：输入
 * 摘要层候选片段，输出 `SummarySection[]`。区别在于它把压缩工作交给模型，
 * 因此摘要更连贯、更擅长跨片段归纳；代价是一次模型调用（由 `client` 注入）。
 *
 * 健壮性：模型调用抛错、或返回空内容时，自动委托 `fallback`（默认抽取式），
 * 保证 `/compile` 在任何情况下都能产出摘要，不会让一次 LLM 抖动中断快照编译。
 *
 * @param options - 配置，见 {@link LlmSummarizerOptions}。
 * @returns 一个 `Summarizer` 函数。
 */
export function createLlmSummarizer(options: LlmSummarizerOptions): Summarizer {
  const { client, systemPrompt = DEFAULT_SUMMARY_SYSTEM_PROMPT, fallback, logger } = options;

  return async (input: SummarizeInput): Promise<SummarySection[]> => {
    const candidates = input.candidates as readonly Classification[];
    if (candidates.length === 0) return [];

    const userContent = candidates.map((item) => `[${item.source.role}] ${item.text}`).join('\n');

    try {
      const raw = await client.complete(systemPrompt, userContent);
      const sections = parseLlmSummary(raw).map((section) => ({
        heading: section.heading,
        bullets: section.bullets.slice(0, options.maxBulletsPerSection ?? input.maxBulletsPerSection),
      }));
      if (sections.length > 0) return sections;
      logger?.('LLM 摘要返回为空，回退至抽取式摘要');
    } catch (error) {
      logger?.(`LLM 摘要调用失败，回退至抽取式摘要：${error instanceof Error ? error.message : String(error)}`);
    }

    if (fallback) return fallback(input);
    throw new Error('LLM 摘要不可用且未配置回退摘要器');
  };
}

/** 便于测试与入口复用的空实现占位（避免重复 new）。 */
export const sharedExtractiveFallback = (): Summarizer => createExtractiveSummarizer();
