<template>
  <section class="dca-section-stack dca-mcp-settings">
    <header class="dca-section-header">
      <div>
        <h3>MCP 工具</h3>
        <p>
          连接外部 MCP 服务器，把它们的工具交给 Agent 调用。HTTP / SSE 可直连；stdio 服务器由酒馆服务端插件
          <code>dream-card-agent</code> 托管子进程，这里只选它提供的条目。
        </p>
      </div>
      <div class="dca-row-actions">
        <button type="button" :disabled="state.busy" @click="importStdio">
          <i class="fa-solid fa-download" aria-hidden="true"></i> 从插件导入 stdio
        </button>
        <button type="button" :disabled="state.busy || state.mcpServers.length === 0" @click="refreshAll">
          <i class="fa-solid fa-rotate" aria-hidden="true"></i> 刷新全部
        </button>
        <button type="button" @click="newServer">
          <i class="fa-solid fa-plus" aria-hidden="true"></i> 新建服务器
        </button>
      </div>
    </header>

    <div class="dca-provider-layout">
      <aside class="dca-provider-list">
        <header>
          <strong>MCP 服务器</strong><small>{{ state.mcpServers.length }}</small>
        </header>
        <button
          v-for="server in state.mcpServers"
          :key="server.id"
          class="dca-provider-item"
          :class="{ active: draft.id === server.id, disabled: !server.enabled }"
          type="button"
          @click="selectServer(server.id)"
        >
          <span class="dca-provider-select">
            <i class="fa-solid fa-network-wired" aria-hidden="true"></i>
            <span>
              <strong>{{ server.name }}</strong>
              <small>{{ statusLabel(statusOf(server.id)) }}</small>
            </span>
            <i v-if="!server.enabled" class="fa-solid fa-ban" title="已停用" aria-label="已停用"></i>
          </span>
        </button>
        <div v-if="state.mcpServers.length === 0" class="dca-empty">还没有配置 MCP 服务器。</div>
      </aside>

      <main class="dca-provider-main">
        <div class="dca-resource-toolbar dca-api-provider-toolbar">
          <div>
            <strong>{{ draft.id ? draft.name || '未命名服务器' : '新建服务器' }}</strong>
            <small>{{ draft.id ? statusLabel(statusOf(draft.id)) : '保存后会立即连接并读取工具列表' }}</small>
          </div>
          <div class="dca-row-actions">
            <button v-if="draft.id" type="button" :disabled="state.busy" @click="refreshCurrent">
              <i class="fa-solid fa-rotate" aria-hidden="true"></i> 刷新工具
            </button>
            <button
              v-if="draft.id"
              class="dca-btn-danger"
              type="button"
              :disabled="state.busy"
              @click="removeCurrent"
            >
              删除
            </button>
            <button class="dca-btn-primary" type="button" :disabled="state.busy" @click="save">
              保存服务器
            </button>
          </div>
        </div>

        <section class="dca-provider-card">
          <div class="dca-form-grid">
            <label class="dca-field">
              <span>名称</span>
              <input v-model="draft.name" type="text" maxlength="60" placeholder="例如：本地文件服务器" />
            </label>
            <label class="dca-field">
              <span>传输方式</span>
              <DcaSelect
                aria-label="MCP 传输方式"
                :model-value="draft.transport"
                :options="transportOptions"
                @update:model-value="setTransport"
              />
            </label>
            <label class="dca-field wide">
              <span>{{ draft.transport === 'stdio' ? '桥接端点' : '服务器地址' }}</span>
              <input v-model="draft.url" type="text" :placeholder="urlPlaceholder" />
              <small v-if="draft.transport === 'stdio'">
                指向酒馆服务端插件的 <code>/api/plugins/dream-card-agent/mcp-stdio/&lt;id&gt;</code>；
                用“从插件导入 stdio”会自动填好。命令与 env 只能在服务器的 stdio-mcp.json 里配。
              </small>
              <small v-else>必须允许跨域访问（CORS）；浏览器无法启动本地进程。</small>
            </label>
            <label class="dca-field">
              <span>请求超时（秒）</span>
              <input v-model.number="draft.timeoutSeconds" type="number" min="5" max="600" step="5" />
              <small>
                <template v-if="draft.transport === 'stdio'">
                  首次握手额外放宽到 180 秒（npx 类服务器要先下载包，实测可能 60 秒以上）。
                </template>
                <template v-else>单次 JSON-RPC 请求的最长等待时间。</template>
              </small>
            </label>
            <label class="dca-field dca-mcp-enabled">
              <input v-model="draft.enabled" type="checkbox" /><span>启用服务器</span>
            </label>
            <label class="dca-field wide">
              <span>请求标头</span>
              <textarea
                v-model="draft.headers"
                rows="4"
                spellcheck="false"
                placeholder="Authorization: Bearer <token>"
              ></textarea>
              <small>每行一个 <code>名称: 值</code>；用于鉴权或自定义路由。</small>
            </label>
            <div v-if="draft.transport === 'stdio'" class="dca-field wide dca-mcp-basic">
              <span>酒馆登录（Basic 认证快捷填入）</span>
              <div class="dca-mcp-basic-row">
                <input v-model="basicUser" type="text" autocomplete="off" placeholder="用户名" />
                <input v-model="basicPassword" type="password" autocomplete="off" placeholder="密码" />
                <button type="button" :disabled="!basicUser || !basicPassword" @click="applyBasicAuth">
                  填入 Authorization
                </button>
              </div>
              <small>
                酒馆开启了 <code>basicAuthMode</code> 时，<strong>建议务必填入</strong>：浏览器一旦在登录弹框里
                输错过一次，会把错误凭据缓存下来，之后每次请求都用它覆盖手动头 —— 表现就是「密码明明对了还一直弹框」，
                最后撞上限流（5 次锁 60 秒）。填入后请求改走 <code>credentials: omit</code>，手动凭据才真正生效。
              </small>
            </div>
          </div>
        </section>

        <section class="dca-mcp-tools">
          <header>
            <div>
              <strong>可用工具</strong>
              <small>工具名会以 mcp__{{ serverSegment }}__ 前缀暴露给 Agent。</small>
            </div>
            <span>{{ currentStatus?.toolCount ?? 0 }} 个</span>
          </header>
          <p v-if="currentStatus?.error" class="dca-mcp-error">
            <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>{{ currentStatus.error }}
          </p>
          <ul v-else-if="currentStatus && currentStatus.tools.length > 0">
            <li v-for="tool in currentStatus.tools" :key="tool.name">
              <strong>{{ tool.title || tool.name }}</strong>
              <code>{{ tool.name }}</code>
              <span>{{ tool.readOnly ? '只读' : '可能修改数据' }}</span>
              <small v-if="tool.description">{{ tool.description }}</small>
            </li>
          </ul>
          <div v-else class="dca-empty">
            还没有读取到工具。保存或点击“刷新工具”后重试；连接失败时会在上方显示原因。
          </div>
        </section>

        <p class="dca-mcp-hint">
          <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
          启用后还需在“Agent配置 → 工具”里打开“MCP 工具”，会话才会获得这些工具。
        </p>
      </main>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { mcpServerSegment } from '../../../core/mcp/config';
