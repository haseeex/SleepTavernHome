import type { RunnerTool } from '../runner/tools';
import { McpClient, McpRateLimitError } from './client';
import { createMcpRunnerTools } from './tool-bridge';
import type { McpCallToolResult, McpServerConfig, McpServerState, McpServerStatus, McpToolInfo } from './types';

export type McpToolManagerOptions = {
  fetch?: typeof fetch;
  /** 工具列表或状态变化时通知宿主，用于刷新界面与空闲会话的工具集。 */
  onChanged?: () => void;
  now?: () => number;
};

type ServerRuntime = {
  client?: McpClient;
  config: McpServerConfig;
  error?: string;
  /** 被限流时的时间戳；在此之前不再发起连接，避免越重试锁得越久。 */
  retryAt?: number;
  state: McpServerState;
  tools: McpToolInfo[];
  updatedAt?: number;
};

const MAX_CONCURRENT_CONNECTIONS = 3;

function sameConnection(left: McpServerConfig, right: McpServerConfig): boolean {
  return (
    left.url === right.url &&
    left.transport === right.transport &&
    left.timeoutMs === right.timeoutMs &&
    left.enabled === right.enabled &&
    left.name === right.name &&
    left.headers.length === right.headers.length &&
    left.headers.every(
      (header, index) => header.name === right.headers[index]?.name && header.value === right.headers[index]?.value,
    )
  );
}

/**
 * 多服务器 MCP 工具注册表：负责连接、缓存 `tools/list` 结果，
 * 并把缓存同步转成 RunnerTool（会话构建过程是同步的，不能等待网络）。
 */
export class McpToolManager {
  private readonly fetchImpl?: typeof fetch;
  private readonly now: () => number;
  private readonly onChanged?: () => void;
  private readonly runtimes = new Map<string, ServerRuntime>();
  private readonly refreshing = new Map<string, Promise<McpServerStatus>>();
  private configSignature = '';
  private disposed = false;

  constructor(options: McpToolManagerOptions = {}) {
    this.fetchImpl = options.fetch;
    this.now = options.now ?? Date.now;
    this.onChanged = options.onChanged;
  }

  /** 同步应用最新配置；连接参数变化会关闭旧客户端并等待下一次刷新。 */
  configure(configs: McpServerConfig[]): void {
    const signature = JSON.stringify(configs);
    if (signature === this.configSignature) return;
    this.configSignature = signature;
    const nextIds = new Set(configs.map(config => config.id));
    for (const [id, runtime] of this.runtimes) {
      if (nextIds.has(id)) continue;
      runtime.client?.close();
      this.runtimes.delete(id);
    }
    for (const config of configs) {
      const existing = this.runtimes.get(config.id);
      if (!existing) {
        this.runtimes.set(config.id, { config, state: 'idle', tools: [] });
        continue;
      }
      if (sameConnection(existing.config, config)) {
        existing.config = config;
        continue;
      }
      existing.client?.close();
      this.runtimes.set(config.id, { config, state: 'idle', tools: [] });
    }
    this.onChanged?.();
  }

  statuses(): McpServerStatus[] {
    return [...this.runtimes.values()].map(runtime => this.statusOf(runtime));
  }

  hasTools(): boolean {
    return [...this.runtimes.values()].some(runtime => runtime.config.enabled && runtime.tools.length > 0);
  }

  /** 从缓存生成工具；未刷新过的服务器不会产生工具。 */
  tools(options: { approvalMode: () => 'full' | 'manual' | 'yolo' }): RunnerTool[] {
    return [...this.runtimes.values()].flatMap(runtime => {
      if (!runtime.config.enabled || runtime.state !== 'ready' || runtime.tools.length === 0) return [];
      const client = runtime.client;
      if (!client) return [];
      return createMcpRunnerTools(runtime.config, runtime.tools, {
        approvalMode: options.approvalMode,
        call: (toolName, args, signal) => client.callTool(toolName, args, signal),
      });
    });
  }

  async refresh(ids?: string[]): Promise<McpServerStatus[]> {
    const targets = [...this.runtimes.values()].filter(
      runtime => runtime.config.enabled && (!ids || ids.includes(runtime.config.id)),
    );
    const results: McpServerStatus[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const runtime = targets[cursor++];
        results.push(await this.refreshRuntime(runtime));
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_CONNECTIONS, targets.length) }, () => worker()),
    );
    return results;
  }

  async refreshServer(id: string): Promise<McpServerStatus> {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`MCP 服务器不存在：${id}`);
    if (!runtime.config.enabled) {
      runtime.client?.close();
      runtime.client = undefined;
      runtime.tools = [];
      runtime.error = undefined;
      runtime.state = 'idle';
      this.onChanged?.();
      return this.statusOf(runtime);
    }
    return this.refreshRuntime(runtime);
  }

  async callTool(serverId: string, toolName: string, args: unknown, signal?: AbortSignal): Promise<McpCallToolResult> {
    const runtime = this.runtimes.get(serverId);
    if (!runtime?.client) throw new Error(`MCP 服务器未连接：${serverId}`);
    return runtime.client.callTool(toolName, args, signal);
  }

  dispose(): void {
    this.disposed = true;
    for (const runtime of this.runtimes.values()) runtime.client?.close();
    this.runtimes.clear();
  }

  private statusOf(runtime: ServerRuntime): McpServerStatus {
    const remaining = runtime.retryAt ? Math.ceil((runtime.retryAt - this.now()) / 1000) : 0;
    return {
      // 限流剩余时间要显示出来，否则用户点“刷新”看起来毫无反应。
      error: remaining > 0 ? `酒馆登录限流中，还需等待约 ${remaining} 秒（期间不会重试）。` : runtime.error,
      id: runtime.config.id,
      name: runtime.config.name,
      state: runtime.state,
      toolCount: runtime.tools.length,
      tools: runtime.tools.map(tool => ({ ...tool })),
      updatedAt: runtime.updatedAt,
    };
  }

  private refreshRuntime(runtime: ServerRuntime): Promise<McpServerStatus> {
    const existing = this.refreshing.get(runtime.config.id);
    if (existing) return existing;
    const task = this.connect(runtime).finally(() => {
      this.refreshing.delete(runtime.config.id);
    });
    this.refreshing.set(runtime.config.id, task);
    return task;
  }

  private async connect(runtime: ServerRuntime): Promise<McpServerStatus> {
    // 限流未解除前直接返回上次结果：酒馆会继续延长封锁，重试只会更糟。
    if (runtime.retryAt && this.now() < runtime.retryAt) {
      return this.statusOf(runtime);
    }
    runtime.retryAt = undefined;
    runtime.state = 'connecting';
    runtime.error = undefined;
    this.onChanged?.();
    try {
      runtime.client?.close();
      const client = new McpClient(runtime.config, { fetch: this.fetchImpl });
      runtime.client = client;
      await client.initialize();
      const tools = await client.listTools();
      if (this.disposed) {
        client.close();
        throw new Error('MCP 管理器已销毁。');
      }
      runtime.tools = tools;
      runtime.state = 'ready';
      runtime.updatedAt = this.now();
    } catch (error) {
      runtime.client?.close();
      runtime.client = undefined;
      runtime.tools = [];
      runtime.state = 'error';
      runtime.error = error instanceof Error ? error.message : String(error);
      runtime.updatedAt = this.now();
      if (error instanceof McpRateLimitError) {
        runtime.retryAt = this.now() + error.retryAfterMs;
      }
    }
    this.onChanged?.();
    return this.statusOf(runtime);
  }
}
