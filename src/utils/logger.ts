/** 日志级别。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** 极简日志接口，便于在测试中替换为 spy。 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * 创建带作用域前缀的日志器。
 *
 * 之所以不直接复用宿主 logger：本插件的核心模块（编译器、存储层）需要在
 * 纯 Node 环境下可单测，不能耦合 Cordis 上下文。宿主注入时可用
 * {@link createLogger} 的返回值形状适配任意实现。
 *
 * @param scope - 作用域名称，会以 `[scope]` 形式作为前缀输出。
 * @param level - 最低输出级别，默认 `info`。
 * @returns 日志器实例。
 */
export function createLogger(scope: string, level: LogLevel = 'info'): Logger {
  const threshold = LEVEL_WEIGHT[level];
  const prefix = `[${scope}]`;

  const emit =
    (target: LogLevel, sink: (...args: unknown[]) => void) =>
    (message: string, ...args: unknown[]): void => {
      if (LEVEL_WEIGHT[target] < threshold) return;
      sink(`${prefix} ${message}`, ...args);
    };

  /* eslint-disable no-console */
  return {
    debug: emit('debug', console.error),
    info: emit('info', console.error),
    warn: emit('warn', console.warn),
    error: emit('error', console.error),
  };
  /* eslint-enable no-console */
}

/** 什么都不做的日志器，用于测试或显式静音。 */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
