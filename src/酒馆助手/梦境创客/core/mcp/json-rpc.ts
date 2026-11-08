// MCP 使用 JSON-RPC 2.0。这里只保留客户端需要的消息形态与 SSE 帧解析，
// 不引入完整协议库，便于在酒馆页面里做最小依赖实现。

export type JsonRpcId = number | string;

export type JsonRpcErrorPayload = {
  code: number;
  data?: unknown;
  message: string;
};

export type JsonRpcMessage = {
  error?: JsonRpcErrorPayload;
  id?: JsonRpcId | null;
  jsonrpc?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
};

export type SseEvent = {
  data: string;
  event: string;
};

export function serializeJsonRpcRequest(id: JsonRpcId, method: string, params?: unknown): string {
  return JSON.stringify({ id, jsonrpc: '2.0', method, params });
}

export function serializeJsonRpcNotification(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params });
}

/** 服务器可能返回单条消息或批量数组；批量时按顺序展开。 */
export function parseJsonRpcMessages(raw: string): JsonRpcMessage[] {
  const text = raw.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter(
    (item): item is JsonRpcMessage => typeof item === 'object' && item !== null && !Array.isArray(item),
  );
}

export function isResponseFor(message: JsonRpcMessage, id: JsonRpcId): boolean {
  if (message.id === undefined || message.id === null) return false;
  return String(message.id) === String(id);
}

export function jsonRpcResult(message: JsonRpcMessage): unknown {
  if (message.error) {
    const detail =
      typeof message.error.data === 'string' ? `：${message.error.data}` : '';
    throw new Error(`MCP 服务器返回错误 ${message.error.code}：${message.error.message}${detail}`);
  }
  return message.result;
}

export type SseDecoder = {
  /** 流结束时把未以空行收尾的最后一个事件补发出去。 */
  flush(): SseEvent[];
  /** 接收已解码的文本片段，返回完整事件。 */
  push(chunk: string): SseEvent[];
};

/**
 * 增量 SSE 解码器：`push` 接收已解码的文本片段，返回完整事件。
 * 支持 `\n`、`\r\n`、`\r` 三种换行，多行 `data:` 按规范用换行拼接。
 */
export function createSseDecoder(): SseDecoder {
  let buffer = '';
  let data: string[] = [];
  let event = '';

  const dispatch = (events: SseEvent[]) => {
    if (data.length > 0) events.push({ data: data.join('\n'), event: event || 'message' });
    data = [];
    event = '';
  };

  const consumeLine = (line: string, events: SseEvent[]) => {
    if (line === '') {
      dispatch(events);
      return;
    }
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  };

  return {
    push(chunk: string): SseEvent[] {
      buffer += chunk;
      const events: SseEvent[] = [];
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        let line = buffer.slice(0, index);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        buffer = buffer.slice(index + 1);
        consumeLine(line, events);
        index = buffer.indexOf('\n');
      }
      // 兼容仅用 \r 换行的服务器：只在缓冲区末尾出现孤立 \r 时切分。
      if (buffer.includes('\r') && !buffer.includes('\n')) {
        const parts = buffer.split('\r');
        buffer = parts.pop() ?? '';
        for (const line of parts) consumeLine(line, events);
      }
      return events;
    },
    flush(): SseEvent[] {
      const events: SseEvent[] = [];
      if (buffer) {
        consumeLine(buffer.replace(/\r$/u, ''), events);
        buffer = '';
      }
      dispatch(events);
      return events;
    },
  };
}

export function eventDataPayloads(event: SseEvent): JsonRpcMessage[] {
  if (event.event !== 'message' && event.event !== '') return [];
  return parseJsonRpcMessages(event.data);
}
