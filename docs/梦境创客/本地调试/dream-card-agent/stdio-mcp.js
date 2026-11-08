// ── 梦境创客 · MCP stdio 桥接 ────────────────────────────────────
//
// 浏览器无法启动子进程，所以 stdio 型 MCP 服务器由这个插件（跑在酒馆 Node 进程里）
// 托管，再以「Streamable HTTP 的极简形态」暴露给酒馆页面：
//   POST   /mcp-stdio/<id>         单条 JSON-RPC 请求 → 返回 JSON（通知返回 202）
//   GET    /mcp-stdio/servers      可用服务器清单（不含 env / 命令细节）
//   GET    /mcp-stdio/<id>/status  单台服务器运行状态
//   POST   /mcp-stdio/<id>/restart 重启子进程
//
// 配置文件（默认插件目录 stdio-mcp.json，可用 DCA_STDIO_MCP_CONFIG 覆盖）：
//   { "servers": { "searxng": { "command": "npx", "args": ["-y", "mcp-searxng"], "env": {...} } } }
// 兼容 VSCode mcp.json 的 servers 结构：type 为 stdio（或省略但带 command）的条目会被采用，
// http/sse 条目直接跳过，方便用户整份粘贴。
//
// 安全：命令只能来自服务器本地文件，浏览器无法通过接口执行任意命令。

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROTOCOL_VERSION = '2025-06-18';
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const STDERR_LINES = 40;
const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * 首次握手要等子进程真正起来：`npx -y <pkg>` 会下载包，实测可能 60 秒以上。
 * initialize 单独用更长的超时，不跟着用户设置的请求超时走。
 */
const STARTUP_TIMEOUT_MS = 180_000;
/** MCP 规范：initialize 只允许一次；桥接层缓存结果，让浏览器刷新后可重连。 */
const INIT_METHOD = 'initialize';
const INITIALIZED_NOTIFICATION = 'notifications/initialized';

function log(message) {
    console.log('[dream-card-agent/mcp-stdio] ' + message);
}

function warn(message) {
    console.warn('[dream-card-agent/mcp-stdio] ' + message);
}

function resolveConfigPath() {
    if (process.env.DCA_STDIO_MCP_CONFIG) return path.resolve(process.env.DCA_STDIO_MCP_CONFIG);
    return path.join(__dirname, 'stdio-mcp.json');
}

/**
 * Windows 上 spawn('npx') 找不到 npx.cmd（Node 不做 PATHEXT 解析）。
 * 这里按 PATH + PATHEXT 解析出真实文件。
 */
function resolveCommand(command) {
    if (!command) return command;
    if (command.includes('/') || command.includes('\\')) return command;
    if (process.platform !== 'win32') return command;
    const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    const directories = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const directory of directories) {
        for (const extension of extensions) {
            const candidate = path.join(directory, command + extension);
            try {
                if (fs.statSync(candidate).isFile()) return candidate;
            } catch {
                // 继续找下一个
            }
        }
        const bare = path.join(directory, command);
        try {
            if (fs.statSync(bare).isFile()) return bare;
        } catch {
            // 继续找下一个
        }
    }
    return command;
}

