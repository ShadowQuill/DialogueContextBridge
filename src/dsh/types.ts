import type { Context as CordisContext } from 'cordis';
import type { ConversationMessage } from '../types';

/**
 * DSH 宿主能力的类型接缝（seam）。
 *
 * 本插件的核心逻辑（编译器 / 存储 / 加密）完全不依赖宿主，只有命令注册与
 * 对话读取需要宿主提供服务。这里用**最小接口**声明所依赖的宿主能力，并通过
 * 模块增强挂到 Cordis 的 `Context` 上：
 *
 * - 好处：核心代码可在纯 Node 下单测；宿主 API 变更时只需改本文件；
 * - 代价：类型是「我们期望的形状」，与 DSH 实际实现之间需要一次对齐。
 *   若宿主签名不同，只需调整本文件与 {@link ../commands} 中的适配代码。
 *
 * 运行时不做 duck-typing 猜测：{@link requireCommandRegistry} 会在能力缺失时
 * 抛出可读错误，而不是静默降级。
 *
 * @packageDocumentation
 */

/** 命令执行会话。 */
export interface CommandSession {
  /** 当前对话 id。 */
  conversationId: string;
  /** 触发命令的用户标识（可选，用于多用户宿主）。 */
  userId?: string;
  /**
   * 向当前对话发送一条消息。
   *
   * @param content - Markdown 文本。
   */
  send(content: string): Promise<void> | void;
}

/** 命令回调的执行上下文。 */
export interface CommandArgv {
  /** 会话。 */
  session: CommandSession;
  /** 解析后的选项。 */
  options: Record<string, unknown>;
  /** 位置参数。 */
  args: string[];
}

/** 命令回调：返回字符串时由宿主直接回显。 */
export type CommandHandler = (
  argv: CommandArgv,
  ...args: string[]
) => Promise<string | void> | string | void;

/** 选项声明的补充配置。 */
export interface CommandOptionConfig {
  /** 默认值。 */
  fallback?: unknown;
  /** 选项描述。 */
  description?: string;
}

/** 命令构建器（链式 API）。 */
export interface CommandBuilder {
  /**
   * 注册别名。
   *
   * @param name - 别名。
   * @returns 构建器自身。
   */
  alias(name: string): CommandBuilder;
  /**
   * 声明选项。
   *
   * @param name - 选项名。
   * @param declaration - 声明字符串，例如 `-t <tags:string>`。
   * @param config - 补充配置。
   * @returns 构建器自身。
   */
  option(name: string, declaration: string, config?: CommandOptionConfig): CommandBuilder;
  /**
   * 设置用法说明。
   *
   * @param text - 说明文本。
   * @returns 构建器自身。
   */
  usage(text: string): CommandBuilder;
  /**
   * 追加示例。
   *
   * @param text - 示例文本。
   * @returns 构建器自身。
   */
  example(text: string): CommandBuilder;
  /**
   * 绑定执行逻辑。
   *
   * @param handler - 回调。
   * @returns 构建器自身。
   */
  action(handler: CommandHandler): CommandBuilder;
}

/** 宿主的命令注册函数。 */
export type CommandRegistry = (declaration: string, description?: string) => CommandBuilder;

/** 读取对话历史的参数。 */
export interface HistoryOptions {
  /** 最多读取的消息条数（从最近往前）。 */
  limit?: number;
  /** 仅读取该时间点之后的消息（epoch 毫秒）。 */
  since?: number;
}

/** 宿主的对话服务。 */
export interface ConversationService {
  /**
   * 读取指定对话的消息历史。
   *
   * @param conversationId - 对话 id。
   * @param options - 读取参数。
   * @returns 消息数组（时间升序）。
   */
  history(conversationId: string, options?: HistoryOptions): Promise<ConversationMessage[]>;
}

/**
 * 宿主提供的系统提示注入能力（Phase 2 导入注入）。
 *
 * 真正的「上下文桥接」不是把背景简报作为一条普通消息发出，而是把它封装进
 * 目标对话的**系统提示 / 上下文头部**，作为一份静态、只读的背景情报。这样
 * 新对话的后续交互都基于该快照推导，且不反向污染快照本身。
 *
 * 若宿主未提供该能力，命令层会用 {@link createSessionInjector} 降级为「以消息
 * 形式下发」，保证骨架在任意宿主下都能演示导入流程。
 */
export interface InjectionService {
  /**
   * 把背景简报注入到指定对话的系统上下文头部。
   *
   * @param conversationId - 目标对话 id。
   * @param brief - 已渲染好的只读背景简报（Markdown）。
   */
  inject(conversationId: string, brief: string): Promise<void> | void;
}

declare module 'cordis' {
  interface Context {
    /** DSH 命令注册入口。 */
    command: CommandRegistry;
    /** DSH 对话服务。 */
    conversation: ConversationService;
    /** DSH 系统提示注入能力（宿主未提供时为 undefined）。 */
    injector?: InjectionService;
  }
}

/**
 * 取出宿主的命令注册能力。
 *
 * @param ctx - Cordis 上下文。
 * @returns 命令注册函数。
 * @throws 宿主未提供 `ctx.command` 时抛出可读错误。
 */
export function requireCommandRegistry(ctx: CordisContext): CommandRegistry {
  if (typeof ctx.command !== 'function') {
    throw new Error(
      'DCB_HOST_CAPABILITY_MISSING: 宿主未提供 ctx.command，无法注册 /compile、/save 等命令',
    );
  }
  return ctx.command.bind(ctx);
}

/**
 * 取出宿主的对话服务。
 *
 * @param ctx - Cordis 上下文。
 * @returns 对话服务；宿主未提供时返回 undefined（命令层会给出提示）。
 */
export function optionalConversationService(ctx: CordisContext): ConversationService | undefined {
  const service = ctx.conversation;
  return typeof service?.history === 'function' ? service : undefined;
}

/**
 * 取出宿主的系统提示注入能力。
 *
 * @param ctx - Cordis 上下文。
 * @returns 注入服务；宿主未提供时返回 undefined。
 */
export function optionalInjectionService(ctx: CordisContext): InjectionService | undefined {
  const service = ctx.injector;
  return typeof service?.inject === 'function' ? service : undefined;
}

/**
 * 构造会话降级注入器。
 *
 * 当宿主未提供真正的系统提示注入时（{@link optionalInjectionService} 返回
 * undefined），用它将背景简报作为一条「上下文桥接」消息下发到当前对话。简报
 * 本身已带有只读标记，因此即使以消息形式出现，语义上仍不回写快照。
 *
 * @param session - 命令执行会话（提供 `send`）。
 * @returns 一个仅把简报转发给 `session.send` 的注入服务。
 */
export function createSessionInjector(session: CommandSession): InjectionService {
  return {
    inject(_conversationId: string, brief: string): void {
      void session.send(
        [
          '> 🔌 当前宿主未提供系统提示注入能力，以下背景简报以消息形式下发（仍属只读背景，请勿回写快照）：',
          '',
          brief,
        ].join('\n'),
      );
    },
  };
}
