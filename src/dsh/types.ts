import type { Context as CordisContext } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import type {
  CommandRuntime,
  CommandDefinition as DshCommandDefinition,
  CommandInvocation,
  CommandResult,
} from '@deepseek-ai/dsh-commands';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ConversationMessage } from '../types';
import type { BridgeService } from '../service';
import type { Config } from '../config';
import type { Logger } from '../utils/logger';

/**
 * DSH 宿主能力的类型接缝（seam），对齐 `@deepseek-ai/dsh` 0.1.1-rc.2 的真实 API。
 *
 * 经核对官方 `extension-cookbook.md` / `architecture.md` 与已安装的 dsh 子包类型，
 * 真实 dsh 的插件契约如下（与早期推断的 `ctx.command` / `ctx.conversation` /
 * `ctx.injector` 不同）：
 *
 * - 人类命令注册 → `ctx.commands.register({ name, description, handler })`，
 *   handler 拿到 `CommandInvocation`（含 `agent` 与 `rawInput`），返回 `CommandResult`。
 * - 对话历史读取 → `agent.session.deriveMessages()`（由 `ctx.sessions` 供给的会话）。
 * - 上下文注入 → `agent.inject(userMessage)`，把背景作为模型可见输入注入下一次请求。
 *
 * 本文件把上述真实 API 包装成插件核心逻辑（编译器 / 存储 / 加密）使用的
 * 最小抽象，使核心代码仍可在纯 Node 下单测，宿主 API 变更时只改本文件。
 *
 * @packageDocumentation
 */

/** dsh 的 Agent 句柄（真实类型别名，供命令层使用）。 */
export type AgentHandle = Agent;
/** dsh 的 Session 句柄（真实类型别名）。 */
export type SessionHandle = Session;

/**
 * 命令执行上下文。由适配层从 `CommandInvocation` 转换而来。
 *
 * 与早期设计不同，这里直接携带 `agent`（可读取当前会话、可注入上下文），
 * 而非一个只暴露 `send` 的会话壳。
 */
export interface CommandContext {
  /** 触发命令的 Agent（真实 dsh Agent 句柄）。 */
  readonly agent: AgentHandle;
  /** 当前会话（对话）id，等价于 `String(agent.id)`。 */
  readonly conversationId: string;
  /** 命令名之后的原始输入文本（需自行解析参数与选项）。 */
  readonly rawInput: string;
  /** 解析出的位置参数（非 `-` 开头的 token）。 */
  readonly args: string[];
  /** 解析出的选项（`--key value` / `--key=value` / `--flag`）。 */
  readonly options: Record<string, string | boolean>;
}

/** 命令回调：返回字符串时作为成功结果回显；返回 void 表示静默成功。 */
export type CommandHandler = (
  ctx: CommandContext,
) => Promise<string | void> | string | void;

/** 平面命令定义（对应真实 dsh 的 `CommandDefinition` 子集）。 */
export interface CommandDefinition {
  /** 小写命令名，不含前导斜杠，如 `compile`、`snapshot-list`。 */
  readonly name: string;
  /** 人类可读摘要，用于发现 UI。 */
  readonly description: string;
  /** 执行逻辑。 */
  readonly handler: CommandHandler;
}

/** 命令注册函数；返回值为注销该命令的副作用 disposer。 */
export type CommandRegistry = (def: CommandDefinition) => () => void;

/** 把一个 dsh Session 的派生消息历史读为 `ConversationMessage[]`。 */
export type ConversationReader = (session: SessionHandle) => Promise<ConversationMessage[]>;

/** 把背景简报作为模型可见上下文注入某个 Agent 的下一轮请求。 */
export type ContextInjector = (agent: AgentHandle, brief: string) => void;

/** 命令依赖，由插件入口装配后传入各命令注册函数。 */
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

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** dsh 命令注册服务（人类命令）。 */
    commands: CommandRuntime;
  }
}

