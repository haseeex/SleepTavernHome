// ── 梦境创客 stdio MCP 桥 · 真实 HTTP 端到端验证 ─────────────────
//
// 用酒馆自带的 express 起一个最小服务，挂载插件 router，走真实 HTTP 请求验证桥接。
// 需要本机装有酒馆（提供 express）；找不到时跳过而不是失败。
//
// 用法：node "docs/梦境创客/本地调试/dream-card-agent/stdio-bridge.e2e.cjs"
//       DCA_TAVERN_DIR 可覆盖酒馆路径（默认 D:/IDE/SillyTavern）

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tavernDir = process.env.DCA_TAVERN_DIR || 'D:/IDE/SillyTavern';
const expressPath = path.join(tavernDir, 'node_modules', 'express');
const pluginPath = path.join(tavernDir, 'plugins', 'dream-card-agent', 'index.js');

if (!fs.existsSync(expressPath) || !fs.existsSync(pluginPath)) {
    console.log('跳过：未找到酒馆依赖或已部署的插件');
    console.log('  express : ' + expressPath);
    console.log('  plugin  : ' + pluginPath);
    console.log('先运行 sync_to_tavern.bat 部署插件，或用 DCA_TAVERN_DIR 指定酒馆路径。');
    process.exit(0);
}

const express = require(expressPath);
const plugin = require(pluginPath);

const FAKE_SERVER = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let i = buffer.indexOf('\\n');
  while (i >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    i = buffer.indexOf('\\n');
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    if (m.method === 'initialize')
      process.stdout.write(JSON.stringify({ id: m.id, jsonrpc: '2.0', result: { capabilities: {}, protocolVersion: '2025-06-18', serverInfo: { name: 'fake', version: '1' } } }) + '\\n');
    else if (m.method === 'tools/list')
      process.stdout.write(JSON.stringify({ id: m.id, jsonrpc: '2.0', result: { tools: [{ inputSchema: { type: 'object' }, name: 'echo' }] } }) + '\\n');
    else if (m.method === 'tools/call')
      process.stdout.write(JSON.stringify({ id: m.id, jsonrpc: '2.0', result: { content: [{ text: 'ok:' + JSON.stringify(m.params.arguments), type: 'text' }] } }) + '\\n');
  }
});
`;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-e2e-'));
const fakeServer = path.join(tempDir, 'fake.js');
fs.writeFileSync(fakeServer, FAKE_SERVER, 'utf8');
fs.writeFileSync(
    path.join(tempDir, 'stdio-mcp.json'),
    JSON.stringify({ servers: { fake: { args: [fakeServer], command: process.execPath, timeoutMs: 15000 } } }),
    'utf8',
);
// 用临时配置，绝不触碰用户的 stdio-mcp.json
process.env.DCA_STDIO_MCP_CONFIG = path.join(tempDir, 'stdio-mcp.json');
process.env.DCA_DIST_DIR = path.join(tavernDir, 'plugins', 'dream-card-agent', 'dist');

const PORT = 18471;
const BASE = 'http://127.0.0.1:' + PORT;
const app = express();
const router = express.Router();

const checks = [];
function check(name, ok, detail) {
    checks.push({ name, ok });
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  ' + detail : ''));
}

async function post(url, body) {
    const response = await fetch(BASE + url, {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
    });
    const text = await response.text();
    return { body: text ? JSON.parse(text) : undefined, status: response.status };
}

async function get(url) {
    const response = await fetch(BASE + url);
    return { body: await response.json(), status: response.status };
}

async function main() {
    await plugin.init(router);
    app.use('/api/plugins/dream-card-agent', router);
    const server = app.listen(PORT);
    await new Promise(resolve => server.once('listening', resolve));

    const servers = await get('/api/plugins/dream-card-agent/mcp-stdio/servers');
    check('GET servers 返回清单', servers.status === 200 && servers.body.servers.length === 1);

    const init = await post('/api/plugins/dream-card-agent/mcp-stdio/fake', {
        id: 1,
        jsonrpc: '2.0',
        method: 'initialize',
        params: { capabilities: {}, clientInfo: { name: 'e2e', version: '1' }, protocolVersion: '2025-06-18' },
    });
    check('POST initialize 握手', init.body.result.protocolVersion === '2025-06-18');

    const notified = await post('/api/plugins/dream-card-agent/mcp-stdio/fake', {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
    });
    check('POST 通知返回 202', notified.status === 202);

    const tools = await post('/api/plugins/dream-card-agent/mcp-stdio/fake', {
        id: 2,
        jsonrpc: '2.0',
        method: 'tools/list',
    });
    check('POST tools/list', tools.body.result.tools[0].name === 'echo');

    const called = await post('/api/plugins/dream-card-agent/mcp-stdio/fake', {
        id: 3,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { arguments: { q: 1 }, name: 'echo' },
    });
    check('POST tools/call', called.body.result.content[0].text === 'ok:{"q":1}');

    const status = await get('/api/plugins/dream-card-agent/mcp-stdio/fake/status');
    check('GET status 显示运行中', status.body.running === true && status.body.initialized === true);

    const health = await get('/api/plugins/dream-card-agent/status');
    check('GET /status 健康探测', health.body.ok === true && Array.isArray(health.body.stdioMcp));

    const missing = await post('/api/plugins/dream-card-agent/mcp-stdio/nope', {
        id: 9,
        jsonrpc: '2.0',
        method: 'tools/list',
    });
    check('未知服务器 404', missing.status === 404 && missing.body.error.code === -32601);

    server.close();
    await plugin.exit();
    fs.rmSync(tempDir, { force: true, recursive: true });

    const failed = checks.filter(item => !item.ok);
    console.log('');
    console.log(failed.length === 0 ? '全部 ' + checks.length + ' 项通过' : failed.length + ' 项失败');
    process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(error => {
    console.error('验证脚本出错:', error);
    fs.rmSync(tempDir, { force: true, recursive: true });
    process.exit(1);
});