/** cmd 里含空格/引号的参数需要包裹；引号本身用双写处理。 */
function quoteForCmd(value) {
    if (!/[\s"]/u.test(value)) return value;
    return '"' + value.replace(/"/gu, '""') + '"';
}

/**
 * 算出真正要 spawn 的 (command, args)。
 *
 * Node 从 18.20/20.12 起禁止直接 spawn `.cmd` / `.bat`（CVE-2024-27980 的修复），
 * 会抛 `spawn EINVAL`。所以批处理入口必须经 `cmd.exe /d /s /c` 转发 —— 这也是
 * Node 自己 `shell: true` 的做法。命令来自服务器本地配置文件，不受浏览器影响。
 */
function resolveSpawn(command, args) {
    const resolved = resolveCommand(command);
    if (process.platform !== 'win32' || !/\.(cmd|bat)$/iu.test(resolved)) {
        return { args, command: resolved, verbatim: false };
    }
    const line = [resolved, ...args].map(quoteForCmd).join(' ');
    return {
        // /s 会剥掉最外层一对引号，因此整条命令要再包一层。
        args: ['/d', '/s', '/c', '"' + line + '"'],
        command: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
        verbatim: true,
    };
}

function normalizeServerEntry(id, raw) {
    if (!raw || typeof raw !== 'object') return undefined;
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    if (!command) return undefined;
    if (raw.type && raw.type !== 'stdio') return undefined;
    if (raw.disabled === true || raw.enabled === false) return undefined;
    const args = Array.isArray(raw.args) ? raw.args.filter(item => typeof item === 'string') : [];
    const env = {};
    if (raw.env && typeof raw.env === 'object') {
        for (const [key, value] of Object.entries(raw.env)) {
            if (typeof value === 'string') env[key] = value;
        }
    }
    const timeout = Number(raw.timeoutMs);
    return {
        args,
        command,
        cwd: typeof raw.cwd === 'string' && raw.cwd ? path.resolve(raw.cwd) : undefined,
        description: typeof raw.description === 'string' ? raw.description.slice(0, 500) : '',
        env,
        id,
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : id,
        timeoutMs: Number.isFinite(timeout) ? Math.min(600_000, Math.max(5_000, Math.floor(timeout))) : DEFAULT_TIMEOUT_MS,
    };
}

function loadConfig() {
    const configPath = resolveConfigPath();
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
        if (error && error.code === 'ENOENT') return { configPath, error: undefined, servers: [] };
        return { configPath, error: '读取失败：' + (error instanceof Error ? error.message : String(error)), servers: [] };
    }
    const source = raw && typeof raw === 'object' && raw.servers && typeof raw.servers === 'object' ? raw.servers : raw;
    const servers = [];
    if (source && typeof source === 'object') {
        for (const [id, entry] of Object.entries(source)) {
            if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
                warn('忽略非法服务器名：' + id);
                continue;
            }
            const normalized = normalizeServerEntry(id, entry);
            if (normalized) servers.push(normalized);
        }
    }
    return { configPath, error: undefined, servers };
}

/** 一条 stdio MCP 子进程；同一 id 全局复用，浏览器刷新不会重复起进程。 */
class StdioServer {
    constructor(definition) {
        this.definition = definition;
        this.child = undefined;
        this.pending = new Map();
        this.stderrLines = [];
        this.stdoutBuffer = '';
        this.nextId = 1;
        this.initResult = undefined;
        this.initializedSent = false;
        this.protocolVersion = '';
        this.lastError = undefined;
        this.startedAt = undefined;
        this.starting = undefined;
    }

    status() {
        return {
            args: this.definition.args,
            command: this.definition.command,
            description: this.definition.description,
            error: this.lastError,
            id: this.definition.id,
            initialized: this.initResult !== undefined,
            name: this.definition.name,
            running: Boolean(this.child),
            startedAt: this.startedAt,
            stderr: this.stderrLines.slice(-10),
        };
    }

    ensureStarted() {
        if (this.child) return Promise.resolve();
        if (this.starting) return this.starting;
        this.starting = this.start().finally(() => {
            this.starting = undefined;
        });
        return this.starting;
    }

    start() {
        return new Promise((resolve, reject) => {
            const target = resolveSpawn(this.definition.command, this.definition.args);
            const command = target.command;
            let child;
            try {
                child = spawn(command, target.args, {
                    cwd: this.definition.cwd,
                    env: { ...process.env, ...this.definition.env },
                    stdio: ['pipe', 'pipe', 'pipe'],
                    // 批处理经 cmd.exe 转发时必须原样传参，否则 Node 会再转义一次。
                    windowsVerbatimArguments: target.verbatim,
                    windowsHide: true,
                });
            } catch (error) {
                this.lastError = '启动失败：' + (error instanceof Error ? error.message : String(error));
                reject(new Error(this.lastError));
                return;
            }
            this.child = child;
            this.lastError = undefined;
            this.startedAt = Date.now();
            this.stderrLines = [];
            this.stdoutBuffer = '';
            this.initResult = undefined;
            this.initializedSent = false;
            this.protocolVersion = '';

            let settled = false;
            child.once('spawn', () => {
                settled = true;
                log('已启动 ' + this.definition.id + '：' + command);
                resolve();
            });
            child.once('error', error => {
                this.lastError = '启动失败：' + (error instanceof Error ? error.message : String(error));
                this.child = undefined;
                if (!settled) {
                    settled = true;
                    reject(new Error(this.lastError));
                }
                this.failPending(new Error(this.lastError));
            });
            child.once('exit', (code, signal) => {
                this.child = undefined;
                this.startedAt = undefined;
                const reason = signal ? '信号 ' + signal : '退出码 ' + code;
                this.lastError = '子进程已结束（' + reason + '）';
                warn(this.definition.id + ' ' + this.lastError);
                this.failPending(new Error(this.lastError));
                if (!settled) {
                    settled = true;
                    reject(new Error(this.lastError));
                }
            });

            child.stdout.setEncoding('utf8');
            child.stdout.on('data', chunk => this.consumeStdout(chunk));
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', chunk => {
                for (const line of String(chunk).split(/\r?\n/)) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    this.stderrLines.push(trimmed.slice(0, 500));
                    if (this.stderrLines.length > STDERR_LINES) this.stderrLines.shift();
                }
            });
            // 子进程 stdin 关闭时写入会抛 EPIPE，这里吞掉以免影响主流程。
            child.stdin.on('error', () => undefined);
        });
    }

    consumeStdout(chunk) {
        this.stdoutBuffer += chunk;
        if (this.stdoutBuffer.length > MAX_LINE_BYTES) {
            this.stdoutBuffer = '';
            this.lastError = '子进程输出超过单行上限，已丢弃缓冲。';
            return;
        }
        let index = this.stdoutBuffer.indexOf('\n');
        while (index >= 0) {
            const line = this.stdoutBuffer.slice(0, index).replace(/\r$/, '');
            this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
            if (line.trim()) this.consumeLine(line);
            index = this.stdoutBuffer.indexOf('\n');
        }
    }

    consumeLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            // 有些服务器会在 stdout 打印调试文本；只记录不报错。
            this.stderrLines.push('[stdout] ' + line.slice(0, 300));
            if (this.stderrLines.length > STDERR_LINES) this.stderrLines.shift();
            return;
        }
        const list = Array.isArray(message) ? message : [message];
        for (const item of list) {
            if (!item || typeof item !== 'object') continue;
            if (item.id === undefined || item.id === null) {
                // 服务器主动通知（日志/进度）：保留最近一条便于排查。
                continue;
            }
            const key = String(item.id);
            const pending = this.pending.get(key);
            if (pending) {
                this.pending.delete(key);
                clearTimeout(pending.timer);
                pending.resolve(item);
                continue;
            }
            // 服务器反向请求（sampling / roots）：桥接层不支持，明确拒绝。
            if (item.method) {
                this.write({
                    error: { code: -32601, message: '梦境创客 stdio 桥不支持服务器发起的请求：' + item.method },
                    id: item.id,
                    jsonrpc: '2.0',
                });
            }
        }
    }

    failPending(error) {
        for (const [key, pending] of this.pending) {
            clearTimeout(pending.timer);
            this.pending.delete(key);
            pending.reject(error);
        }
    }

    write(payload) {
        if (!this.child) throw new Error('子进程未运行。');
        this.child.stdin.write(JSON.stringify(payload) + '\n');
    }

    send(method, params, timeoutMs) {
        const id = this.nextId++;
        const payload = { id, jsonrpc: '2.0', method };
        if (params !== undefined) payload.params = params;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(String(id));
                reject(new Error('MCP 请求超时（' + Math.round(timeoutMs / 1000) + ' 秒）：' + method));
            }, timeoutMs);
            this.pending.set(String(id), { reject, resolve, timer });
            try {
                this.write(payload);
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(String(id));
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    async notify(method, params) {
        const payload = { jsonrpc: '2.0', method };
        if (params !== undefined) payload.params = params;
        this.write(payload);
    }

    /**
     * 处理一条浏览器发来的 JSON-RPC 消息。
     * 返回 undefined 表示这是通知（HTTP 层回 202）。
     */
    async handle(message, timeoutMs) {
        await this.ensureStarted();
        const method = typeof message.method === 'string' ? message.method : '';
        const isRequest = message.id !== undefined && message.id !== null;

        if (method === INIT_METHOD) {
            if (!this.initResult) {
                const startupTimeout = Math.max(timeoutMs, STARTUP_TIMEOUT_MS);
                this.initResult = await this.send(method, message.params, startupTimeout);
                const result = this.initResult.result;
                if (result && typeof result.protocolVersion === 'string') this.protocolVersion = result.protocolVersion;
            }
            // 重连时复用首次握手的 result，避免子进程因重复 initialize 报错。
            return isRequest
                ? { ...this.initResult, id: message.id }
                : undefined;
        }
        if (method === INITIALIZED_NOTIFICATION) {
            // 首次握手后已经发过一次，重复通知对子进程无害但没必要。
            if (!this.initializedSent) {
                this.initializedSent = true;
                await this.notify(INITIALIZED_NOTIFICATION, message.params);
            }
            return undefined;
        }
        if (!isRequest) {
            await this.notify(method, message.params);
            return undefined;
        }
        const response = await this.send(method, message.params, timeoutMs);
        return { ...response, id: message.id };
    }

    async restart() {
        this.stop();
        await this.ensureStarted();
    }

    stop() {
        const child = this.child;
        this.child = undefined;
        this.startedAt = undefined;
        this.initResult = undefined;
        this.initializedSent = false;
        this.failPending(new Error('MCP 子进程已停止。'));
        if (!child) return;
        try {
            child.stdin.end();
            child.kill();
        } catch {
            // 进程可能已退出
        }
    }
}

