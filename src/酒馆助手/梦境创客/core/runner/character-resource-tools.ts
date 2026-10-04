import { tool } from 'ai';
import { z } from 'zod';
import { encodeWorkspaceSegment, serializeYaml, slugifyFileName } from '../mapping/serde';
import type { RawCharacterResource, TavernBridge, TavernCharacterSummary } from '../tavern/bridge';
import { readRegexScope, readScriptScope } from '../tavern/resource-reader';
import { MemoryWorkspaceRepository } from '../workspace/memory-repository';
import type { WorkspaceFile } from '../workspace/types';
import type { RunnerTool } from './tools';

export type CharacterResourceRunnerToolOptions = {
  approvalMode: () => 'full' | 'manual' | 'yolo';
  onMount?: (name: string) => void;
  onUnmount?: (name: string) => void;
};

const CHARACTER_ROOT = '/characters';

function file(
  path: string,
  content: string,
  resourceId: string,
  mediaType: WorkspaceFile['mediaType'] = 'text/markdown',
): WorkspaceFile {
  return { content, mediaType, path, readonly: true, resourceId };
}

function characterDirectory(name: string): string {
  return `${CHARACTER_ROOT}/${encodeWorkspaceSegment(name)}`;
}

/** 某张角色卡资料在工作区中的只读根目录。 */
export function characterResourceRoot(name: string): string {
  return characterDirectory(name);
}

function greetingName(index: number, content: string): string {
  const firstLine = content.split('\n').find(line => line.trim() !== '') ?? '';
  const slug = slugifyFileName(firstLine.slice(0, 24), 'greeting');
  return `${String(index + 1).padStart(3, '0')}-${slug}.md`;
}

/** 把一张角色卡投影成只读工作区文件；路径形如 `/characters/<角色名>/...`。 */
export function projectCharacterResourceFiles(resource: RawCharacterResource): WorkspaceFile[] {
  const root = characterDirectory(resource.name);
  const id = (suffix: string) => `character-resource:${resource.name}:${suffix}`;
  const files: WorkspaceFile[] = [
    file(
      `${root}/meta.yaml`,
      serializeYaml({
        avatar_id: resource.avatarId,
        creator: resource.creator,
        name: resource.name,
        readonly: true,
        regex_count: resource.regexes.length,
        script_count: resource.scripts.length,
        tags: resource.tags,
        version: resource.version,
      }),
      id('meta'),
      'text/yaml',
    ),
    file(`${root}/definition.md`, resource.description, id('description')),
    file(`${root}/personality.md`, resource.personality, id('personality')),
    file(`${root}/scenario.md`, resource.scenario, id('scenario')),
    file(`${root}/example-dialogue.md`, resource.mesExample, id('mes-example')),
    file(`${root}/creator-notes.md`, resource.creatorNotes, id('creator-notes')),
    file(`${root}/system-prompt.md`, resource.systemPrompt, id('system-prompt')),
    file(
      `${root}/post-history-instructions.md`,
      resource.postHistoryInstructions,
      id('post-history-instructions'),
    ),
  ];

  const greetingIndex: Array<{ file: string; index: number }> = [];
  resource.greetings.forEach((content, index) => {
    const name = greetingName(index, content);
    greetingIndex.push({ file: name, index });
    files.push(file(`${root}/greetings/${name}`, content, id(`greeting:${index}`)));
  });
  files.push(
    file(`${root}/greetings/index.yaml`, serializeYaml({ greetings: greetingIndex }), id('greetings-index'), 'text/yaml'),
  );

  const regexes = readRegexScope(resource.regexes, resource.name);
  for (const regex of regexes.regexes) {
    const name = `${encodeWorkspaceSegment(regex.id)}-${slugifyFileName(regex.name, 'regex')}.yaml`;
    files.push(
      file(
        `${root}/regexes/${name}`,
        serializeYaml({
          destination: regex.destination,
          enabled: regex.enabled,
          find_regex: regex.findRegex,
          id: regex.id,
          macro_substitution: regex.substituteRegex,
          max_depth: regex.maxDepth,
          min_depth: regex.minDepth,
          name: regex.name,
          order: regex.order,
          replace_string: regex.replaceString,
          run_on_edit: regex.runOnEdit,
          source: {
            ai_output: regex.source.aiOutput,
            reasoning: regex.source.reasoning,
            slash_command: regex.source.slashCommand,
            user_input: regex.source.userInput,
            world_info: regex.source.worldInfo,
          },
          trim_strings: regex.trimStrings,
        }),
        regex.resourceId,
        'text/yaml',
      ),
    );
  }

  const scripts = readScriptScope(resource.scripts, resource.name);
  files.push(
    file(
      `${root}/scripts/tree.yaml`,
      serializeYaml({
        trees: scripts.trees.map(tree =>
          tree.type === 'script'
            ? { id: tree.scriptId, type: 'script' }
            : {
                color: tree.color,
                enabled: tree.enabled,
                icon: tree.icon,
                id: tree.id,
                name: tree.name,
                scripts: tree.scriptIds,
                type: 'folder',
              },
        ),
      }),
      id('script-tree'),
      'text/yaml',
    ),
  );
  for (const script of scripts.scripts) {
    const directory = `${root}/scripts/${encodeWorkspaceSegment(script.id)}-${slugifyFileName(script.name, 'script')}`;
    files.push(
      file(
        `${directory}/info.yaml`,
        serializeYaml({
          button: script.button,
          enabled: script.enabled,
          export_with: script.exportWith,
          id: script.id,
          name: script.name,
        }),
        script.resourceId,
        'text/yaml',
      ),
      file(`${directory}/info.md`, script.info, script.resourceId, 'text/markdown'),
      file(`${directory}/script.js`, script.content, script.resourceId, 'text/plain'),
      file(`${directory}/data.yaml`, serializeYaml(script.data), script.resourceId, 'text/yaml'),
    );
  }
  return files;
}

