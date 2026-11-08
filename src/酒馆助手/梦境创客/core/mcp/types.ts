// MCP（Model Context Protocol）客户端的数据模型。
// 梦境创客运行在酒馆页面里，无法启动子进程：
//   - `http` / `sse` 直连网络上的 MCP 服务器；
//   - `stdio` 指向酒馆服务端插件（dream-card-agent）的桥接端点，由插件托管子进程。

/**
 * `http` 对应 MCP Streamable HTTP（2025-03-26 起的主流传输）；
 * `sse` 对应旧的 HTTP+SSE 传输；
 * `stdio` 由酒馆服务端插件把本地子进程包装成同源 HTTP 端点。
 */
export type McpTransport = 'http' | 'sse' | 'stdio';

export type McpHeader = {
  name: string;
  value: string;
};

export type McpServerConfig = {
  /** 稳定短标识；参与生成模型可见的工具名，创建后不再变化。 */
  id: string;
  enabled: boolean;
  headers: McpHeader[];
  name: string;
  /** 单次 JSON-RPC 请求的超时时间，单位毫秒。 */
  timeoutMs: number;
  transport: McpTransport;
  /** http/https 绝对地址，或 stdio 桥接用的同源相对路径。 */
  url: string;
};

/** `tools/list` 返回的工具描述，保留服务器给出的原始 JSON Schema。 */
export type McpToolInfo = {
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
  /** 来自 `annotations.readOnlyHint`；缺失时按可能修改数据对待。 */
  readOnly: boolean;
  title?: string;
};

export type McpServerState = 'connecting' | 'error' | 'idle' | 'ready';

export type McpServerStatus = {
  error?: string;
  id: string;
  name: string;
  state: McpServerState;
  toolCount: number;
  tools: McpToolInfo[];
  updatedAt?: number;
};

/** `tools/call` 的内容块；未知类型按文本降级，避免服务器扩展字段导致解析失败。 */
export type McpContentBlock = {
  data?: string;
  mimeType?: string;
  resource?: { text?: string; uri?: string };
  text?: string;
  type: string;
};

export type McpCallToolResult = {
  content: McpContentBlock[];
  isError: boolean;
  structuredContent?: unknown;
};