function jsonRpcError(id, code, message) {
    return { error: { code, message }, id: id === undefined ? null : id, jsonrpc: '2.0' };
}

function attachStdioBridge(router) {
    const servers = new Map();
    let configState = { configPath: '', error: undefined, servers: [] };

    const reload = () => {
        const loaded = loadConfig();
        configState = loaded;
        const ids = new Set(loaded.servers.map(server => server.id));
        for (const [id, instance] of servers) {
            if (ids.has(id)) continue;
            instance.stop();
            servers.delete(id);
        }
        for (const definition of loaded.servers) {
            const existing = servers.get(definition.id);
            if (existing) existing.definition = definition;
            else servers.set(definition.id, new StdioServer(definition));
        }
        if (loaded.error) warn('stdio-mcp.json ' + loaded.error);
        return loaded;
    };

    const findServer = (req, res) => {
        // 配置可能被用户随时编辑，每次请求都重读，代价只有一次 JSON 解析。
        reload();
        const id = req.params.id;
        const instance = servers.get(id);
        if (!instance) {
            res.status(404).json(jsonRpcError(null, -32601, '未找到 stdio MCP 服务器：' + id));
            return undefined;
        }
        return instance;
    };

    router.get('/mcp-stdio/servers', (_req, res) => {
        const loaded = reload();
        res.setHeader('Cache-Control', 'no-store');
        res.json({
            configPath: loaded.configPath,
            error: loaded.error,
            servers: loaded.servers.map(definition => {
                const instance = servers.get(definition.id);
                return {
                    description: definition.description,
                    id: definition.id,
                    name: definition.name,
                    running: instance ? Boolean(instance.child) : false,
                };
            }),
        });
    });

    router.get('/mcp-stdio/:id/status', (req, res) => {
        const instance = findServer(req, res);
        if (!instance) return;
        res.setHeader('Cache-Control', 'no-store');
        res.json(instance.status());
    });

    router.post('/mcp-stdio/:id/restart', async (req, res) => {
        const instance = findServer(req, res);
        if (!instance) return;
        try {
            await instance.restart();
            res.json({ ok: true, status: instance.status() });
        } catch (error) {
            res.status(500).json({ error: error instanceof Error ? error.message : String(error), ok: false });
        }
    });

    router.post('/mcp-stdio/:id', async (req, res) => {
        const instance = findServer(req, res);
        if (!instance) return;
        const body = req.body;
        const messages = Array.isArray(body) ? body : [body];
        const requests = messages.filter(item => item && typeof item === 'object');
        if (requests.length === 0) {
            res.status(400).json(jsonRpcError(null, -32600, '请求体不是有效的 JSON-RPC 消息。'));
            return;
        }
        const timeoutMs = instance.definition.timeoutMs || DEFAULT_TIMEOUT_MS;
        try {
            const responses = [];
            for (const message of requests) {
                const response = await instance.handle(message, timeoutMs);
                if (response !== undefined) responses.push(response);
            }
            res.setHeader('Cache-Control', 'no-store');
            if (responses.length === 0) {
                res.status(202).end();
                return;
            }
            res.json(Array.isArray(body) ? responses : responses[0]);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            instance.lastError = message;
            const failed = requests.filter(item => item.id !== undefined && item.id !== null).map(item =>
                jsonRpcError(item.id, -32603, message),
            );
            if (failed.length === 0) {
                res.status(500).json({ error: message, ok: false });
                return;
            }
            res.setHeader('Cache-Control', 'no-store');
            res.status(200).json(Array.isArray(body) ? failed : failed[0]);
        }
    });

    const loaded = reload();
    log(
        loaded.servers.length > 0
            ? '已挂载 ' + loaded.servers.length + ' 个 stdio MCP 服务器（配置：' + loaded.configPath + '）'
            : '未配置 stdio MCP 服务器；可选创建 ' + loaded.configPath,
    );

    return {
        dispose() {
            for (const instance of servers.values()) instance.stop();
            servers.clear();
        },
        reload,
        statuses() {
            return [...servers.values()].map(instance => instance.status());
        },
    };
}

module.exports = { attachStdioBridge, loadConfig, resolveCommand, resolveSpawn };
