import type {
  CommandRegistry,
  ConversationReader,
  ContextInjector,
  SessionHandle,
} from '../dsh/types';
import type { BridgeService } from '../service';
import type { Config } from '../config';
import type { ConversationMessage } from '../types';
import type { Logger } from '../utils/logger';

/** 命令注册所需的依赖。 */
export interface CommandDeps {
  /** 命令注册函数。 */
  readonly registry: CommandRegistry;
  /** 桥接服务。 */
  readonly service: BridgeService;
  /** 会话历史读取器。 */
  readonly reader: ConversationReader;
  /** 上下文注入器。 */
  readonly injector: ContextInjector;
  /** 插件配置。 */
  readonly config: Config;
  /** 日志器。 */
  readonly logger: Logger;
}

/**
 * 把选项值安全地转成字符串。
 *
 * @param value - 原始选项值。
 * @returns 去空后的字符串；不可用时返回 undefined。
 */
export function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 把选项值安全地转成正整数。
 *
 * @param value - 原始选项值。
 * @returns 正整数；不可用时返回 undefined。
 */
export function asPositiveInt(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(asString(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

/**
 * 判断布尔型选项是否开启。
 *
 * @param value - 原始选项值。
 * @returns 开启返回 true。
 */
export function asFlag(value: unknown): boolean {
  return value === true || value === 'true' || value === 1;
}

/**
 * 解析标签选项（支持逗号 / 中文逗号 / 空格分隔）。
 *
 * @param value - 原始选项值。
 * @returns 去重后的标签数组。
 */
export function parseTagOption(value: unknown): string[] {
  const raw = asString(value);
  if (!raw) return [];
  return [...new Set(raw.split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean))];
}

/**
 * 读取某个会话的消息历史。
 *
 * @param deps - 命令依赖。
 * @param session - dsh 会话句柄（来自触发命令的 Agent）。
 * @returns 消息数组。
 */
export async function loadMessages(
  deps: CommandDeps,
  session: SessionHandle,
): Promise<ConversationMessage[]> {
  return deps.reader(session);
}

/**
 * 统一包装命令回调的异常，避免把堆栈直接抛给用户。
 *
 * @param logger - 日志器。
 * @param scope - 命令名，用于日志定位。
 * @param handler - 实际逻辑。
 * @returns 包装后的回调，异常时返回可读错误文本。
 */
export function guard<A extends unknown[]>(
  logger: Logger,
  scope: string,
  handler: (...args: A) => Promise<string | void> | string | void,
): (...args: A) => Promise<string> {
  return async (...args: A): Promise<string> => {
    try {
      const result = await handler(...args);
      return typeof result === 'string' ? result : '';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`${scope} 执行失败: ${message}`);
      return `❌ ${scope} 执行失败：${message}`;
    }
  };
}