function resolveCharacter(
  characters: TavernCharacterSummary[],
  name: string,
): TavernCharacterSummary {
  const query = name.trim();
  if (!query) throw new Error('角色名不能为空。');
  const matches = characters.filter(item => item.name === query || item.avatarId === query);
  if (matches.length === 0) {
    const loose = characters.filter(item => item.name.includes(query));
    if (loose.length === 1) return loose[0];
    if (loose.length > 1) throw new Error(`角色名不唯一，请使用完整名称或头像id：${loose.map(item => item.name).join('、')}`);
    throw new Error(`角色不存在：${name}`);
  }
  if (matches.length > 1) throw new Error(`角色名不唯一：${name}`);
  return matches[0];
}

export function createCharacterResourceRunnerTools(
  repository: MemoryWorkspaceRepository,
  bridge: TavernBridge,
  options: CharacterResourceRunnerToolOptions,
): RunnerTool[] {
  return [
    {
      definition: tool({
        description:
          '列出酒馆中的全部角色卡（名称与头像id），不依赖当前打开的是哪张卡。可用query按名称或id筛选。用于在读取别的角色卡资源前先定位名称。',
        inputSchema: z.object({
          maxResults: z.number().int().min(1).max(200).optional(),
          query: z.string().optional().describe('名称或头像id包含的普通文本；省略或留空时列出全部'),
        }),
      }),
      execute: async input => {
        const value = input as { maxResults?: number; query?: string };
        const query = value.query?.trim().toLocaleLowerCase() ?? '';
        const mounted = new Set(
          (await repository.list(CHARACTER_ROOT).catch(() => []))
            .filter(entry => entry.kind === 'directory')
            .map(entry => entry.name),
        );
        const matches = bridge
          .listAllCharacters()
          .filter(
            item =>
              !query ||
              item.name.toLocaleLowerCase().includes(query) ||
              item.avatarId.toLocaleLowerCase().includes(query),
          )
          .slice(0, value.maxResults ?? 50)
          .map(item => ({
            avatarId: item.avatarId,
            mounted: mounted.has(encodeWorkspaceSegment(item.name)),
            name: item.name,
          }));
        return { matches, query: value.query ?? '', returned: matches.length };
      },
      name: 'search_characters',
      readonly: true,
    },
    {
      definition: tool({
        description:
          '把指定角色卡（按名称或头像id）以只读方式挂载到 /characters/<角色名>，包含 definition、personality、scenario、greetings、regexes 与 scripts。只读，不会修改对方的卡。挂载后可用 list_path / read_file 读取。',
        inputSchema: z.object({ name: z.string().min(1).describe('角色名称或头像id') }),
      }),
      execute: async input => {
        const name = (input as { name: string }).name;
        const character = resolveCharacter(bridge.listAllCharacters(), name);
        const resource = await bridge.getCharacterResource(character.name);
        const root = characterDirectory(resource.name);
        const files = projectCharacterResourceFiles(resource);
        repository.replaceProjection(root, files);
        options.onMount?.(resource.name);
        return {
          mounted: true,
          name: resource.name,
          path: root,
          readonly: true,
          regexes: resource.regexes.length,
          scripts: resource.scripts.length,
          files: files.length,
        };
      },
      name: 'mount_character_resource',
      readonly: true,
    },
    {
      definition: tool({
        description: '从工作区卸载一张此前挂载的角色卡资料。只移除只读投影，不会修改酒馆中的角色卡。',
        inputSchema: z.object({ name: z.string().min(1).describe('角色名称或头像id') }),
      }),
      execute: async input => {
        const name = (input as { name: string }).name;
        const character = resolveCharacter(bridge.listAllCharacters(), name);
        const root = characterDirectory(character.name);
        repository.replaceProjection(root, []);
        options.onUnmount?.(character.name);
        return { name: character.name, path: root, unmounted: true };
      },
      name: 'unmount_character_resource',
      readonly: true,
    },
  ];
}
