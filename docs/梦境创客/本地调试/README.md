# 梦境创客 · 本地调试入口

这个文件夹提供两个「酒馆助手导入脚本」，用于在**本地开发**时加载你自己构建的梦境创客，
而不是从 CDN 拉取正式发布版。

## 文件夹内容

```
本地调试/
├── README.md                              ← 本说明
├── 酒馆助手脚本-梦境创客-插件版.json        ← 方案 A（推荐）
├── 酒馆助手脚本-梦境创客-本地版.json        ← 方案 B
└── dream-card-agent/                      ← 方案 A 需要的酒馆服务端插件
    ├── package.json                       （目录名与酒馆内保持一致，直接复制即可）
    ├── index.js                           （dist 静态服务 + 路由入口）
    ├── stdio-mcp.js                       （stdio MCP 子进程桥）
    ├── stdio-mcp.example.json             （stdio 服务器配置样例）
    ├── stdio-mcp.test.cjs                 （桥接单元测试）
    └── stdio-bridge.e2e.cjs               （真实 HTTP 端到端验证）
```

## 两个脚本的区别

|  | `酒馆助手脚本-梦境创客-插件版.json` | `酒馆助手脚本-梦境创客-本地版.json` |
|---|---|---|
| 加载地址 | `/api/plugins/dream-card-agent/...`（酒馆同源） | `http://127.0.0.1:5500/...` |
| 需要额外服务器 | ❌ 不需要 | ✅ 需要 `start_http_server.bat` |
| 需要酒馆服务端插件 | ✅ 需要 | ❌ 不需要 |
| 跨设备访问 | ✅ 自动跟随酒馆地址 | ⚠️ 要手动改 IP |
| 适用场景 | 日常开发（**推荐**） | 不想装插件 / 快速临时调试 |

> 两者 `id` 相同（`dream-card-agent`），**只启用其中一个**，不要同时开。

## 共同前置：先构建

在仓库根目录运行：

```bat
sync_to_tavern.bat
```

它会执行 `pnpm run build`，并把 `dist/` 同步到酒馆插件目录。
只想重新拷贝、不重新编译时：

```bat
sync_to_tavern.bat nobuild
```

---

## 方案 A：插件版（推荐）

由酒馆的**服务端插件**托管 `dist`，同源加载，不需要额外进程。

### 一次性准备

1. 把本文件夹里的 `dream-card-agent/` 整个复制到酒馆的 `plugins/` 下，
   得到（**目录名已与酒馆一致，无需改名**）：
   ```
   酒馆根目录/plugins/dream-card-agent/
   ├── package.json
   ├── index.js
   ├── stdio-mcp.js
   └── stdio-mcp.json          ← 首次运行 sync_to_tavern 时自动生成
   ```
2. 确认酒馆 `config.yaml` 已开启服务端插件：
   ```yaml
   enableServerPlugins: true
   ```
3. 在仓库根目录运行 `sync_to_tavern.bat`（编译 + 拷贝 dist）
4. **重启酒馆**（服务端插件只在启动时加载）

### 验证插件是否就绪

已登录酒馆的前提下，浏览器打开：

```
http://127.0.0.1:8000/api/plugins/dream-card-agent/status
```

应返回类似：

```json
{"ok":true,"distDir":"...","source":"插件内置","files":54,"version":"1.0.0"}
```

### 导入脚本

导入 `酒馆助手脚本-梦境创客-插件版.json` 并启用。

### 日常开发循环

```
改代码 → sync_to_tavern.bat → 重启酒馆 → 刷新酒馆页面
```

> 只有服务端插件的**代码**改动才必须重启酒馆；单纯重新构建 `dist` 通常刷新页面即可。
> 若没生效，重启一次最保险。

### 插件的工作方式

- 挂载点：`/api/plugins/dream-card-agent`
- 路由：`GET /status` 健康探测；`/dist/**` 提供静态文件；`/mcp-stdio/**` stdio MCP 桥
- dist 解析优先级：`DCA_DIST_DIR` 环境变量 → 插件自带 `./dist` → 仓库 `dist`
- 显式关闭缓存（`Cache-Control: no-store`），保证构建后刷新即生效
- `.ds` 按 `application/octet-stream`、`.wasm` 按 `application/wasm` 返回

---

## 方案 A 附加：stdio MCP 服务器

浏览器不能启动子进程，所以 `type: "stdio"` 的 MCP 服务器由这个插件托管，
再以同源 HTTP 端点暴露给梦境创客。

### 1. 配置服务器清单

编辑插件目录下的 `stdio-mcp.json`（`sync_to_tavern` 会在缺失时自动放一份样例）：

```json
{
  "servers": {
    "searxng": {
      "description": "自建 AI 隐私检索",
      "command": "npx",
      "args": ["-y", "mcp-searxng"],
      "env": { "SEARXNG_URL": "https://gem12.test:18080" }
    }
  }
}
```

- 可以直接把 VSCode `mcp.json` 里 `type: "stdio"` 的条目粘贴进 `servers`；
  `http` / `sse` 条目会被自动跳过。
- 命令只能来自这个**服务器本地文件** —— 浏览器无法通过接口执行任意命令。
- 配置文件每次请求都会重读，**改完保存即生效，不需要重启酒馆**。

#### ⚠️ 两层超时要一起设

| 层 | 参数 | 建议值 | 说明 |
|---|---|---|---|
| 插件（本文件） | `timeoutMs` | **60000** | 插件等子进程的上限 |
| 浏览器 | 设置 → MCP → 请求超时 | **120** 秒 | 整体上限 |

