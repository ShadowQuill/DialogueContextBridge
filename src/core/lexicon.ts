import type { PreferenceScope, VerbatimKind } from '../types';

/**
 * 语义识别词典。
 *
 * Phase 1 的分层提取采用「规则优先、模型可插拔」的策略：这里集中维护所有
 * 中英文触发词与正则，使规则可被单独测试、可被用户在配置中扩展，而不是把
 * 魔法字符串散落在分类器里。
 *
 * @packageDocumentation
 */

/** 围栏代码块（```lang ... ```）。 */
export const FENCED_CODE_PATTERN = /```([\w+#.-]*)\r?\n([\s\S]*?)```/g;

/** 行内命令行提示符，用于识别未加围栏的命令。 */
export const SHELL_LINE_PATTERN = /^\s*(?:\$|>|#)\s+\S+/;

/** 一条原文类别的识别规则。 */
export interface VerbatimRule {
  /** 命中后归入的原文类别。 */
  kind: VerbatimKind;
  /** 规则优先级，数值越大越优先（同一句可能命中多条规则）。 */
  weight: number;
  /** 触发正则。 */
  pattern: RegExp;
}

/**
 * 原文层识别规则表。
 *
 * 判定顺序由 `weight` 决定：硬性指令 > 决策结论 > 技术参数。
 */
export const VERBATIM_RULES: readonly VerbatimRule[] = [
  {
    kind: 'directive',
    weight: 40,
    pattern:
      /(必须|禁止|不要|不得|一定要|务必|严格遵循|强制|must|must not|never|always|do not|don't)/i,
  },
  {
    kind: 'decision',
    weight: 30,
    pattern:
      /(最终(决定|敲定|采用|方案)|确定(采用|使用|为)|我们(决定|采用|选择)|结论(是|为)?|定稿|拍板|decided|we will use|conclusion|final(ly)? (choose|pick|adopt))/i,
  },
  {
    kind: 'parameter',
    weight: 20,
    pattern:
      /(\b\d+(?:\.\d+)?\s*(?:tokens?|ms|s|kb|mb|gb|%|次|个|条|位)\b|\bv?\d+\.\d+(?:\.\d+)?\b|端口\s*\d+|port\s*\d+|超时|阈值|上限|默认值|timeout|threshold|max|limit)/i,
  },
];

/** 一条偏好识别规则。 */
export interface PreferenceRule {
  /** 稳定偏好键，用于跨快照去重与冲突裁决。 */
  key: string;
  /** 偏好作用域。 */
  scope: PreferenceScope;
  /** 触发正则。 */
  pattern: RegExp;
}

/**
 * 偏好层识别规则表。
 *
 * `key` 必须稳定：Phase 3 的智能融合引擎依赖它判断「同一偏好的新旧两个版本」。
 */
export const PREFERENCE_RULES: readonly PreferenceRule[] = [
  {
    key: 'style.code-comments',
    scope: 'style',
    pattern: /(加(上|入)?详细注释|注释要(详细|完整)|comment(s)? (should|must) be|带注释)/i,
  },
  {
    key: 'style.language',
    scope: 'style',
    pattern: /(用(中文|英文|简体中文)(回答|回复|输出|写)|answer in (chinese|english)|回复请用)/i,
  },
  {
    key: 'style.verbosity',
    scope: 'style',
    pattern: /(简洁|精简|不要(废话|铺垫)|详细展开|尽量详细|be concise|be brief|verbose)/i,
  },
  {
    key: 'style.format',
    scope: 'style',
    pattern: /(用(表格|列表|markdown)(输出|呈现|表示)|输出格式(为|是)|以\s*json\s*(返回|输出))/i,
  },
  {
    key: 'style.commit-convention',
    scope: 'style',
    pattern: /(conventional commits|提交信息(遵循|规范)|commit message)/i,
  },
  {
    key: 'role.persona',
    scope: 'role',
    pattern: /(你是一(位|名)|请扮演|以.{0,12}(专家|架构师|工程师|评审者)的(身份|视角)|you are an? .{0,40}(engineer|architect|expert))/i,
  },
  {
    key: 'constraint.runtime',
    scope: 'constraint',
    pattern: /(必须兼容|兼容性要求|只能使用|不能使用|仅支持|compatible with|only use|must support)/i,
  },
  {
    key: 'constraint.stack',
    scope: 'constraint',
    pattern: /(技术栈(是|为|限定)|统一使用|框架(选用|固定为)|开发语言(是|为))/i,
  },
  {
    key: 'constraint.style-guide',
    scope: 'constraint',
    pattern: /(风格指南|style guide|airbnb|eslint 规则|lint 规范)/i,
  },
];

/** 摘要小节的分桶规则。 */
export interface SummaryBucketRule {
  /** 小节标题。 */
  heading: string;
  /** 命中该桶的触发正则；`null` 表示兜底桶。 */
  pattern: RegExp | null;
}

/**
 * 摘要层分桶规则表。
 *
 * 顺序即最终小节的呈现顺序；未命中任何显式规则的内容进入兜底桶。
 */
export const SUMMARY_BUCKETS: readonly SummaryBucketRule[] = [
  {
    heading: '背景与目标',
    pattern: /(背景|目标|需求|痛点|为了|希望|想要|goal|background|requirement|problem)/i,
  },
  {
    heading: '讨论与推导',
    pattern: /(因为|所以|考虑到|对比|权衡|方案|设计|实现|思路|because|therefore|trade[- ]?off|approach)/i,
  },
  {
    heading: '已排除方案',
    pattern: /(放弃|排除|不采用|否决|行不通|不合适|风险太大|rejected|ruled out|won't work|discard)/i,
  },
  {
    heading: '待办与风险',
    pattern: /(待办|todo|下一步|后续|遗留|风险|未确定|待确认|next step|pending|risk|unresolved)/i,
  },
  { heading: '其他上下文', pattern: null },
];

/** 应当整段忽略的噪声消息（纯寒暄、纯确认）。 */
export const NOISE_PATTERN =
  /^\s*(?:好的?|收到|ok|okay|嗯+|谢谢|thanks?|thx|明白了?|了解|👍|done|sure)[\s!。！.~]*$/i;
