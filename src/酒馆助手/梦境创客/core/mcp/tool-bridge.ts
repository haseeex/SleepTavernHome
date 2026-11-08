import { jsonSchema, tool } from 'ai';
import { richToolOutput } from '../runner/tool-output';
import type { RunnerTool, ToolConfirmation } from '../runner/tools';
import { mcpToolName } from './config';
import type { McpCallToolResult, McpContentBlock, McpServerConfig, McpToolInfo } from './types';

export type McpToolBridgeOptions = {
  approvalMode: () => 'full' | 'manual' | 'yolo';
  call: (toolName: string, args: unknown, signal?: AbortSignal) => Promise<McpCallToolResult>;
  server: McpServerConfig;
  /** 已由管理器去重后的模型侧工具名。 */
  name: string;
  tool: McpToolInfo;
};

const MAX_MCP_OUTPUT_CHARACTERS = 100_000;

function contentText(content: McpContentBlock[]): string {
  const text = content
    .flatMap(block => {
      if (block.type === 'text' && block.text) return [block.text];
      if (block.type === 'resource' && block.resource?.text) return [block.resource.text];
      if (block.type === 'resource' && block.resource?.uri) return [`[资源 ${block.resource.uri}]`];
      if (block.type === 'image') {
        const kilobytes = block.data ? Math.round((block.data.length * 3) / 4 / 1024) : 0;
        return [`[图片 ${block.mimeType ?? '未知类型'}${kilobytes ? ` · ${kilobytes} KB` : ''}]`];
      }
      return [`[${block.type} 内容]`];
    })
    .join('\n');
  if (text.length <= MAX_MCP_OUTPUT_CHARACTERS) return text;
  return `${text.slice(0, MAX_MCP_OUTPUT_CHARACTERS)}\n…（输出已截断，共 ${text.length} 字符）`;
}

/** 会话记录会序列化 display，所以这里不带 base64 正文，只留类型与文本。 */
function displayContent(content: McpContentBlock[]) {
  return content.map(block => ({
    mimeType: block.mimeType,
    text: block.text ?? block.resource?.text,
    type: block.type,
    uri: block.resource?.uri,
  }));
}

/**
 * MCP 服务器返回 isError 时，content 里往往是它自己的原始异常文本
 * （例如 `Network Error: This operation was aborted`）。
 * 直接原样抛出会让用户以为是梦境创客出了问题，这里补一句归因与建议。
 */
export function describeMcpToolError(message: string, serverName: string, toolName: string): string {
  const head = `MCP 工具 ${serverName} / ${toolName} 执行失败：${message}`;
  if (/this operation was aborted|operation was aborted|aborterror/iu.test(message)) {
    return (
      `${head}\n` +
      '这是服务器内部的请求被取消或超时，不是梦境创客取消的。常见于服务器访问它的后端（如自建检索实例）超时，' +
      '可在 stdio-mcp.json 里给该服务器调大 timeoutMs，或检查后端服务是否响应缓慢。'
    );
  }
  if (/network ?error|failed to fetch|fetch failed|econnrefused|enotfound|etimedout|econnreset/iu.test(message)) {
    return (
      `${head}\n` +
      '服务器无法访问它的后端服务。请确认该后端地址可达（自签证书还需系统信任），' +
      '或先用同样的参数手动请求一次后端确认它本身正常。'
    );
  }
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden/iu.test(message)) {
    return `${head}\n后端拒绝了鉴权，请检查该服务器配置里的密钥或请求标头。`;
  }
  return head;
}

function modelValue(result: McpCallToolResult): unknown {
  const text = contentText(result.content);
  if (result.structuredContent !== undefined) {
    return { content: text || undefined, structuredContent: result.structuredContent };
  }
  return text;
}

/**
 * 把单个 MCP 工具映射成 RunnerTool。
 * 描述里带上服务器名，方便模型在多台服务器之间区分同名工具。
 */
export function createMcpRunnerTool(options: McpToolBridgeOptions): RunnerTool {
  const { name, server, tool: info } = options;
  const description = [`[MCP ${server.name}]`, info.description || info.title || info.name]
    .filter(Boolean)
    .join(' ')
    .slice(0, 4_096);
  return {
    confirmation: (input, toolCallId): ToolConfirmation | undefined => {
      if (options.approvalMode() !== 'manual' || info.readOnly) return undefined;
      return {
        description: `将调用 MCP 工具：${server.name} / ${info.title || info.name}`,
        intent: input,
        risk: 'ordinary',
        toolCallId,
        toolName: name,
      };
    },
    definition: tool({
      description,
      inputSchema: jsonSchema<Record<string, unknown>>(info.inputSchema),
    }),
    execute: async (input, _toolCallId, context) => {
      const result = await options.call(info.name, input, context?.abortSignal);
      if (result.isError) {
        const message = contentText(result.content) || 'MCP 工具返回了错误，但没有提供详细信息。';
        throw new Error(describeMcpToolError(message, server.name, info.name));
      }
      return richToolOutput({ type: 'json', value: modelValue(result) as never }, {
        content: displayContent(result.content),
        isError: false,
        server: server.name,
        structuredContent: result.structuredContent,
        text: contentText(result.content),
        tool: info.name,
      });
    },
    name,
    readonly: info.readOnly,
  };
}

/** 同一台服务器内的工具名可能超过长度上限或被替换字符，这里保证最终名称唯一。 */
export function createMcpRunnerTools(
  server: McpServerConfig,
  tools: McpToolInfo[],
  options: {
    approvalMode: () => 'full' | 'manual' | 'yolo';
    call: (toolName: string, args: unknown, signal?: AbortSignal) => Promise<McpCallToolResult>;
  },
): RunnerTool[] {
  const used = new Set<string>();
  return tools.map(info => {
    const base = mcpToolName(server.id, info.name);
    let name = base;
    let index = 2;
    while (used.has(name)) {
      const suffix = `_${index++}`;
      name = `${base.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
    }
    used.add(name);
    return createMcpRunnerTool({ approvalMode: options.approvalMode, call: options.call, name, server, tool: info });
  });
}