/**
 * 解析命令原始输入为位置参数与选项。
 *
 * 支持 `--key value`、`--key=value`、`-k value`、`-k=value`、`--flag`，
 * 其余 token 归为位置参数。
 *
 * @param rawInput - 命令名之后的原始文本。
 * @returns 解析结果。
 */
export function parseFlags(rawInput: string): { args: string[]; options: Record<string, string | boolean> } {
  const tokens = rawInput.trim().split(/\s+/).filter(Boolean);
  const args: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.startsWith('-') && token.length > 1) {
      const dashed = token.replace(/^-+/, '');
      // 键名转驼峰：`--dry-run` → `dryRun`，`-d` → `d`，与命令层读取保持一致。
      const key = dashed.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      const eq = dashed.indexOf('=');
      if (eq >= 0) {
        options[key] = dashed.slice(eq + 1);
      } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
        options[key] = tokens[i + 1];
        i += 1;
      } else {
        options[key] = true;
      }
    } else {
      args.push(token);
    }
  }
  return { args, options };
}

/** 把 dsh 内容块数组拍平为纯文本（仅提取 `text` 块）。 */
function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (block && typeof block === 'object' && 'type' in block) {
        const b = block as { type: string; text?: unknown };
        return b.type === 'text' && typeof b.text === 'string' ? b.text : '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * 构造对接真实 dsh 的命令注册器。
 *
 * @param ctx - Cordis 上下文（需已注入 `ctx.commands`）。
 * @returns 命令注册函数；缺失 `ctx.commands` 时抛出可读错误。
 * @throws 宿主未提供 `ctx.commands` 时抛出 `DCB_HOST_CAPABILITY_MISSING`。
 */
export function createDshCommandRegistry(ctx: CordisContext): CommandRegistry {
  const runtime = ctx.commands;
  if (!runtime || typeof runtime.register !== 'function') {
    throw new Error(
      'DCB_HOST_CAPABILITY_MISSING: 宿主未提供 ctx.commands，无法注册 /compile、/save 等命令',
    );
  }
  return (def: CommandDefinition): (() => void) => {
    const dshDef: DshCommandDefinition = {
      name: def.name,
      description: def.description,
      handler: async (inv: CommandInvocation): Promise<CommandResult> => {
        const { args, options } = parseFlags(inv.rawInput);
        try {
          const result = await def.handler({
            agent: inv.agent,
            conversationId: String(inv.agent.id),
            rawInput: inv.rawInput,
            args,
            options,
          });
          return {
            kind: 'success',
            text: typeof result === 'string' ? result : undefined,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { kind: 'error', text: message };
        }
      },
    };
    return runtime.register(dshDef);
  };
}

/**
 * 构造对接真实 dsh 的会话历史读取器。
 *
 * @returns 读取器；内部调用 `session.deriveMessages()` 并映射为 `ConversationMessage[]`。
 */
export function createDshConversationReader(): ConversationReader {
  return async (session: Session): Promise<ConversationMessage[]> => {
    const messages = session.deriveMessages();
    return messages.map((message, index) => ({
      id: String(message.id),
      role: normalizeRole(message.role),
      content: blocksToText(message.content),
      createdAt: index,
    }));
  };
}

/** 把 dsh 的消息角色归一化为本插件的三类角色。 */
function normalizeRole(role: string): ConversationMessage['role'] {
  if (role === 'assistant') return 'assistant';
  if (role === 'system') return 'system';
  return 'user';
}

/**
 * 构造对接真实 dsh 的上下文注入器。
 *
 * 把背景简报包成一条 `plugin` 来源的 user 消息，通过 `agent.inject()` 注入下一轮请求。
 *
 * @param pluginName - 插件名，写入消息来源以便溯源。
 * @returns 注入器。
 */
export function createDshContextInjector(pluginName: string): ContextInjector {
  return (agent: Agent, brief: string): void => {
    agent.inject(
      createUserMessage({
        content: [{ type: 'text', text: brief }],
        source: { kind: 'plugin', plugin: pluginName },
      }),
    );
  };
}
