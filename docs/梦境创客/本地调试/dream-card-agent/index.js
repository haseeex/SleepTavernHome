// ── 梦境创客 · 本地开发静态服务（SillyTavern server plugin）────────
//
// 用途：把 SleepTavernHome 构建出的 dist 以「同源」方式提供给酒馆，
//       让梦境创客的本地调试入口无需再另起 http-server、也无需 CORS。
//
// 挂载点：/api/plugins/dream-card-agent
//   GET  /status                       健康探测
//   GET  /dist/<仓库内相对路径>         静态文件（正确的 MIME + 禁用缓存）
//   POST /mcp-stdio/<id>               stdio MCP 的 JSON-RPC 桥（见 stdio-mcp.js）
//   GET  /mcp-stdio/servers            可用 stdio MCP 服务器清单
//   GET  /mcp-stdio/<id>/status        单台服务器运行状态
//   POST /mcp-stdio/<id>/restart       重启子进程
//
// 依赖：plugins/package.json 声明 type=commonjs，因此这里可直接用 require。
// 注意：dist 部分只读；mcp-stdio 只能调用 stdio-mcp.json 里已声明的命令。

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { attachStdioBridge } = require('./stdio-mcp');

const info = {
    id: 'dream-card-agent',
    name: 'Dream Card Agent Dev Server',
    description: 'Serves the SleepTavernHome build output (dist) and bridges stdio MCP servers for SillyTavern.',
    version: '1.1.0',
};

// 资源目录解析优先级：
//   1. 环境变量 DCA_DIST_DIR
//   2. 插件自带的 dist（由 sync_to_tavern 拷贝，自包含）
//   3. 开发仓库的 dist（免拷贝，直接读仓库产物）
const LOCAL_DIST_DIR = path.join(__dirname, 'dist');
const REPO_DIST_DIR = 'C:/IDE_Git/SleepTavernHome/dist';

function resolveDistDir() {
    if (process.env.DCA_DIST_DIR) return path.resolve(process.env.DCA_DIST_DIR);
    if (fs.existsSync(LOCAL_DIST_DIR)) return LOCAL_DIST_DIR;
    return path.resolve(REPO_DIST_DIR);
}

const DIST_DIR = resolveDistDir();
const DIST_SOURCE = process.env.DCA_DIST_DIR
    ? '环境变量'
    : fs.existsSync(LOCAL_DIST_DIR)
      ? '插件内置'
      : '开发仓库';

// 额外放行的 MIME（.ds 是梦境创客的资源包扩展名）
const EXTRA_MIME = {
    '.ds': 'application/octet-stream',
    '.wasm': 'application/wasm',
    '.map': 'application/json',
};

function countFiles(dir) {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) total += countFiles(full);
        else if (entry.isFile()) total += 1;
    }
    return total;
}

async function init(router) {
    const exists = fs.existsSync(DIST_DIR);
    // 自己解析 JSON，不依赖酒馆是否在插件路由前挂了 body parser；
    // body-parser 检测到 req._body 已解析会自动跳过，重复挂载安全。
    router.use('/mcp-stdio', express.json({ limit: '4mb', strict: false, type: '*/*' }));
    // stdio MCP 桥：浏览器起不了子进程，由这里托管并在同源提供 HTTP 端点。
    const stdioBridge = attachStdioBridge(router);
    // 错误中间件必须注册在路由之后才能接住它们的异常。
    router.use('/mcp-stdio', (err, _req, res, _next) => {
        const status = Number.isInteger(err && err.status) ? err.status : 400;
        res
            .status(status)
            .json({ error: { code: -32700, message: '无法解析请求体：' + (err && err.message) }, jsonrpc: '2.0' });
    });

    // 健康探测：供启动器或人工排查使用
    router.get('/status', (_req, res) => {
        res.json({
            ok: exists,
            distDir: DIST_DIR,
            source: DIST_SOURCE,
            files: exists ? countFiles(DIST_DIR) : 0,
            stdioMcp: stdioBridge.statuses().map(item => ({
                id: item.id,
                running: item.running,
            })),
            version: info.version,
        });
    });

    // 静态资源：同源提供 dist，显式关闭缓存，保证构建后刷新即生效
    router.use(
        '/dist',
        express.static(DIST_DIR, {
            etag: false,
            fallthrough: false,
            immutable: false,
            index: false,
            lastModified: false,
            maxAge: 0,
            setHeaders(res, filePath) {
                const ext = path.extname(filePath).toLowerCase();
                if (EXTRA_MIME[ext]) res.setHeader('Content-Type', EXTRA_MIME[ext]);
                res.setHeader('Cache-Control', 'no-store');
                // 允许在本地调试场景下被酒馆页面跨源引用
                res.setHeader('Access-Control-Allow-Origin', '*');
            },
        }),
    );

    // 静态中间件抛出的错误（404/403 等）统一收敛，避免污染日志
    router.use('/dist', (err, _req, res, _next) => {
        const errStatus = err ? err.status : undefined;
        const status = Number.isInteger(errStatus) ? errStatus : 500;
        if (status >= 500) console.error('[dream-card-agent] dist 服务失败:', err ? err.message : '');
        res.status(status).json({ ok: false, error: status === 404 ? '文件不存在' : '读取失败' });
    });

    console.log(
        exists
            ? '[dream-card-agent] 已挂载 dist 静态服务（' + DIST_SOURCE + '）：' + DIST_DIR
            : '[dream-card-agent] 警告：dist 目录不存在，请先构建仓库 —— ' + DIST_DIR,
    );

    exit.handlers.push(() => stdioBridge.dispose());
}

async function exit() {
    // 关闭所有 stdio MCP 子进程，避免酒馆退出后留下孤儿进程
    for (const dispose of exit.handlers.splice(0)) {
        try {
            dispose();
        } catch (error) {
            console.warn('[dream-card-agent] 清理失败:', error && error.message);
        }
    }
}

exit.handlers = [];

module.exports = { init, exit, info };
