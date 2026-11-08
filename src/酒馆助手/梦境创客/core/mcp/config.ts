import type { McpHeader, McpServerConfig, McpToolInfo, McpTransport } from './types';

export const MCP_TOOL_NAME_PREFIX = 'mcp__';
/** 模型侧工具名长度上限（OpenAI 兼容实现普遍限制 64）。 */
export const MCP_TOOL_NAME_MAX_LENGTH = 64;
/**
 * 默认请求超时。与服务端插件（stdio-mcp.js 的 DEFAULT_TIMEOUT_MS）保持一致：
 * 联网搜索类工具单次可能要几十秒，60 秒偏紧。
 */
export const DEFAULT_MCP_TIMEOUT_MS = 120_000;
export const MIN_MCP_TIMEOUT_MS = 5_000;
export const MAX_MCP_TIMEOUT_MS = 600_000;
const MAX_MCP_HEADER_VALUE_LENGTH = 4_096;
const MAX_MCP_SERVERS = 20;

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/u;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/u;

export function newMcpServerId(): string {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/gu, '').slice(0, 8);
  return `mcp-${random ?? Math.random().toString(16).slice(2, 10)}`;
}

export function isMcpToolName(value: string): boolean {
  return value.startsWith(MCP_TOOL_NAME_PREFIX);
}

/** 服务器段只取 ID 去掉 `mcp-` 前缀的 8 位，保证工具名短且稳定。 */
export function mcpServerSegment(serverId: string): string {
  return serverId.replace(/^mcp-/u, '').replace(/[^a-zA-Z0-9_-]/gu, '').slice(0, 12) || 'server';
}

/**
 * 把服务器工具名映射成模型可见的工具名：`mcp__<服务器段>__<工具名>`。
 * 超长时截断工具名，由管理器在冲突时补序号。
 */
export function mcpToolName(serverId: string, toolName: string): string {
  const prefix = `${MCP_TOOL_NAME_PREFIX}${mcpServerSegment(serverId)}__`;
  const safeName = toolName.replace(/[^a-zA-Z0-9_-]/gu, '_') || 'tool';
  return `${prefix}${safeName}`.slice(0, MCP_TOOL_NAME_MAX_LENGTH);
}

export function normalizeMcpTransport(value: unknown): McpTransport {
  if (value === 'sse') return 'sse';
  if (value === 'stdio') return 'stdio';
  return 'http';
}

/** 酒馆服务端插件的 stdio 桥；路径与插件 id 绑定，写死便于导入。 */
export const STDIO_BRIDGE_PREFIX = '/api/plugins/dream-card-agent/mcp-stdio';
export const STDIO_BRIDGE_SERVERS_URL = `${STDIO_BRIDGE_PREFIX}/servers`;

export function stdioBridgeUrl(serverId: string): string {
  return `${STDIO_BRIDGE_PREFIX}/${encodeURIComponent(serverId)}`;
}

/**
 * 接受 http/https 绝对地址，也接受以单个 `/` 开头的同源相对路径。
 * 相对路径用于 stdio 桥：设置可能在不同主机/端口间共享，存绝对地址会失效。
 */
export function normalizeMcpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  // `//host/path` 是协议相对地址，会被当成外部主机，一律拒绝。
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    if (url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function mcpUrlLabel(url: string): string {
  if (!url.startsWith('/')) return new URL(url).host;
  const segments = url.split('/').filter(Boolean);
  return segments.at(-1) ?? 'MCP 服务器';
}

function normalizeMcpHeader(raw: unknown): McpHeader | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const item = raw as Record<string, unknown>;
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  const value = typeof item.value === 'string' ? item.value : '';
  if (!name || !HEADER_NAME_PATTERN.test(name)) return undefined;
  if (value.length > MAX_MCP_HEADER_VALUE_LENGTH) return undefined;
  return { name, value };
}

function normalizeTimeout(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MCP_TIMEOUT_MS;
  return Math.min(MAX_MCP_TIMEOUT_MS, Math.max(MIN_MCP_TIMEOUT_MS, Math.floor(parsed)));
}

/** 无效配置（缺 URL、缺名称）直接丢弃，避免半成品服务器阻塞整个设置加载。 */
export function normalizeMcpServer(raw: unknown): McpServerConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const item = raw as Record<string, unknown>;
  const url = normalizeMcpUrl(item.url);
  if (!url) return undefined;
  const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 60) : undefined;
  const id =
    typeof item.id === 'string' && /^[a-zA-Z0-9_-]{3,32}$/u.test(item.id)
      ? item.id
      : newMcpServerId();
  const headers = Array.isArray(item.headers)
    ? item.headers.flatMap(header => {
        const normalized = normalizeMcpHeader(header);
        return normalized ? [normalized] : [];
      })
    : [];
  const dedupedHeaders = [...new Map(headers.map(header => [header.name.toLowerCase(), header])).values()];
  return {
    enabled: item.enabled !== false,
    headers: dedupedHeaders,
    id,
    name: name ?? mcpUrlLabel(url),
    timeoutMs: normalizeTimeout(item.timeoutMs),
    transport: normalizeMcpTransport(item.transport),
    url,
  };
}

export function normalizeMcpServers(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const servers: McpServerConfig[] = [];
  for (const entry of raw) {
    const server = normalizeMcpServer(entry);
    if (!server) continue;
    if (seen.has(server.id)) server.id = newMcpServerId();
    if (seen.has(server.id)) continue;
    seen.add(server.id);
    servers.push(server);
    if (servers.length >= MAX_MCP_SERVERS) break;
  }
  return servers;
}

export function mcpServerHeaders(server: McpServerConfig): [string, string][] {
  return server.headers.map(header => [header.name, header.value] as [string, string]);
}

/** 工具 schema 的顶层必须是 object；服务器偶尔会漏写，这里补一个宽松的默认值。 */
export function normalizeMcpInputSchema(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { additionalProperties: true, properties: {}, type: 'object' };
  }
  const schema = { ...(raw as Record<string, unknown>) };
  if (typeof schema.type !== 'string') schema.type = 'object';
  return schema;
}

export function normalizeMcpToolInfo(raw: unknown): McpToolInfo | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const item = raw as Record<string, unknown>;
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (!name || !TOOL_NAME_PATTERN.test(name)) return undefined;
  const description =
    typeof item.description === 'string' && item.description.trim() ? item.description.trim() : '';
  const annotations =
    typeof item.annotations === 'object' && item.annotations !== null
      ? (item.annotations as Record<string, unknown>)
      : undefined;
  const title = typeof annotations?.title === 'string' ? annotations.title.trim() : '';
  return {
    description: description.slice(0, 4_096),
    inputSchema: normalizeMcpInputSchema(item.inputSchema),
    name,
    readOnly: annotations?.readOnlyHint === true,
    title: title ? title.slice(0, 120) : undefined,
  };
}
