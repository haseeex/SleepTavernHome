import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    McpClient,
    McpRateLimitError,
    McpTimeoutError,
    isSameOriginRequest,
    requestCredentials,
    tavernRequestHeaders,
} from './client';
import type { McpServerConfig } from './types';

function server(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    enabled: true,
    headers: [],
    id: 'mcp-1a2b3c4d',
    name: '测试服务器',
    timeoutMs: 5_000,
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: 200,
    ...init,
  });
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' }, status: 200 });
}

describe('MCP HTTP 客户端', () => {
  it('initialize 记录会话 id 并发送 initialized 通知', async () => {
    const calls: Array<{ body: string; headers: Headers; method: string }> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        body: String(init?.body ?? ''),
        headers: new Headers(init?.headers),
        method: String(init?.method),
      });
      if (calls.length === 1) {
        return jsonResponse(
          { id: 1, jsonrpc: '2.0', result: { capabilities: {}, protocolVersion: '2025-06-18' } },
          { headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' } },
        );
      }
      return new Response(null, { status: 202 });
    });
    const client = new McpClient(server(), { fetch: fetchMock as unknown as typeof fetch });

    await client.initialize();

    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].body)).toMatchObject({ method: 'initialize', params: { capabilities: {} } });
    expect(JSON.parse(calls[1].body)).toMatchObject({ method: 'notifications/initialized' });
    expect(calls[1].headers.get('mcp-session-id')).toBe('session-1');
    expect(calls[0].headers.get('accept')).toContain('text/event-stream');
  });

  it('分页读取工具列表并过滤非法项', async () => {
    let page = 0;
    const fetchMock = vi.fn(async () => {
      page += 1;
      if (page === 1) {
        return jsonResponse({
          id: 1,
          result: {
            nextCursor: 'page-2',
            tools: [
              { description: '读取文件', inputSchema: { type: 'object' }, name: 'read_file' },
              { name: 'bad name' },
            ],
          },
        });
      }
      return jsonResponse({
        id: 2,
        result: { tools: [{ annotations: { readOnlyHint: true }, name: 'list_files' }] },
      });
    });
    const client = new McpClient(server(), { fetch: fetchMock as unknown as typeof fetch });

    const tools = await client.listTools();

    expect(tools.map(tool => tool.name)).toEqual(['read_file', 'list_files']);
    expect(tools[1].readOnly).toBe(true);
    expect(page).toBe(2);
  });

  it('把 tools/call 的内容块转换成统一结构', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        method: 'tools/call',
        params: { arguments: { path: '/a.txt' }, name: 'read_file' },
      });
      return jsonResponse({
        id: 1,
        result: {
          content: [
            { text: '第一行', type: 'text' },
            { data: 'AAAA', mimeType: 'image/png', type: 'image' },
            { resource: { uri: 'file:///a.txt' }, type: 'resource' },
          ],
          isError: false,
          structuredContent: { ok: true },
        },
      });
    });
    const client = new McpClient(server(), { fetch: fetchMock as unknown as typeof fetch });

    const result = await client.callTool('read_file', { path: '/a.txt' });

    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(3);
    expect(result.content[0]).toEqual({ data: undefined, mimeType: undefined, resource: undefined, text: '第一行', type: 'text' });
    expect(result.structuredContent).toEqual({ ok: true });
  });

  it('从 text/event-stream 响应中取出匹配 id 的消息', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n',
        'event: message\ndata: {"id":1,"jsonrpc":"2.0","result":{"tools":[]}}\n\n',
      ]),
    );
    const client = new McpClient(server(), { fetch: fetchMock as unknown as typeof fetch });

    await expect(client.listTools()).resolves.toEqual([]);
  });

  it('把 HTTP 错误与 JSON-RPC 错误转成可读异常', async () => {
    const unauthorized = vi.fn(async () => new Response('denied', { status: 401, statusText: 'Unauthorized' }));
    await expect(
      new McpClient(server(), { fetch: unauthorized as unknown as typeof fetch }).initialize(),
    ).rejects.toThrow(/HTTP 401 Unauthorized：请检查请求头中的鉴权信息（denied）/u);

    const rpcError = vi.fn(async () =>
      jsonResponse({ error: { code: -32601, message: 'method not found' }, id: 1 }),
    );
    await expect(
      new McpClient(server(), { fetch: rpcError as unknown as typeof fetch }).initialize(),
    ).rejects.toThrow(/method not found/u);
  });
});