插件要比浏览器**短**：插件先超时才能返回「哪个方法超时」的详细错误；两边一样会同时超时，
用户只看到一句笼统的「请求超时」。`initialize` 握手另有写死的 180 秒宽限（`npx` 首次要下载包，实测 65 秒）。

#### ⚠️ 服务器自带的内部超时（很容易踩）

**有些 MCP 服务器自己有很短的内部超时**，默认值小到并发就挂。典型例子 `mcp-searxng`：

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `SEARXNG_TIMEOUT_MS` | **10000** | 搜索请求 |
| `FETCH_TIMEOUT_MS` | **10000** | 其他 fetch（如网页正文抓取） |

实测：单条搜索 2–3 秒正常，但**并发 3 条时有 2 条在 10 秒整失败**，报
`🌐 Network Error: This operation was aborted` —— 这个错误是**服务器自己**抛的，
和梦境创客、插件都无关，只看我们的超时设置会完全查不到原因。

修法是在 `env` 里调大：

```json
"env": {
  "SEARXNG_URL": "https://gem12.test:18080",
  "SEARXNG_TIMEOUT_MS": "30000",
  "FETCH_TIMEOUT_MS": "30000"
}
```

调大后同样并发 3 条全部成功（最慢一条 20 秒，说明 10 秒确实不够）。
遇到别的服务器报类似「operation was aborted / timeout」时，先去它的 README 或源码里
找 `*_TIMEOUT_MS` 之类环境变量。

### 2. 在梦境创客里导入

「设置 → MCP → 从插件导入 stdio」一键导入，会自动生成
`/api/plugins/dream-card-agent/mcp-stdio/<id>` 形式的条目。
最后到「Agent 配置 → 工具」打开 **MCP 工具** 开关。

### 3. 桥接端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/mcp-stdio/<id>` | 单条 JSON-RPC → 返回 JSON（通知回 202） |
| GET | `/mcp-stdio/servers` | 可用服务器清单 |
| GET | `/mcp-stdio/<id>/status` | 运行状态（含最近 stderr） |
| POST | `/mcp-stdio/<id>/restart` | 重启子进程 |

`initialize` 的握手结果会被缓存，浏览器刷新重连时复用，子进程不会被重复握手打断。
服务器主动发起的请求（sampling / roots）桥接层不支持，会回 `-32601`。

### 4. 验证

```bat
node --test "docs/梦境创客/本地调试/dream-card-agent/stdio-mcp.test.cjs"
node "docs/梦境创客/本地调试/dream-card-agent/stdio-bridge.e2e.cjs"
```

后者会用酒馆自带的 express 起一个临时服务，走真实 HTTP 验证完整链路（需已部署插件）。

或浏览器打开 `http://127.0.0.1:8000/api/plugins/dream-card-agent/mcp-stdio/servers`。

---

## 方案 B：本地版（5500 端口）

用一个临时 HTTP 服务提供 `dist`。

### 一次性准备

在仓库根目录双击 `start_http_server.bat`
（等价于 `npx http-server . -p 5500 --cors -c-1`）：

- `--cors` 是必需的，否则酒馆跨域 import 会被浏览器拦截
- 这个窗口要保持开着

### 导入脚本

导入 `酒馆助手脚本-梦境创客-本地版.json` 并启用。

### 日常开发循环

```
改代码 → pnpm run build → 刷新酒馆页面
```

（脚本 URL 带 `?t=Date.now()`，会自动破缓存）

### 换端口 / 跨设备

编辑脚本内容里的 `baseUrl`：

```js
const baseUrl = 'http://127.0.0.1:5500';   // 改成局域网 IP，如 http://10.0.1.104:5500
```

---

## 为什么不能直接内嵌进 JSON（零服务器）

梦境创客是原生 ES 模块，代码里会用**自身 URL** 推导资源目录：

```ts
configureDreamCardAgentResourceBase(new URL('./resources/', import.meta.url).href);
```

实测结果：

| 加载方式 | `new URL('./resources/', ...)` |
|---|---|
| `http://.../index.js` | ✅ 正常 |
| `file:///.../index.js` | ✅ 正常 |
| `data:text/javascript,...` | ❌ 抛 Invalid URL |
| `blob:http://...` | ❌ 抛 Invalid URL |

所以纯内嵌（data URL）走不通 —— 资源目录推导失败，HTML 工程编译、Skill 下载都会挂。
**必须有一个能提供 `dist` 的 HTTP 端点。**

---

## 常见问题

**Q：导入后没反应 / 控制台报 404**
- 插件版：确认酒馆已重启、`/status` 能打开、且已运行过 `sync_to_tavern.bat`
- 本地版：确认 `start_http_server.bat` 窗口还开着、5500 没被占用

**Q：提示「本地产物不是可用的梦境创客模块」**
- 取到的不是梦境创客的 `index.js`，多半是路径错了或文件不存在

**Q：改了代码刷新没变化**
- 插件版：先 `sync_to_tavern.bat`，再刷新；仍无效就重启酒馆
- 本地版：确认已执行 `pnpm run build`

**Q：想彻底移除**
- 插件版：删掉酒馆 `plugins/dream-card-agent/` 整个目录，重启酒馆
- 本地版：关掉 `start_http_server` 窗口即可

---

## 相关文件位置

| 文件 | 位置 |
|---|---|
| 同步脚本 | 仓库根目录 `sync_to_tavern.bat`、`util/sync_to_tavern.mjs` |
| 本地服务脚本 | 仓库根目录 `start_http_server.bat` |
| 酒馆服务端插件源码 | 本文件夹 `dream-card-agent/`（整个复制到酒馆 `plugins/`） |
| 构建产物 | 仓库 `dist/`，同步到插件目录 `dist/` |
