import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MCP_TIMEOUT_MS,
  MAX_MCP_TIMEOUT_MS,
  isMcpToolName,
  mcpServerSegment,
  mcpToolName,
  normalizeMcpInputSchema,
  normalizeMcpServer,
  normalizeMcpServers,
  normalizeMcpToolInfo,
  normalizeMcpTransport,
  normalizeMcpUrl,
  stdioBridgeUrl,
} from './config';

describe('MCP 配置归一化', () => {
  it('补全缺省字段并保留合法地址', () => {
    const server = normalizeMcpServer({ url: 'http://127.0.0.1:3000/mcp' });
    expect(server).toBeDefined();
    expect(server!.name).toBe('127.0.0.1:3000');
    expect(server!.enabled).toBe(true);
    expect(server!.transport).toBe('http');
    expect(server!.timeoutMs).toBe(DEFAULT_MCP_TIMEOUT_MS);
    expect(server!.headers).toEqual([]);
  });

  it('拒绝非 HTTP、含用户名密码或非法地址', () => {
    expect(normalizeMcpServer({ url: 'ftp://example.com/mcp' })).toBeUndefined();
    expect(normalizeMcpServer({ url: 'https://user:pass@example.com/mcp' })).toBeUndefined();
    expect(normalizeMcpServer({ url: 'not-a-url' })).toBeUndefined();
    expect(normalizeMcpServer({})).toBeUndefined();
  });

  it('接受 stdio 桥的同源相对路径，但拒绝协议相对地址', () => {
    expect(normalizeMcpUrl(stdioBridgeUrl('searxng'))).toBe('/api/plugins/dream-card-agent/mcp-stdio/searxng');
    expect(normalizeMcpUrl('//evil.example.com/mcp')).toBeUndefined();
    const server = normalizeMcpServer({ transport: 'stdio', url: '/api/plugins/dream-card-agent/mcp-stdio/echo' });
    expect(server).toMatchObject({
      name: 'echo',
      transport: 'stdio',
      url: '/api/plugins/dream-card-agent/mcp-stdio/echo',
    });
  });

  it('识别三种传输方式', () => {
    expect(normalizeMcpTransport('stdio')).toBe('stdio');
    expect(normalizeMcpTransport('sse')).toBe('sse');
    expect(normalizeMcpTransport('http')).toBe('http');
    expect(normalizeMcpTransport(undefined)).toBe('http');
  });

  it('限制超时范围并去重请求标头', () => {
    const server = normalizeMcpServer({
      headers: [
        { name: 'Authorization', value: 'Bearer a' },
        { name: 'authorization', value: 'Bearer b' },
        { name: 'Bad Header', value: 'x' },
      ],
      timeoutMs: 999_999,
      url: 'https://example.com/mcp',
    });
    expect(server!.timeoutMs).toBe(MAX_MCP_TIMEOUT_MS);
    expect(server!.headers).toEqual([{ name: 'authorization', value: 'Bearer b' }]);
  });

  it('丢弃无效项并为重复 id 重新生成', () => {
    const servers = normalizeMcpServers([
      { id: 'mcp-aaaa1111', name: 'A', url: 'https://a.example.com/mcp' },
      { id: 'mcp-aaaa1111', name: 'B', url: 'https://b.example.com/mcp' },
      { name: 'C', url: 'bad' },
    ]);
    expect(servers).toHaveLength(2);
    expect(servers[0].id).toBe('mcp-aaaa1111');
    expect(servers[1].id).not.toBe(servers[0].id);
  });
});

describe('MCP 工具命名', () => {
  it('生成带服务器段的前缀名并保持可识别', () => {
    const name = mcpToolName('mcp-1a2b3c4d', 'read_file');
    expect(name).toBe('mcp__1a2b3c4d__read_file');
    expect(isMcpToolName(name)).toBe(true);
    expect(mcpServerSegment('mcp-1a2b3c4d')).toBe('1a2b3c4d');
  });

  it('替换非法字符并截断到 64 字符', () => {
    const name = mcpToolName('mcp-1a2b3c4d', `bad name/${'x'.repeat(120)}`);
    expect(name).toHaveLength(64);
    expect(name).toMatch(/^[a-zA-Z0-9_-]+$/u);
  });

  it('保留服务器工具名与只读标注', () => {
    const tool = normalizeMcpToolInfo({
      annotations: { readOnlyHint: true, title: '读取文件' },
      description: '读取一个文件',
      inputSchema: { properties: { path: { type: 'string' } }, type: 'object' },
      name: 'read_file',
    });
    expect(tool).toMatchObject({ name: 'read_file', readOnly: true, title: '读取文件' });
    expect(normalizeMcpToolInfo({ name: 'bad name' })).toBeUndefined();
    expect(normalizeMcpToolInfo({ name: 'ok' })!.readOnly).toBe(false);
  });

  it('为缺失 schema 补上 object 顶层', () => {
    expect(normalizeMcpInputSchema(undefined)).toMatchObject({ type: 'object' });
    expect(normalizeMcpInputSchema({ properties: {} })).toMatchObject({ type: 'object' });
  });
});