import type { McpServerStatus, McpTransport } from '../../../core/mcp/types';
import { useDreamCardAgent } from '../../composables/runtime';
import DcaSelect from '../DcaSelect.vue';

type ServerDraft = {
  enabled: boolean;
  headers: string;
  id?: string;
  name: string;
  timeoutSeconds: number;
  transport: McpTransport;
  url: string;
};

const transportOptions = [
  { label: 'Streamable HTTP', value: 'http' },
  { label: 'HTTP + SSE（旧版）', value: 'sse' },
  { label: 'stdio（经酒馆服务端插件）', value: 'stdio' },
];

const { action, runtime, state } = useDreamCardAgent();
const draft = ref<ServerDraft>(emptyDraft());

function emptyDraft(): ServerDraft {
  return { enabled: true, headers: '', name: '', timeoutSeconds: 60, transport: 'http', url: '' };
}

const currentStatus = computed(() =>
  draft.value.id ? statusOf(draft.value.id) : undefined,
);
const serverSegment = computed(() => (draft.value.id ? mcpServerSegment(draft.value.id) : '服务器'));

watch(
  () => state.value.mcpServers,
  servers => {
    if (!draft.value.id) return;
    const matched = servers.find(server => server.id === draft.value.id);
    if (!matched) draft.value = emptyDraft();
  },
);

function statusOf(id: string): McpServerStatus | undefined {
  return (state.value.mcpStatuses ?? []).find(item => item.id === id);
}

function statusLabel(status: McpServerStatus | undefined): string {
  if (!status) return '未连接';
  if (status.state === 'connecting') return '连接中…';
  if (status.state === 'error') return '连接失败';
  if (status.state === 'ready') return `${status.toolCount} 个工具`;
  return '未连接';
}

function selectServer(id: string) {
  const server = state.value.mcpServers.find(item => item.id === id);
  if (!server) return;
  draft.value = {
    enabled: server.enabled,
    headers: server.headers.map(header => `${header.name}: ${header.value}`).join('\n'),
    id: server.id,
    name: server.name,
    timeoutSeconds: Math.round(server.timeoutMs / 1000),
    transport: server.transport,
    url: server.url,
  };
}

function newServer() {
  draft.value = emptyDraft();
}

const urlPlaceholder = computed(() =>
  draft.value.transport === 'stdio'
    ? '/api/plugins/dream-card-agent/mcp-stdio/searxng'
    : 'http://127.0.0.1:3000/mcp',
);

