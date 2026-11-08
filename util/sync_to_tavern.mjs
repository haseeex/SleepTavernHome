// ── 梦境创客 · 编译并同步到酒馆服务端插件 ────────────────────────
//
// 用法：
//   node util/sync_to_tavern.mjs            编译 + 同步
//   node util/sync_to_tavern.mjs --nobuild  跳过编译，只同步
//
// 目标目录（酒馆服务端插件）默认 D:\IDE\SillyTavern\plugins\dream-card-agent，
// 可用环境变量 DCA_TAVERN_PLUGIN_DIR 覆盖。

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(repoRoot, 'dist');
const pluginDir =
    process.env.DCA_TAVERN_PLUGIN_DIR || 'D:\\IDE\\SillyTavern\\plugins\\dream-card-agent';
const targetDist = path.join(pluginDir, 'dist');
const skipBuild = process.argv.includes('--nobuild');
const entryRelative = path.join('酒馆助手', '梦境创客', 'index.js');

function runShell(command) {
    return spawnSync(command, { cwd: repoRoot, shell: true, stdio: 'inherit' });
}

function commandExists(command) {
    const result = spawnSync(command + ' --version', { shell: true, stdio: 'ignore' });
    return result.status === 0;
}

function countFiles(directory) {
    let total = 0;
    for (const item of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, item.name);
        if (item.isDirectory()) total += countFiles(full);
        else if (item.isFile()) total += 1;
    }
    return total;
}

console.log('');
console.log('── 梦境创客 → 酒馆插件同步 ──');
console.log(`   仓库 : ${repoRoot}`);
console.log(`   目标 : ${targetDist}`);
console.log('');

if (!skipBuild) {
    const buildCommand = commandExists('pnpm') ? 'pnpm run build' : 'corepack pnpm run build';
    console.log(`[1/4] 编译中（${buildCommand}）...`);
    if (runShell(buildCommand).status !== 0) {
        console.error('\n[失败] 编译未通过，已中止同步。');
        process.exit(1);
    }
} else {
    console.log('[1/4] 跳过编译（--nobuild）');
}

if (!existsSync(distDir)) {
    console.error('[失败] 找不到 dist 目录，请先完整编译一次。');
    process.exit(1);
}

console.log('[2/4] 同步 dist ...');
rmSync(targetDist, { recursive: true, force: true });
mkdirSync(pluginDir, { recursive: true });
cpSync(distDir, targetDist, { recursive: true });

const entry = path.join(targetDist, entryRelative);
if (!existsSync(entry)) {
    console.error(`[失败] 目标缺少 ${entryRelative}，请检查源产物。`);
    process.exit(1);
}

// 插件源码（index.js / stdio-mcp.js / package.json / 配置样例）以仓库 docs 下归档为准。
// stdio-mcp.json 是用户自己的服务器清单，只在缺失时放一份样例，绝不覆盖。
console.log('[3/4] 同步插件源码 ...');
const pluginSourceDir = path.join(repoRoot, 'docs', '梦境创客', '本地调试', 'dream-card-agent');
const pluginFiles = ['index.js', 'stdio-mcp.js', 'package.json'];
for (const name of pluginFiles) {
    const from = path.join(pluginSourceDir, name);
    if (!existsSync(from)) continue;
    cpSync(from, path.join(pluginDir, name));
}

const exampleConfig = path.join(pluginSourceDir, 'stdio-mcp.example.json');
const userConfig = path.join(pluginDir, 'stdio-mcp.json');
if (existsSync(exampleConfig) && !existsSync(userConfig)) {
    cpSync(exampleConfig, userConfig);
    console.log('   已生成 stdio-mcp.json（样例），请按需编辑后重启酒馆');
} else if (existsSync(userConfig)) {
    console.log('   保留现有 stdio-mcp.json');
}

console.log(`[4/4] 完成：已同步 ${countFiles(targetDist)} 个 dist 文件 + ${pluginFiles.length} 个插件文件。`);
console.log('');
console.log('下一步：');
console.log('  1. 重启酒馆（或在设置里重启该服务端插件）以加载新产物');
console.log('  2. 刷新酒馆页面即可生效');
console.log('  3. stdio MCP 服务器在插件目录的 stdio-mcp.json 里配置，改完保存即生效（无需重启）');
console.log('');