describe('MCP SSE 传输', () => {
  it('从 endpoint 事件取得投递地址，并在事件流里等待响应', async () => {
    const encoder = new TextEncoder();
    let push!: (payload: unknown) => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = payload =>
          controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(payload)}\n\n`));
        controller.enqueue(encoder.encode('event: endpoint\ndata: /messages?sessionId=s1\n\n'));
      },
    });
    const posted: Array<{ body: string; url: string }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'GET') return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
      posted.push({ body: String(init?.body ?? ''), url: String(url) });
      if (body.method === 'initialize') push({ id: body.id, result: { protocolVersion: '2024-11-05' } });
      if (body.method === 'tools/list') push({ id: body.id, result: { tools: [{ name: 'ping' }] } });
      return new Response(null, { status: 202 });
    });
    const client = new McpClient(server({ transport: 'sse', url: 'https://mcp.example.com/sse' }), {
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.initialize();
    const tools = await client.listTools();
    client.close();

    expect(tools.map(tool => tool.name)).toEqual(['ping']);
    expect(posted.map(item => item.url)).toEqual([
      'https://mcp.example.com/messages?sessionId=s1',
      'https://mcp.example.com/messages?sessionId=s1',
      'https://mcp.example.com/messages?sessionId=s1',
    ]);
  });

  it('关闭后拒绝继续请求', async () => {
    const client = new McpClient(server(), { fetch: vi.fn() as unknown as typeof fetch });
    client.close();
    await expect(client.listTools()).rejects.toThrow('MCP 客户端已关闭。');
  });
});

describe('默认 fetch 的接收者', () => {
  // 浏览器的 fetch 是 window 的方法：存成变量或写在括号里调用会丢接收者，
  // 报 TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation。
  it('未注入 fetch 时以 globalThis 为接收者调用', async () => {
    const original = globalThis.fetch;
    const receivers: unknown[] = [];
    globalThis.fetch = function (this: unknown, _input: RequestInfo | URL, init?: RequestInit) {
      receivers.push(this);
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number };
      return Promise.resolve(
        new Response(JSON.stringify({ id: body.id, jsonrpc: '2.0', result: { tools: [] } }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      );
    } as typeof fetch;
    try {
      await new McpClient(server()).listTools();
      expect(receivers).toHaveLength(1);
      expect(receivers[0]).toBe(globalThis);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('注入的 fetch 保持原样传递', async () => {
    const custom = vi.fn(async () => jsonResponse({ id: 1, result: { tools: [] } }));
    const client = new McpClient(server(), { fetch: custom as unknown as typeof fetch });
    await client.listTools();
    expect(custom).toHaveBeenCalledTimes(1);
  });
});

describe('同源请求要带上酒馆 Basic Auth', () => {
  // 酒馆常开 basicAuthMode：'omit' 会禁止浏览器发送缓存的 Basic Auth，
  // 请求在插件路由前就被 401 拦下（返回整页 unauthorized.html）。
  it('相对路径视为同源并使用 include', () => {
    expect(isSameOriginRequest('/api/plugins/dream-card-agent/mcp-stdio/searxng')).toBe(true);
    expect(requestCredentials('/api/plugins/dream-card-agent/mcp-stdio/searxng')).toBe('include');
    expect(requestCredentials('//evil.example.com/mcp')).toBe('omit');
  });

  it('跨域绝对地址使用 omit，避免把酒馆凭据发给外部服务', () => {
    expect(isSameOriginRequest('https://mcp.example.com/mcp')).toBe(false);
    expect(requestCredentials('https://mcp.example.com/mcp')).toBe('omit');
  });

  it('与 location 同源时使用 include', () => {
    const original = globalThis.location;
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'https://mcp.example.com' },
    });
    try {
      expect(isSameOriginRequest('https://mcp.example.com/mcp')).toBe(true);
      expect(requestCredentials('https://mcp.example.com/mcp')).toBe('include');
      expect(requestCredentials('https://other.example.com/mcp')).toBe('omit');
    } finally {
      Object.defineProperty(globalThis, 'location', { configurable: true, value: original });
    }
  });

  it('手动配了 Authorization 时仍然使用 include', () => {
    // 酒馆的 CSRF token 存在 session cookie 里，omit 会让所有 POST 403；
    // 而请求已显式带 Authorization 时浏览器不会用凭据缓存覆盖它，所以 include 是安全的。
    expect(requestCredentials('/api/plugins/x/mcp-stdio/a')).toBe('include');
  });

  it('stdio 桥始终发送 credentials: include 并保留 Authorization', async () => {
    const seen: Array<{ credentials?: RequestCredentials; authorization?: string }> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number };
      seen.push({
        authorization: new Headers(init?.headers).get('authorization') ?? undefined,
        credentials: init?.credentials as RequestCredentials,
      });
      return jsonResponse({ id: body.id, result: { tools: [] } });
    });
    const client = new McpClient(
      server({
        headers: [{ name: 'Authorization', value: 'Basic dXNlcjpwYXNz' }],
        transport: 'stdio',
        url: '/api/plugins/dream-card-agent/mcp-stdio/searxng',
      }),
      { fetch: fetchMock as unknown as typeof fetch },
    );
    await client.listTools();
    expect(seen.every(item => item.credentials === 'include')).toBe(true);
    expect(seen.at(-1)?.authorization).toBe('Basic dXNlcjpwYXNz');
  });

  it('未配手动凭据时 stdio 桥使用 credentials: include', async () => {
    const seen: RequestCredentials[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.credentials as RequestCredentials);
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number };
      return jsonResponse({ id: body.id, result: { tools: [] } });
    });
    const client = new McpClient(
      server({ transport: 'stdio', url: '/api/plugins/dream-card-agent/mcp-stdio/searxng' }),
      { fetch: fetchMock as unknown as typeof fetch },
    );
    await client.listTools();
    expect(seen).toEqual(['include']);
  });

  it('把酒馆的整页 401 HTML 转成可读提示', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('<!DOCTYPE html><html><head><title>Unauthorized</title></head></html>', {
          headers: { 'content-type': 'text/html' },
          status: 401,
          statusText: 'Unauthorized',
        }),
    );
    const client = new McpClient(server({ transport: 'stdio', url: '/api/plugins/x/mcp-stdio/a' }), {
      fetch: fetchMock as unknown as typeof fetch,
    });
    const failure = client.initialize();
    await expect(failure).rejects.toThrow(/basicAuthMode/u);
    await expect(failure).rejects.not.toThrow(/DOCTYPE/u);
  });

  it('429 限流转成带等待时间的 McpRateLimitError', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('Too Many Requests', {
          headers: { 'retry-after': '42' },
          status: 429,
          statusText: 'Too Many Requests',
        }),
    );
    const client = new McpClient(server({ transport: 'stdio', url: '/api/plugins/x/mcp-stdio/a' }), {
      fetch: fetchMock as unknown as typeof fetch,
    });
    const failure = client.initialize();
    await expect(failure).rejects.toBeInstanceOf(McpRateLimitError);
    await expect(failure).rejects.toThrow(/等待 42 秒/u);
  });

  it('超时转成可读的 McpTimeoutError，而不是裸 AbortError', async () => {
    // 裸 AbortError 的 message 是「This operation was aborted」，用户看不出发生了什么。
    // initialize 有 180 秒启动宽限，所以这里用 tools/list 验证普通请求超时。
    const hanging = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const client = new McpClient(server({ transport: 'stdio', timeoutMs: 5_000, url: '/api/plugins/x/mcp-stdio/a' }), {
      fetch: hanging as unknown as typeof fetch,
    });

    // 用假的 setTimeout 避免真的等 5 秒
    vi.useFakeTimers();
    try {
      const failure = client.listTools();
      const assertion = expect(failure).rejects.toBeInstanceOf(McpTimeoutError);
      await vi.advanceTimersByTimeAsync(5_001);
      await assertion;
      await expect(failure).rejects.toThrow(/MCP 请求超时（5 秒内没有响应）/u);
      await expect(failure).rejects.not.toThrow(/This operation was aborted/u);
    } finally {
      vi.useRealTimers();
    }
  });

  it('上层取消仍然是 AbortError，不伪装成超时', async () => {
    const controller = new AbortController();
    const hanging = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const client = new McpClient(server({ transport: 'stdio', timeoutMs: 60_000, url: '/api/plugins/x/mcp-stdio/a' }), {
      fetch: hanging as unknown as typeof fetch,
      signal: controller.signal,
    });

    const failure = client.initialize();
    controller.abort();
    await expect(failure).rejects.toThrow(/取消/u);
    await expect(failure).rejects.not.toBeInstanceOf(McpTimeoutError);
  });
});

describe('酒馆官方请求头（CSRF）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('同源请求带上 getRequestHeaders() 的 X-CSRF-TOKEN', async () => {
    // 直接用酒馆自己的实现，而不是我们手写 GET /csrf-token + 缓存 + 403 重试。
    vi.stubGlobal('SillyTavern', {
      getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-TOKEN': 'tok-official' }),
    });
    const seen: Array<string | null> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('x-csrf-token'));
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number };
      return jsonResponse({ id: body.id, result: { tools: [] } });
    });
    const client = new McpClient(server({ transport: 'stdio', url: '/api/plugins/x/mcp-stdio/a' }), {
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.listTools();

    expect(seen).toEqual(['tok-official']);
    // 不再自己请求 /csrf-token
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes('csrf-token'))).toBe(false);
  });

  it('跨域服务器绝不带酒馆的 CSRF token', async () => {
    vi.stubGlobal('SillyTavern', {
      getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-TOKEN': 'tok-secret' }),
    });
    const seen: Array<string | null> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('x-csrf-token'));
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number };
      return jsonResponse({ id: body.id, result: { tools: [] } });
    });
    const client = new McpClient(server({ url: 'https://mcp.example.com/mcp' }), {
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.listTools();

    expect(seen).toEqual([null]);
  });

  it('没有 SillyTavern 全局时降级为不带 CSRF', () => {
    vi.stubGlobal('SillyTavern', undefined);
    expect(tavernRequestHeaders('/api/plugins/x/mcp-stdio/a')).toEqual({});
    expect(tavernRequestHeaders('https://mcp.example.com/mcp')).toEqual({});
  });

  it('用户配置的标头覆盖官方默认值', async () => {
    vi.stubGlobal('SillyTavern', {
      getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-TOKEN': 'tok-official' }),
    });
    let authorization: string | null = null;
    let csrf: string | null = null;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      authorization = headers.get('authorization');
      csrf = headers.get('x-csrf-token');
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number };
      return jsonResponse({ id: body.id, result: { tools: [] } });
    });
    const client = new McpClient(
      server({
        headers: [{ name: 'Authorization', value: 'Basic dXNlcjpwYXNz' }],
        transport: 'stdio',
        url: '/api/plugins/x/mcp-stdio/a',
      }),
      { fetch: fetchMock as unknown as typeof fetch },
    );

    await client.listTools();

    expect(authorization).toBe('Basic dXNlcjpwYXNz');
    // 用户没配 CSRF 时官方值仍然保留
    expect(csrf).toBe('tok-official');
  });

  it('CSRF 403 的报错文案能区分于 basicAuth', async () => {
    const fetchMock = vi.fn(
      async () => new Response('Invalid CSRF token. Please refresh the page and try again.', { status: 403 }),
    );
    const client = new McpClient(server({ transport: 'stdio', url: '/api/plugins/x/mcp-stdio/a' }), {
      fetch: fetchMock as unknown as typeof fetch,
    });
    const failure = client.initialize();
    await expect(failure).rejects.toThrow(/CSRF/u);
    await expect(failure).rejects.not.toThrow(/basicAuthMode/u);
  });
});
