import { mcpServerHeaders, normalizeMcpInputSchema, normalizeMcpToolInfo } from './config';
import {
    createSseDecoder,
    isResponseFor,
    jsonRpcResult,
    parseJsonRpcMessages,
    serializeJsonRpcNotification,
    serializeJsonRpcRequest,
    type JsonRpcMessage,
} from './json-rpc';
import type { McpCallToolResult, McpContentBlock, McpServerConfig, McpToolInfo } from './types';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
/**
 * 首次握手要等子进程启动：`npx -y <pkg>` 会下载包，实测可能 60 秒以上。
 * 因此 initialize 单独用更长的超时，不跟着用户的请求超时走。
 */
export const MCP_STARTUP_TIMEOUT_MS = 180_000;
const CLIENT_INFO = { name: 'dream-creator', version: '1.0.0' } as const;
const ACCEPT_JSON = 'application/json';
const ACCEPT_BOTH = 'application/json, text/event-stream';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type McpClientOptions = {
  fetch?: typeof fetch;
  signal?: AbortSignal;
};

/**
 * 浏览器的 `fetch` 是 `window` 的方法：存成变量再调用（`const f = fetch; f(...)`）
 * 会丢掉接收者，报 `TypeError: Illegal invocation`。这里统一绑定到 globalThis。
 */
export function resolveFetch(custom?: typeof fetch): typeof fetch {
  if (custom) return custom;
  return (input, init) => globalThis.fetch(input, init);
}

/** 相对路径必然同源（stdio 桥就靠这个），绝对地址比对 location.origin。 */
export function isSameOriginRequest(url: string): boolean {
  // `//host/path` 是协议相对地址，指向外部主机，绝不能当成同源。
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  try {
    const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
    return Boolean(origin) && new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * 决定 fetch 的 `credentials`。
 *
 * ⚠️ 同源请求**必须** `include`：酒馆的 CSRF 保护（csrf-sync）把 token 存在 session 里，
 * 而 session 在 cookie 里。`omit` 连 cookie 一起禁掉 → token 存不进 session → 所有 POST 403。
 *
 * 手动配了 Authorization 也照样 `include`：请求已经显式带 Authorization 时，
 * 浏览器不会用 HTTP 认证缓存去覆盖它；而 cookie 必须发出去，否则 CSRF 无法通过。
 *
 * 跨域第三方服务器用 `omit`，绝不把酒馆凭据发给外部服务。
 */
export function requestCredentials(url: string): RequestCredentials {
  return isSameOriginRequest(url) ? 'include' : 'omit';
}

type TavernRequestHeaders = { getRequestHeaders?: () => Record<string, string> };

/**
 * 酒馆官方的请求头，已包含 `X-CSRF-TOKEN`。
 *
 * 直接用酒馆自己的实现，而不是自己 `GET /csrf-token` 再缓存：
 * token 与 session 绑定，酒馆那边 session 重建后它会拿到新 token，我们缓存的那份就过期了。
 *
 * ⚠️ 只在同源时返回：把酒馆的 CSRF token 发给第三方服务器等于泄露凭据。
 */
export function tavernRequestHeaders(url: string): Record<string, string> {
  if (!isSameOriginRequest(url)) return {};
  try {
    const tavern = (globalThis as { SillyTavern?: TavernRequestHeaders }).SillyTavern;
    return tavern?.getRequestHeaders?.() ?? {};
  } catch {
    // 酒馆助手 iframe 外的环境（测试、独立窗口）没有这个全局。
    return {};
  }
}

/** 识别 csrf-sync 的失败响应（403 + 固定文案）。 */
function looksLikeCsrfFailure(status: number, detail: string): boolean {
  return status === 403 && /csrf/iu.test(detail);
}

/** 酒馆的 401/403 返回的是整页 HTML，直接塞进错误里没法看。 */
function describeHttpFailure(status: number, statusText: string, detail: string, retryAfter?: number): string {
  const head = `HTTP ${status}${statusText ? ` ${statusText}` : ''}`;
  const looksLikeHtml = /^\s*<(!doctype|html)/iu.test(detail);
  if (status === 429) {
    // 酒馆 basicAuth 限流：同一 IP 认证失败 5 次后锁 60 秒，锁定期内连正确密码也拒绝。
    const wait = retryAfter && retryAfter > 0 ? `请等待 ${retryAfter} 秒` : '请等待约 60 秒';
    return `${head}：酒馆登录失败次数过多，已被临时限流（${wait}后再试）。请确认「请求标头」里的 Authorization 与酒馆密码一致；锁定期间反复重试只会继续延长封锁。`;
  }
  if (looksLikeCsrfFailure(status, detail)) {
    return `${head}：酒馆的 CSRF 校验未通过（Invalid CSRF token）。这通常意味着 cookie 被阻止或 session 已过期——请刷新酒馆页面后重试。`;
  }
  if ([401, 403].includes(status)) {
    return looksLikeHtml
      ? `${head}：请求被酒馆的访问密码（basicAuthMode）拦下了。若「请求标头」里的 Authorization 已正确仍失败，` +
          `说明浏览器缓存了旧的登录凭据在覆盖它——请关闭该标签页重新打开酒馆（或清除本站凭据）后再试。`
      : `${head}：请检查请求头中的鉴权信息${detail ? `（${detail.slice(0, 200)}）` : ''}`;
  }
  if (looksLikeHtml) return `${head}：服务器返回了 HTML 页面，可能地址指向了网页而不是 MCP 端点。`;
  return `${head}${detail ? `：${detail.slice(0, 400)}` : ''}`;
}

/** 解析 `Retry-After`（秒数或 HTTP 日期），用于把限流等待时间告诉用户。 */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return undefined;
}

/** 供管理器识别「被限流」，避免锁定期内继续消耗配额。 */
export class McpRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'McpRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** 带 HTTP 状态码的失败，供 CSRF 重试判断用。 */
export class McpHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'McpHttpError';
    this.status = status;
  }
}