function setTransport(value: string) {
  draft.value.transport = value === 'sse' ? 'sse' : value === 'stdio' ? 'stdio' : 'http';
}

async function importStdio() {
  const before = state.value.mcpServers.length;
  const ok = await action(() => runtime.importStdioMcpServers());
  if (!ok) return;
  const added = state.value.mcpServers.length - before;
  if (added > 0) toastr.success(`已从服务端插件导入 ${added} 个 stdio MCP 服务器。`, '梦境创客');
  else toastr.info('没有新增服务器（已导入过的会跳过）。', '梦境创客');
}

function parseHeaders(text: string): Array<{ name: string; value: string }> {
  return text.split(/\r?\n/u).flatMap(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return [];
    const index = trimmed.indexOf(':');
    if (index <= 0) return [];
    return [{ name: trimmed.slice(0, index).trim(), value: trimmed.slice(index + 1).trim() }];
  });
}

async function save() {
  const url = draft.value.url.trim();
  if (!url) {
    toastr.warning('请填写 MCP 服务器地址。', '梦境创客');
    return;
  }
  const ok = await action(() =>
    runtime.saveMcpServer({
      enabled: draft.value.enabled,
      headers: parseHeaders(draft.value.headers),
      id: draft.value.id,
      name: draft.value.name.trim() || undefined,
      timeoutMs: Math.round(draft.value.timeoutSeconds) * 1000,
      transport: draft.value.transport,
      url,
    }),
  );
  if (!ok) return;
  // 新建时服务器追加在末尾；更新时沿用原 id。
  const saved =
    state.value.mcpServers.find(server => server.id === draft.value.id) ?? state.value.mcpServers.at(-1);
  if (saved) selectServer(saved.id);
}

async function refreshCurrent() {
  if (!draft.value.id) return;
  const id = draft.value.id;
  await action(() => runtime.refreshMcpServer(id));
}

async function refreshAll() {
  await action(() => runtime.refreshMcpServer());
}

async function removeCurrent() {
  if (!draft.value.id) return;
  const id = draft.value.id;
  if (!window.confirm(`删除 MCP 服务器“${draft.value.name || id}”？`)) return;
  const ok = await action(() => runtime.removeMcpServer(id));
  if (ok) draft.value = emptyDraft();
}

const basicUser = ref('');
const basicPassword = ref('');

/** btoa 只接受 Latin-1，中文用户名要先按 UTF-8 编码。 */
function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function applyBasicAuth() {
  const value = `Basic ${base64Utf8(`${basicUser.value}:${basicPassword.value}`)}`;
  const lines = draft.value.headers
    .split(/\r?\n/u)
    .filter(line => !/^\s*authorization\s*:/iu.test(line));
  lines.push(`Authorization: ${value}`);
  draft.value.headers = lines.filter(line => line.trim()).join('\n');
  basicUser.value = '';
  basicPassword.value = '';
  toastr.info('已写入 Authorization 标头，记得点“保存服务器”。', '梦境创客');
}
</script>

<style lang="scss">
.dca-mcp-settings .dca-provider-item {
  grid-template-columns: minmax(0, 1fr);
}

.dca-mcp-settings .dca-mcp-enabled {
  align-self: end;
  flex-direction: row;
  align-items: center;
  gap: 0.4rem;
}

.dca-mcp-basic-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 0.4rem;
}

.dca-mcp-basic-row input {
  min-width: 0;
}

@media (max-width: 620px) {
  .dca-mcp-basic-row {
    grid-template-columns: minmax(0, 1fr);
  }
}

.dca-mcp-tools {
  margin-top: 0.8rem;
  border: 1px solid var(--dca-border);
  border-radius: 0.6rem;
  background: var(--dca-surface);

  > header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    padding: 0.7rem 0.8rem;
    border-bottom: 1px solid var(--dca-border);

    strong {
      display: block;
    }

    small {
      color: var(--dca-text-muted);
    }
  }

  ul {
    margin: 0;
    padding: 0.4rem 0.8rem 0.7rem;
    list-style: none;
  }

  li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.45rem;
    padding: 0.45rem 0;
    border-bottom: 1px dashed var(--dca-border);

    &:last-child {
      border-bottom: 0;
    }

    code {
      color: var(--dca-text-muted);
      font-size: 0.78rem;
    }

    span {
      font-size: 0.75rem;
      color: var(--dca-text-secondary);
    }

    small {
      flex-basis: 100%;
      color: var(--dca-text-muted);
      font-size: 0.78rem;
    }
  }
}

.dca-mcp-error {
  display: flex;
  gap: 0.45rem;
  margin: 0;
  padding: 0.7rem 0.8rem;
  color: var(--dca-danger, #d9534f);
  font-size: 0.85rem;
}

.dca-mcp-hint {
  display: flex;
  gap: 0.45rem;
  margin: 0.7rem 0 0;
  color: var(--dca-text-muted);
  font-size: 0.8rem;
}
</style>
