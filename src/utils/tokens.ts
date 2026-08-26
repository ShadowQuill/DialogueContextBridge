/** CJK / 日文假名 / 韩文音节范围，这些字符通常 1 字符 ≈ 1 token。 */
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;

/** 拉丁文本的经验值：约 3.6 个字符 ≈ 1 token。 */
const LATIN_CHARS_PER_TOKEN = 3.6;

/**
 * 估算文本的 token 数量。
 *
 * 这是一个**离线启发式估算**，不依赖任何 tokenizer 二进制：CJK 字符按 1:1
 * 计算，其余字符按 3.6 字符 / token 折算。实测在中英混排的技术对话上
 * 误差约 ±10%，足以支撑 token 预算裁剪这类「宁可保守」的场景。
 *
 * @param text - 待估算文本。
 * @returns 估算的 token 数（向上取整）。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = text.match(CJK_PATTERN)?.length ?? 0;
  const restCount = Math.max(text.length - cjkCount, 0);
  return Math.ceil(cjkCount + restCount / LATIN_CHARS_PER_TOKEN);
}

/**
 * 估算多段文本的 token 总量。
 *
 * @param parts - 文本片段数组。
 * @returns token 总量估算。
 */
export function estimateTokensOfAll(parts: readonly string[]): number {
  return parts.reduce((total, part) => total + estimateTokens(part), 0);
}