/**
 * 请求超时。单独成类是因为裸 AbortError 的 message 是
 * 「This operation was aborted」，用户完全看不出发生了什么。
 */
export class McpTimeoutError extends Error {
  readonly seconds: number;
  constructor(seconds: number) {
    super(
      `MCP 请求超时（${seconds} 秒内没有响应）。` +
        '常见原因：服务器较慢（如联网搜索）、本地实例不可达，或 stdio 子进程仍在启动。' +
        '可在「设置 → MCP → 请求超时」调大后重试。',
    );
    this.name = 'McpTimeoutError';
    this.seconds = seconds;
  }
}

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

function abortError(): Error {
  const error = new Error('MCP 请求已取消。');
  error.name = 'AbortError';
  return error;
}

function linkSignals(signals: Array<AbortSignal | undefined>): {
  controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort();
      break;
    }
    const listener = () => controller.abort();
    signal.addEventListener('abort', listener, { once: true });
    listeners.push(() => signal.removeEventListener('abort', listener));
  }
  return {
    controller,
    dispose: () => listeners.forEach(remove => remove()),
  };
}

function toContentBlocks(raw: unknown): McpContentBlock[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    if (typeof item !== 'object' || item === null) return [];
    const block = item as Record<string, unknown>;
    const type = typeof block.type === 'string' ? block.type : 'text';
    const resource =
      typeof block.resource === 'object' && block.resource !== null
        ? (block.resource as { text?: unknown; uri?: unknown })
        : undefined;
    return [
      {
        data: typeof block.data === 'string' ? block.data : undefined,
        mimeType: typeof block.mimeType === 'string' ? block.mimeType : undefined,
        resource: resource
          ? {
              text: typeof resource.text === 'string' ? resource.text : undefined,
              uri: typeof resource.uri === 'string' ? resource.uri : undefined,
            }
          : undefined,
        text: typeof block.text === 'string' ? block.text : undefined,
        type,
      },
    ];
  });
}

async function readTextCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('MCP 响应超过 8MB。');
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('MCP 响应超过 8MB。');
  return text;
}

