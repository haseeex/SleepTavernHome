import { describe, expect, it, vi } from 'vitest';
import { McpToolManager } from './manager';
import type { McpServerConfig } from './types';

function server(id: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    enabled: true,
    headers: [],
    id,
    name: `服务器 ${id}`,
    timeoutMs: 5_000,
    transport: 'http',
    url: `https://${id}.example.com/mcp`,
    ...overrides,
  };
}

function fetchWithTools(tools: Array<{ name: string }>): typeof fetch {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
    if (body.method === 'initialize') {
      return new Response(JSON.stringify({ id: body.id, result: { protocolVersion: '2025-06-18' } }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return new Response(
      JSON.stringify({ id: body.id, result: { tools: tools.map(tool => ({ ...tool, inputSchema: { type: 'object' } })) } }),
      { headers: { 'content-type': 'application/json' }, status: 200 },
    );
  }) as unknown as typeof fetch;
}

describe('MCP 工具管理器', () => {
  it('连接后缓存工具并生成 RunnerTool', async () => {
    const manager = new McpToolManager({ fetch: fetchWithTools([{ name: 'search' }]) });
    manager.configure([server('mcp-aaaaaaaa')]);

    const statuses = await manager.refresh();

    expect(statuses[0]).toMatchObject({ state: 'ready', toolCount: 1 });
    const tools = manager.tools({ approvalMode: () => 'manual' });
    expect(tools.map(tool => tool.name)).toEqual(['mcp__aaaaaaaa__search']);
    manager.dispose();
  });

  it('停用的服务器不连接也不暴露工具', async () => {
    const manager = new McpToolManager({ fetch: fetchWithTools([{ name: 'search' }]) });
    manager.configure([server('mcp-bbbbbbbb', { enabled: false })]);

    await manager.refresh();

    expect(manager.statuses()[0]).toMatchObject({ state: 'idle', toolCount: 0 });
    expect(manager.tools({ approvalMode: () => 'manual' })).toEqual([]);
    manager.dispose();
  });

  it('连接失败记录错误状态而不是抛出', async () => {
    const failing = vi.fn(async () => new Response('boom', { status: 500, statusText: 'Server Error' }));
    const manager = new McpToolManager({ fetch: failing as unknown as typeof fetch });
    manager.configure([server('mcp-cccccccc')]);

    const [status] = await manager.refresh();

    expect(status.state).toBe('error');
    expect(status.error).toMatch(/HTTP 500/u);
    expect(manager.tools({ approvalMode: () => 'manual' })).toEqual([]);
    manager.dispose();
  });

  it('配置变化时重置缓存，重复 configure 不重复通知', async () => {
    const onChanged = vi.fn();
    const manager = new McpToolManager({ fetch: fetchWithTools([{ name: 'search' }]), onChanged });
    manager.configure([server('mcp-dddddddd')]);
    await manager.refresh();
    expect(manager.statuses()[0].toolCount).toBe(1);

    const before = onChanged.mock.calls.length;
    manager.configure([server('mcp-dddddddd')]);
    expect(onChanged.mock.calls.length).toBe(before);

    manager.configure([server('mcp-dddddddd', { url: 'https://changed.example.com/mcp' })]);
    expect(manager.statuses()[0]).toMatchObject({ state: 'idle', toolCount: 0 });
    manager.dispose();
  });

  it('移除配置后同步丢弃服务器状态', async () => {
    const manager = new McpToolManager({ fetch: fetchWithTools([{ name: 'search' }]) });
    manager.configure([server('mcp-eeeeeeee')]);
    await manager.refresh();
    expect(manager.statuses()).toHaveLength(1);

    manager.configure([]);

    expect(manager.statuses()).toEqual([]);
    manager.dispose();
  });

  it('被限流后不再重试，并在状态里显示倒计时', async () => {
    // 酒馆 basicAuth 限流：锁定期间重试只会继续消耗配额，必须彻底停手。
    let now = 1_000_000;
    const rateLimited = vi.fn(
      async () =>
        new Response('Too Many Requests', { headers: { 'retry-after': '30' }, status: 429 }),
    );
    const manager = new McpToolManager({
      fetch: rateLimited as unknown as typeof fetch,
      now: () => now,
    });
    manager.configure([server('mcp-ffffffff')]);

    const [first] = await manager.refresh();
    expect(first.state).toBe('error');
    expect(rateLimited).toHaveBeenCalledTimes(1);

    // 限流窗口内：再点刷新也不发请求
    await manager.refresh();
    await manager.refreshServer('mcp-ffffffff');
    expect(rateLimited).toHaveBeenCalledTimes(1);
    expect(manager.statuses()[0].error).toMatch(/限流中.*30 秒/u);

    // 窗口过后恢复正常重试
    now += 31_000;
    await manager.refresh();
    expect(rateLimited).toHaveBeenCalledTimes(2);
    manager.dispose();
  });
});
