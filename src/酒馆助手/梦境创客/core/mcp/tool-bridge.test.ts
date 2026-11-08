import { describe, expect, it, vi } from 'vitest';
import { isRichToolOutput } from '../runner/tool-output';
import { createMcpRunnerTools, describeMcpToolError } from './tool-bridge';
import type { McpServerConfig, McpToolInfo } from './types';

const server: McpServerConfig = {
  enabled: true,
  headers: [],
  id: 'mcp-1a2b3c4d',
  name: '文件服务器',
  timeoutMs: 5_000,
  transport: 'http',
  url: 'https://mcp.example.com/mcp',
};

function info(overrides: Partial<McpToolInfo> = {}): McpToolInfo {
  return {
    description: '读取文件内容',
    inputSchema: { properties: { path: { type: 'string' } }, required: ['path'], type: 'object' },
    name: 'read_file',
    readOnly: true,
    ...overrides,
  };
}

describe('MCP 工具桥接', () => {
  it('生成带服务器前缀的工具名与描述', () => {
    const [tool] = createMcpRunnerTools(server, [info()], {
      approvalMode: () => 'manual',
      call: vi.fn(),
    });
    expect(tool.name).toBe('mcp__1a2b3c4d__read_file');
    expect(tool.readonly).toBe(true);
    expect(tool.definition.description).toContain('[MCP 文件服务器]');
    expect(tool.definition.description).toContain('读取文件内容');
  });

  it('只读工具在手动模式下不需要审批，写入类工具需要', () => {
    const tools = createMcpRunnerTools(server, [info(), info({ name: 'write_file', readOnly: false })], {
      approvalMode: () => 'manual',
      call: vi.fn(),
    });
    const read = tools.find(item => item.name.endsWith('read_file'))!;
    const write = tools.find(item => item.name.endsWith('write_file'))!;
    expect(read.confirmation?.({}, 'call-1')).toBeUndefined();
    expect(write.confirmation?.({}, 'call-2')).toMatchObject({
      risk: 'ordinary',
      toolCallId: 'call-2',
      toolName: write.name,
    });
  });

  it('把返回内容包装成富输出', async () => {
    const call = vi.fn(async () => ({
      content: [
        { text: '第一行', type: 'text' },
        { data: 'AAAA', mimeType: 'image/png', type: 'image' },
      ],
      isError: false,
    }));
    const [tool] = createMcpRunnerTools(server, [info()], { approvalMode: () => 'full', call });

    const result = await tool.execute({ path: '/a.txt' }, 'call-1');

    expect(call).toHaveBeenCalledWith('read_file', { path: '/a.txt' }, undefined);
    expect(isRichToolOutput(result)).toBe(true);
    if (!isRichToolOutput(result)) throw new Error('expected rich output');
    expect(result.modelOutput).toEqual({ type: 'json', value: '第一行\n[图片 image/png]' });
    expect(result.display).toMatchObject({ server: '文件服务器', tool: 'read_file', isError: false });
  });

  it('结构化内容保留在模型输出中，isError 转为异常', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ content: [], isError: false, structuredContent: { rows: 2 } })
      .mockResolvedValueOnce({ content: [{ text: '权限不足', type: 'text' }], isError: true });
    const [tool] = createMcpRunnerTools(server, [info()], { approvalMode: () => 'full', call });

    const ok = await tool.execute({}, 'call-1');
    if (!isRichToolOutput(ok)) throw new Error('expected rich output');
    expect(ok.modelOutput).toEqual({ type: 'json', value: { content: undefined, structuredContent: { rows: 2 } } });
    await expect(tool.execute({}, 'call-2')).rejects.toThrow('权限不足');
  });

  it('服务器内部 abort 的错误补上归因，不让人以为是客户端取消', async () => {
    // searxng 这类服务器会把自己的 fetch 异常原样放进 content：
    // 「Network Error: This operation was aborted」。
    const call = vi.fn(async () => ({
      content: [{ text: 'Network Error: This operation was aborted', type: 'text' }],
      isError: true,
    }));
    const [tool] = createMcpRunnerTools(server, [info()], { approvalMode: () => 'full', call });

    const failure = tool.execute({}, 'call-1');
    await expect(failure).rejects.toThrow(/这是服务器内部的请求被取消或超时，不是梦境创客取消的/u);
    await expect(failure).rejects.toThrow(/Network Error: This operation was aborted/u);
  });

  it('网络类错误提示检查后端可达性', () => {
    expect(describeMcpToolError('fetch failed: ECONNREFUSED', '文件服务器', 'read_file')).toMatch(
      /无法访问它的后端服务/u,
    );
    expect(describeMcpToolError('401 Unauthorized', '文件服务器', 'read_file')).toMatch(/后端拒绝了鉴权/u);
    expect(describeMcpToolError('普通失败', '文件服务器', 'read_file')).toBe(
      'MCP 工具 文件服务器 / read_file 执行失败：普通失败',
    );
  });

  it('同名工具追加序号避免冲突', () => {
    const longName = 'a'.repeat(60);
    const tools = createMcpRunnerTools(server, [info({ name: longName }), info({ name: `${longName}b` })], {
      approvalMode: () => 'full',
      call: vi.fn(),
    });
    expect(new Set(tools.map(tool => tool.name)).size).toBe(2);
    expect(tools.every(tool => tool.name.length <= 64)).toBe(true);
  });
});
