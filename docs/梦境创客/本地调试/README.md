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
    └── index.js
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
   └── index.js
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
- 路由：`GET /status` 健康探测；`/dist/**` 提供静态文件
- dist 解析优先级：`DCA_DIST_DIR` 环境变量 → 插件自带 `./dist` → 仓库 `dist`
- 显式关闭缓存（`Cache-Control: no-store`），保证构建后刷新即生效
- `.ds` 按 `application/octet-stream`、`.wasm` 按 `application/wasm` 返回

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