/**
 * 单个 MCP 服务器的 JSON-RPC 客户端。
 * - `http`：每次请求 POST，响应可以是 JSON 或 SSE 流（Streamable HTTP）。
 * - `sse`：先建立 GET 事件流拿到 endpoint，再 POST 请求、从流里取响应。
 * - `stdio`：地址是酒馆服务端插件的桥接端点，协议形态与 `http` 完全一致。
 */
export class McpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly server: McpServerConfig;
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private protocolVersion = '';
  private sessionId?: string;
  private sseController?: AbortController;
  private sseConnecting?: Promise<void>;
  private sseEndpoint?: string;
  private ssePump?: Promise<void>;
  private sseReader?: ReadableStreamDefaultReader<Uint8Array>;
  private readonly upstreamSignal?: AbortSignal;

  constructor(server: McpServerConfig, options: McpClientOptions = {}) {
    this.server = server;
    this.fetchImpl = resolveFetch(options.fetch);
    this.upstreamSignal = options.signal;
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      capabilities: {},
      clientInfo: CLIENT_INFO,
      protocolVersion: MCP_PROTOCOL_VERSION,
    });
    await this.notify('notifications/initialized');
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      const value = (result ?? {}) as { nextCursor?: unknown; tools?: unknown };
      if (Array.isArray(value.tools)) {
        for (const raw of value.tools) {
          const tool = normalizeMcpToolInfo(raw);
          if (tool) tools.push(tool);
        }
      }
      const next = typeof value.nextCursor === 'string' ? value.nextCursor : '';
      if (!next || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    return tools;
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallToolResult> {
    const result = await this.request('tools/call', { arguments: args ?? {}, name }, signal);
    const value = (result ?? {}) as { content?: unknown; isError?: unknown; structuredContent?: unknown };
    return {
      content: toContentBlocks(value.content),
      isError: value.isError === true,
      structuredContent: value.structuredContent,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sseController?.abort();
    this.sseReader?.cancel().catch(() => undefined);
    this.rejectAll(abortError());
  }

  private rejectAll(error: Error): void {
    for (const [key, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(key);
      pending.reject(error);
    }
  }

  private async notify(method: string): Promise<void> {
    if (this.server.transport === 'sse') {
      await this.ensureSseStream();
      await this.postSseMessage(serializeJsonRpcNotification(method));
      return;
    }
    const response = await this.post(
      this.server.url,
      serializeJsonRpcNotification(method),
      ACCEPT_BOTH,
      true,
    );
    // 通知只接受 202/204；服务器若返回正文，直接丢弃。
    await response.body?.cancel().catch(() => undefined);
  }

  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error('MCP 客户端已关闭。');
    const timeoutMs = method === 'initialize' ? Math.max(this.server.timeoutMs, MCP_STARTUP_TIMEOUT_MS) : this.server.timeoutMs;
    const id = this.nextId++;
    const body = serializeJsonRpcRequest(id, method, params);
    const linked = linkSignals([this.upstreamSignal, signal]);
    try {
      if (this.server.transport === 'sse') {
        await this.ensureSseStream();
        const waiting = this.expectResponse(id, linked.controller.signal, timeoutMs);
        await this.postSseMessage(body);
        return await waiting;
      }
      const response = await this.post(
        this.server.url,
        body,
        ACCEPT_BOTH,
        false,
        linked.controller.signal,
        timeoutMs,
      );
      const sessionId = response.headers.get('mcp-session-id');
      if (sessionId) this.sessionId = sessionId;
      if (response.status === 202 || response.status === 204 || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        if (method === 'initialize') {
          const protocol = response.headers.get('mcp-protocol-version');
          if (protocol) this.protocolVersion = protocol;
          return {};
        }
        throw new Error(`MCP 服务器未返回 ${method} 的响应。`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) {
        const message = await this.readSseResponse(response, id, linked.controller.signal, timeoutMs);
        if (method === 'initialize') this.captureProtocolVersion(message);
        return jsonRpcResult(message);
      }
      const text = await readTextCapped(response);
      const message = parseJsonRpcMessages(text).find(item => isResponseFor(item, id));
      if (!message) throw new Error(`MCP 服务器返回了无法识别的 ${method} 响应。`);
      if (method === 'initialize') this.captureProtocolVersion(message);
      return jsonRpcResult(message);
    } finally {
      linked.dispose();
    }
  }

  private captureProtocolVersion(message: JsonRpcMessage): void {
    const result = (message.result ?? {}) as { protocolVersion?: unknown };
    if (typeof result.protocolVersion === 'string' && result.protocolVersion) {
      this.protocolVersion = result.protocolVersion;
    }
  }

  /**
   * 组装请求头。优先级从低到高：
   * 酒馆官方头（含 X-CSRF-TOKEN）→ 用户配置的服务器标头 → 协议头。
   * 用户配的 Authorization 等能覆盖官方默认值，但 accept / session 等协议字段不被覆盖。
   */
  private headers(accept: string): Headers {
    const headers = new Headers(tavernRequestHeaders(this.server.url));
    for (const [name, value] of mcpServerHeaders(this.server)) headers.set(name, value);
    headers.set('accept', accept);
    if (this.sessionId) headers.set('mcp-session-id', this.sessionId);
    if (this.protocolVersion) headers.set('mcp-protocol-version', this.protocolVersion);
    return headers;
  }

  private async post(
    url: string,
    body: string,
    accept: string,
    notification: boolean,
    signal?: AbortSignal,
    timeoutMs = this.server.timeoutMs,
  ): Promise<Response> {
    const headers = this.headers(accept);
    headers.set('content-type', 'application/json');
    const linked = linkSignals([this.upstreamSignal, signal]);
    // abort 有两种来源：我们超时 / 上层取消。不区分的话用户只会看到
    // 「This operation was aborted」，完全看不出是超时。
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      linked.controller.abort();
    }, timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        body,
        credentials: requestCredentials(url),
        headers,
        method: 'POST',
        mode: 'cors',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: linked.controller.signal,
      });
      if (!response.ok) {
        const detail = notification ? '' : await readTextCapped(response).catch(() => '');
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        const message = describeHttpFailure(response.status, response.statusText, detail, retryAfter);
        if (response.status === 429) {
          throw new McpRateLimitError(message, retryAfter ? retryAfter * 1000 : 60_000);
        }
        throw new McpHttpError(message, response.status);
      }
      return response;
    } catch (error) {
      if (timedOut) throw new McpTimeoutError(Math.round(timeoutMs / 1000));
      // 只要是我们主动 abort，就统一成友好文案；浏览器原始 message 是「aborted」。
      if (linked.controller.signal.aborted) throw abortError();
      throw error;
    } finally {
      clearTimeout(timer);
      linked.dispose();
    }
  }

  /**
   * 从 SSE 流里等匹配 id 的响应。
   * ⚠️ 必须自带超时：外层 signal 只在用户停止时 abort，
   * 服务器若一直推无关事件，这里会永久挂起。
   */
  private async readSseResponse(
    response: Response,
    id: number,
    signal: AbortSignal,
    timeoutMs = this.server.timeoutMs,
  ): Promise<JsonRpcMessage> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const sse = createSseDecoder();
    let bytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reader.cancel().catch(() => undefined);
    }, timeoutMs);
    try {
      while (true) {
        if (signal.aborted) throw abortError();
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error('MCP 响应超过 8MB。');
        for (const event of sse.push(decoder.decode(value, { stream: true }))) {
          if (event.event !== 'message') continue;
          const message = parseJsonRpcMessages(event.data).find(item => isResponseFor(item, id));
          if (message) return message;
        }
      }
      for (const event of sse.flush()) {
        if (event.event !== 'message') continue;
        const message = parseJsonRpcMessages(event.data).find(item => isResponseFor(item, id));
        if (message) return message;
      }
    } catch (error) {
      if (timedOut) throw new McpTimeoutError(Math.round(timeoutMs / 1000));
      throw error;
    } finally {
      clearTimeout(timer);
      await reader.cancel().catch(() => undefined);
    }
    if (timedOut) throw new McpTimeoutError(Math.round(timeoutMs / 1000));
    throw new Error('MCP 服务器的事件流在返回响应前结束。');
  }

  private expectResponse(id: number, signal: AbortSignal, timeoutMs = this.server.timeoutMs): Promise<unknown> {
    const key = String(id);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        signal.removeEventListener('abort', onAbort);
        reject(new Error(`MCP 请求超时（${Math.round(timeoutMs / 1000)} 秒）。`));
      }, timeoutMs);
      const onAbort = () => {
        this.pending.delete(key);
        clearTimeout(timer);
        reject(abortError());
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(key, {
        reject: error => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
        resolve: value => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        timer,
      });
    });
  }

  private async ensureSseStream(): Promise<void> {
    if (this.sseEndpoint && this.ssePump) return;
    if (this.sseConnecting) return this.sseConnecting;
    this.sseConnecting = this.openSseStream().finally(() => {
      this.sseConnecting = undefined;
    });
    return this.sseConnecting;
  }

  private async openSseStream(): Promise<void> {
    const controller = new AbortController();
    this.sseController = controller;
    const linked = linkSignals([this.upstreamSignal, controller.signal]);
    const headers = this.headers('text/event-stream');
    let response: Response;
    try {
      response = await this.fetchImpl(this.server.url, {
        credentials: requestCredentials(this.server.url),
        headers,
        method: 'GET',
        mode: 'cors',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: linked.controller.signal,
      });
    } catch (error) {
      linked.dispose();
      throw error;
    }
    if (!response.ok || !response.body) {
      const detail = response.ok ? '' : await readTextCapped(response).catch(() => '');
      linked.dispose();
      throw new Error(`MCP SSE 连接失败：${describeHttpFailure(response.status, response.statusText, detail)}`);
    }
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;
    const reader = response.body.getReader();
    this.sseReader = reader;
    const decoder = new TextDecoder();
    const sse = createSseDecoder();
    let endpointResolve!: (value: string) => void;
    let endpointReject!: (error: Error) => void;
    const endpointReady = new Promise<string>((resolve, reject) => {
      endpointResolve = resolve;
      endpointReject = reject;
    });
    this.ssePump = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const event of sse.push(decoder.decode(value, { stream: true }))) {
            if (event.event === 'endpoint') {
              endpointResolve(new URL(event.data.trim(), this.server.url).href);
              continue;
            }
            for (const message of parseJsonRpcMessages(event.data)) {
              if (message.id === undefined || message.id === null) continue;
              const pending = this.pending.get(String(message.id));
              if (!pending) continue;
              this.pending.delete(String(message.id));
              clearTimeout(pending.timer);
              try {
                pending.resolve(jsonRpcResult(message));
              } catch (error) {
                pending.reject(error instanceof Error ? error : new Error(String(error)));
              }
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          endpointReject(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        endpointReject(new Error('MCP SSE 连接已关闭。'));
        this.sseEndpoint = undefined;
        this.ssePump = undefined;
        this.sseReader = undefined;
        this.sseController = undefined;
        linked.dispose();
        this.rejectAll(new Error('MCP SSE 连接已关闭。'));
      }
    })();
    const timer = setTimeout(() => endpointReject(new Error('MCP SSE 连接超时。')), this.server.timeoutMs);
    try {
      this.sseEndpoint = await endpointReady;
    } catch (error) {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async postSseMessage(body: string): Promise<void> {
    if (!this.sseEndpoint) throw new Error('MCP SSE 连接尚未就绪。');
    const headers = this.headers(ACCEPT_JSON);
    headers.set('content-type', 'application/json');
    const response = await this.fetchImpl(this.sseEndpoint, {
      body,
      credentials: requestCredentials(this.sseEndpoint),
      headers,
      method: 'POST',
      mode: 'cors',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) {
      const detail = await readTextCapped(response).catch(() => '');
      throw new Error(`MCP 消息投递失败：${describeHttpFailure(response.status, response.statusText, detail)}`);
    }
    await response.body?.cancel().catch(() => undefined);
  }
}

/** 供测试与调试：把未知输入归一化成合法 schema。 */
export { normalizeMcpInputSchema };
