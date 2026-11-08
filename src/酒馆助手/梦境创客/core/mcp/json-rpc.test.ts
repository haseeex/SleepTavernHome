import { describe, expect, it } from 'vitest';
import {
    createSseDecoder,
    isResponseFor,
    jsonRpcResult,
    parseJsonRpcMessages,
    serializeJsonRpcNotification,
    serializeJsonRpcRequest,
} from './json-rpc';

describe('JSON-RPC 序列化', () => {
  it('生成请求与通知', () => {
    expect(JSON.parse(serializeJsonRpcRequest(1, 'tools/list', {}))).toEqual({
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
    });
    expect(JSON.parse(serializeJsonRpcNotification('notifications/initialized'))).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
  });

  it('解析单条与批量响应并忽略损坏输入', () => {
    expect(parseJsonRpcMessages('{"id":1,"result":{}}')).toHaveLength(1);
    expect(parseJsonRpcMessages('[{"id":1},{"id":2}]')).toHaveLength(2);
    expect(parseJsonRpcMessages('not json')).toEqual([]);
    expect(parseJsonRpcMessages('')).toEqual([]);
  });

  it('按 id 匹配响应并转换错误', () => {
    expect(isResponseFor({ id: 2 }, 2)).toBe(true);
    expect(isResponseFor({ id: '2' }, 2)).toBe(true);
    expect(isResponseFor({}, 2)).toBe(false);
    expect(() => jsonRpcResult({ error: { code: -32601, message: 'not found' } })).toThrow(
      /MCP 服务器返回错误 -32601：not found/u,
    );
    expect(jsonRpcResult({ result: { ok: true } })).toEqual({ ok: true });
  });
});

describe('SSE 解码', () => {
  it('跨分片拼接事件并按空行分发', () => {
    const decoder = createSseDecoder();
    expect(decoder.push('event: message\ndata: {"id":')).toEqual([]);
    expect(decoder.push('1,"result":{}}\n\n')).toEqual([{ data: '{"id":1,"result":{}}', event: 'message' }]);
  });

  it('支持 CRLF、多行 data 与注释', () => {
    const decoder = createSseDecoder();
    const events = decoder.push(': ping\r\nevent: message\r\ndata: {"id":1,\r\ndata: "result":true}\r\n\r\n');
    expect(events).toEqual([{ data: '{"id":1,\n"result":true}', event: 'message' }]);
  });

  it('识别 endpoint 事件并在结束时补发残留事件', () => {
    const decoder = createSseDecoder();
    expect(decoder.push('event: endpoint\ndata: /messages?sessionId=abc\n\n')).toEqual([
      { data: '/messages?sessionId=abc', event: 'endpoint' },
    ]);
    expect(decoder.push('event: message\ndata: {"id":3,"result":1}')).toEqual([]);
    expect(decoder.flush()).toEqual([{ data: '{"id":3,"result":1}', event: 'message' }]);
  });
});
