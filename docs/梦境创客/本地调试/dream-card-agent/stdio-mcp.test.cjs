const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// 插件源码是 CommonJS，直接 require 即可；用 node:test 跑，避免把 .js 拉进 TS 构建。
const { attachStdioBridge, loadConfig, resolveCommand, resolveSpawn } = require('./stdio-mcp');

// 一个最小的 stdio MCP 服务器：读取 stdin 的 JSON-RPC 行，按 id 回包。
const FAKE_SERVER = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index = buffer.indexOf('\\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\\n');
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        id: message.id,
        jsonrpc: '2.0',
        result: { capabilities: { tools: {} }, protocolVersion: '2025-06-18', serverInfo: { name: 'fake', version: '1.0.0' } },
      }) + '\\n');
    } else if (message.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        id: message.id,
        jsonrpc: '2.0',
        result: { tools: [{ inputSchema: { type: 'object' }, name: 'echo', description: '回显' }] },
      }) + '\\n');
    } else if (message.method === 'tools/call') {
      process.stdout.write(JSON.stringify({
        id: message.id,
        jsonrpc: '2.0',
        result: { content: [{ text: 'echo:' + JSON.stringify(message.params.arguments), type: 'text' }] },
      }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ error: { code: -32601, message: 'no such method' }, id: message.id, jsonrpc: '2.0' }) + '\\n');
    }
  }
});
`;

function writeConfig(dir, servers) {
  const file = path.join(dir, 'stdio-mcp.json');
  fs.writeFileSync(file, JSON.stringify({ servers }), 'utf8');
  return file;
}

/** 极简 express 替身：记录 GET/POST 路由并按顺序匹配，足够验证桥接行为。 */
function createFakeRouter() {
  const routes = { get: [], post: [], use: [] };
  const router = {
    get: (route, handler) => routes.get.push([route, handler]),
    post: (route, handler) => routes.post.push([route, handler]),
    use: (...args) => routes.use.push(args),
  };
  const match = (pattern, actual) => {
    if (pattern === actual) return {};
    const patternParts = pattern.split('/').filter(Boolean);
    const actualParts = actual.split('/').filter(Boolean);
    if (patternParts.length !== actualParts.length) return undefined;
    const params = {};
    for (let index = 0; index < patternParts.length; index += 1) {
      const part = patternParts[index];
      if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(actualParts[index]);
      else if (part !== actualParts[index]) return undefined;
    }
    return params;
  };
  return {
    router,
    async call(method, url, body) {
      for (const [pattern, handler] of routes[method]) {
        const params = match(pattern, url);
        if (!params) continue;
        return new Promise(resolve => {
          const res = {
            body: undefined,
            headers: {},
            statusCode: 200,
            json(payload) {
              this.body = payload;
              resolve({ body: payload, status: this.statusCode });
              return this;
            },
            setHeader(name, value) {
              this.headers[name] = value;
            },
            status(code) {
              this.statusCode = code;
              return this;
            },
            end() {
              resolve({ body: undefined, status: this.statusCode });
              return this;
            },
          };
          handler({ body, params, query: {} }, res);
        });
      }
      throw new Error(`没有匹配的路由：${method.toUpperCase()} ${url}`);
    },
  };
}

function createHarness(configPath) {
  const previous = process.env.DCA_STDIO_MCP_CONFIG;
  process.env.DCA_STDIO_MCP_CONFIG = configPath;
  const fake = createFakeRouter();
  const bridge = attachStdioBridge(fake.router);
  return {
    bridge,
    call: fake.call,
    dispose() {
      bridge.dispose();
      if (previous === undefined) delete process.env.DCA_STDIO_MCP_CONFIG;
      else process.env.DCA_STDIO_MCP_CONFIG = previous;
    },
  };
}

test('loadConfig 只接受 stdio 条目并跳过 http/sse', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-mcp-'));
  const configPath = writeConfig(dir, {
    remote: { type: 'http', url: 'https://example.com/mcp' },
    searxng: { args: ['-y', 'mcp-searxng'], command: 'npx', description: '检索' },
    off: { command: 'npx', disabled: true },
  });
  const previous = process.env.DCA_STDIO_MCP_CONFIG;
  process.env.DCA_STDIO_MCP_CONFIG = configPath;
  try {
    const loaded = loadConfig();
    assert.deepStrictEqual(
      loaded.servers.map(item => item.id),
      ['searxng'],
    );
    assert.strictEqual(loaded.servers[0].description, '检索');
    assert.deepStrictEqual(loaded.servers[0].args, ['-y', 'mcp-searxng']);
  } finally {
    if (previous === undefined) delete process.env.DCA_STDIO_MCP_CONFIG;
    else process.env.DCA_STDIO_MCP_CONFIG = previous;
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test('loadConfig 缺少文件时不报错，只返回空列表', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-mcp-'));
  const previous = process.env.DCA_STDIO_MCP_CONFIG;
  process.env.DCA_STDIO_MCP_CONFIG = path.join(dir, 'missing.json');
  try {
    const loaded = loadConfig();
    assert.deepStrictEqual(loaded.servers, []);
    assert.strictEqual(loaded.error, undefined);
  } finally {
    if (previous === undefined) delete process.env.DCA_STDIO_MCP_CONFIG;
    else process.env.DCA_STDIO_MCP_CONFIG = previous;
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test('resolveCommand 在 Windows 上解析出可执行文件', () => {
  const resolved = resolveCommand(process.execPath);
  assert.ok(resolved);
  // 绝对路径原样返回
  assert.strictEqual(resolveCommand('/usr/bin/env'), '/usr/bin/env');
  assert.strictEqual(resolveCommand(process.execPath), process.execPath);
});

test('resolveSpawn 把 .cmd/.bat 转交给 cmd.exe', () => {
  if (process.platform !== 'win32') {
    const result = resolveSpawn('/bin/sh', ['-c', 'echo hi']);
    assert.strictEqual(result.command, '/bin/sh');
    assert.deepStrictEqual(result.args, ['-c', 'echo hi']);
    assert.strictEqual(result.verbatim, false);
    return;
  }
  // Node 18.20+ 直接 spawn .cmd 会抛 EINVAL，必须经 cmd.exe /d /s /c 转发。
  const batch = resolveSpawn('npx', ['-y', 'mcp-searxng']);
  assert.match(batch.command, /cmd\.exe$/iu);
  assert.deepStrictEqual(batch.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(batch.args[3], /npx\.cmd/iu);
  assert.ok(batch.args[3].startsWith('"') && batch.args[3].endsWith('"'));
  assert.strictEqual(batch.verbatim, true);

  // .exe 不经过 shell
  const exe = resolveSpawn(process.execPath, ['-v']);
  assert.strictEqual(exe.command, process.execPath);
  assert.deepStrictEqual(exe.args, ['-v']);
  assert.strictEqual(exe.verbatim, false);
});

test('经 .cmd 包装也能启动子进程（EINVAL 回归）', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-mcp-'));
  const script = path.join(dir, 'fake-server.js');
  fs.writeFileSync(script, FAKE_SERVER, 'utf8');
  const wrapper = path.join(dir, 'fake.cmd');
  fs.writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${script}"\r\n`, 'utf8');
  const configPath = writeConfig(dir, { viaCmd: { args: [], command: wrapper, timeoutMs: 20000 } });
  const harness = createHarness(configPath);
  try {
    const init = await harness.call('post', '/mcp-stdio/viaCmd', {
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: {},
    });
    assert.strictEqual(init.body.result.protocolVersion, '2025-06-18');
    const tools = await harness.call('post', '/mcp-stdio/viaCmd', { id: 2, jsonrpc: '2.0', method: 'tools/list' });
    assert.deepStrictEqual(
      tools.body.result.tools.map(item => item.name),
      ['echo'],
    );
  } finally {
    harness.dispose();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test('桥接端点完整跑通 initialize → tools/list → tools/call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-mcp-'));
  const script = path.join(dir, 'fake-server.js');
  fs.writeFileSync(script, FAKE_SERVER, 'utf8');
  const configPath = writeConfig(dir, {
    fake: { command: process.execPath, args: [script], timeoutMs: 15000 },
  });
  const harness = createHarness(configPath);
  try {
    const list = await harness.call('get', '/mcp-stdio/servers');
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(
      list.body.servers.map(item => item.id),
      ['fake'],
    );
    assert.strictEqual(list.body.servers[0].running, false);

    const init = await harness.call('post', '/mcp-stdio/fake', {
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: { capabilities: {}, clientInfo: { name: 't', version: '1' }, protocolVersion: '2025-06-18' },
    });
    assert.strictEqual(init.body.id, 1);
    assert.strictEqual(init.body.result.protocolVersion, '2025-06-18');

    // 通知返回 202
    const notified = await harness.call('post', '/mcp-stdio/fake', { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.strictEqual(notified.status, 202);
    assert.strictEqual(notified.body, undefined);

    const tools = await harness.call('post', '/mcp-stdio/fake', { id: 2, jsonrpc: '2.0', method: 'tools/list' });
    assert.deepStrictEqual(
      tools.body.result.tools.map(item => item.name),
      ['echo'],
    );

    const called = await harness.call('post', '/mcp-stdio/fake', {
      id: 3,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { text: 'hi' }, name: 'echo' },
    });
    assert.strictEqual(called.body.result.content[0].text, 'echo:{"text":"hi"}');

    // 重连时复用首次 initialize 的结果，子进程不会被重复握手打断
    const again = await harness.call('post', '/mcp-stdio/fake', {
      id: 9,
      jsonrpc: '2.0',
      method: 'initialize',
      params: { capabilities: {}, clientInfo: { name: 't', version: '1' }, protocolVersion: '2025-06-18' },
    });
    assert.strictEqual(again.body.id, 9);
    assert.strictEqual(again.body.result.serverInfo.name, 'fake');

    const status = await harness.call('get', '/mcp-stdio/fake/status');
    assert.strictEqual(status.body.running, true);
    assert.strictEqual(status.body.initialized, true);
  } finally {
    harness.dispose();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test('未知服务器返回 404 与 JSON-RPC 错误', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-mcp-'));
  const configPath = writeConfig(dir, {});
  const harness = createHarness(configPath);
  try {
    const response = await harness.call('post', '/mcp-stdio/nope', { id: 1, jsonrpc: '2.0', method: 'tools/list' });
    assert.strictEqual(response.status, 404);
    assert.strictEqual(response.body.error.code, -32601);
  } finally {
    harness.dispose();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test('子进程启动失败时把错误回给调用方', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-mcp-'));
  const configPath = writeConfig(dir, {
    broken: { args: [], command: path.join(dir, 'does-not-exist.exe'), timeoutMs: 5000 },
  });
  const harness = createHarness(configPath);
  try {
    const response = await harness.call('post', '/mcp-stdio/broken', {
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: {},
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.id, 1);
    assert.match(response.body.error.message, /ENOENT|启动失败|未运行/u);
  } finally {
    harness.dispose();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test('restart 会换掉子进程', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-mcp-'));
  const script = path.join(dir, 'fake-server.js');
  fs.writeFileSync(script, FAKE_SERVER, 'utf8');
  const configPath = writeConfig(dir, { fake: { args: [script], command: process.execPath, timeoutMs: 15000 } });
  const harness = createHarness(configPath);
  try {
    await harness.call('post', '/mcp-stdio/fake', { id: 1, jsonrpc: '2.0', method: 'initialize', params: {} });
    const before = await harness.call('get', '/mcp-stdio/fake/status');
    const restarted = await harness.call('post', '/mcp-stdio/fake/restart', {});
    assert.strictEqual(restarted.status, 200);
    assert.strictEqual(restarted.body.ok, true);
    // 重启后 initialized 归零，说明确实换了进程
    assert.strictEqual(restarted.body.status.initialized, false);
    assert.ok(before.body.startedAt);
  } finally {
    harness.dispose();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

test('dispose 会杀掉子进程', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-mcp-'));
  const script = path.join(dir, 'fake-server.js');
  fs.writeFileSync(script, FAKE_SERVER, 'utf8');
  const configPath = writeConfig(dir, { fake: { args: [script], command: process.execPath, timeoutMs: 15000 } });
  const harness = createHarness(configPath);
  await harness.call('post', '/mcp-stdio/fake', { id: 1, jsonrpc: '2.0', method: 'initialize', params: {} });
  const before = await harness.call('get', '/mcp-stdio/fake/status');
  assert.strictEqual(before.body.running, true);
  harness.dispose();
  // dispose 会清空服务器注册表，因此再访问同一端点应得到 404
  const after = await harness.call('get', '/mcp-stdio/fake/status');
  assert.strictEqual(after.status, 404);
  fs.rmSync(dir, { force: true, recursive: true });
});

// index.js 依赖酒馆提供的 express，仓库里没有；缺依赖时跳过而不是失败。
const hasExpress = (() => {
  try {
    require.resolve('express');
    return true;
  } catch {
    return false;
  }
})();

test('插件 index.js 能加载并暴露桥接路由', { skip: hasExpress ? false : '本机没有 express（酒馆才提供）' }, async () => {
  const plugin = require('./index.js');
  assert.strictEqual(plugin.info.id, 'dream-card-agent');
  assert.strictEqual(typeof plugin.init, 'function');
  assert.strictEqual(typeof plugin.exit, 'function');
  const fake = createFakeRouter();
  await plugin.init(fake.router);
  // /status 健康探测可用
  const status = await fake.call('get', '/status');
  assert.ok('ok' in status.body);
  await plugin.exit();
});
