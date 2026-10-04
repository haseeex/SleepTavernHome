import { describe, expect, it } from 'vitest';
import type { RawCharacterData } from '../tavern/bridge';
import { FakeTavernBridge } from '../tavern/test-bridge';
import { MemoryWorkspaceRepository } from '../workspace/memory-repository';
import { characterResourceRoot, createCharacterResourceRunnerTools, projectCharacterResourceFiles } from './character-resource-tools';

function referenceCharacter(): RawCharacterData {
  return {
    avatar: 'trails.png',
    data: {
      character_version: '2.1.0',
      creator: '轨迹作者',
      description: '参考卡描述',
      extensions: {
        regex_scripts: [
          {
            disabled: false,
            findRegex: '/<StatusBar>/g',
            id: 'regex-trails',
            markdownOnly: true,
            placement: [2],
            replaceString: '<div>$1</div>',
            scriptName: '状态栏折叠',
          },
        ],
        tavern_helper: {
          scripts: [
            {
              button: { buttons: [], enabled: false },
              content: "import 'https://cdn.example.com/mvu.js'",
              data: {},
              enabled: true,
              export_with: { button: false, data: false },
              id: 'script-trails-mvu',
              info: 'MVU 运行时',
              name: 'MVU 运行时',
              type: 'script',
            },
          ],
        },
      },
      first_mes: '开场白',
      name: '英雄传说轨迹系列',
      personality: '冷静',
      scenario: '轨迹世界',
      tags: ['轨迹'],
    },
    name: '英雄传说轨迹系列',
    tags: ['轨迹'],
  };
}

function fixture() {
  const bridge = new FakeTavernBridge();
  bridge.characters.push(referenceCharacter());
  const repository = new MemoryWorkspaceRepository({ files: [], readonlyRoots: ['/characters'] });
  const tools = new Map(
    createCharacterResourceRunnerTools(repository, bridge, { approvalMode: () => 'yolo' }).map(item => [
      item.name,
      item,
    ]),
  );
  return { bridge, repository, tools };
}

describe('角色资料只读工具', () => {
  it('列出全部角色卡而不依赖当前打开的角色', async () => {
    const { tools } = fixture();
    const result = (await tools.get('search_characters')!.execute({}, 'list')) as {
      matches: Array<{ name: string }>;
    };
    expect(result.matches.map(item => item.name)).toEqual(
      expect.arrayContaining(['角色', '英雄传说轨迹系列']),
    );
  });

  it('按名称把别的角色卡挂载为只读工作区文件', async () => {
    const { repository, tools } = fixture();
    const result = (await tools.get('mount_character_resource')!.execute(
      { name: '英雄传说轨迹系列' },
      'mount',
    )) as { path: string; regexes: number; scripts: number };
    expect(result).toMatchObject({ path: characterResourceRoot('英雄传说轨迹系列'), readonly: true, regexes: 1, scripts: 1 });

    const entries = await repository.list(result.path);
    expect(entries.map(entry => entry.name)).toEqual(
      expect.arrayContaining(['meta.yaml', 'definition.md', 'greetings', 'regexes', 'scripts']),
    );
    const scriptDirs = await repository.list(`${result.path}/scripts`);
    const scriptDir = scriptDirs.find(entry => entry.kind === 'directory')!;
    expect((await repository.read(`${scriptDir.path}/script.js`)).content).toBe(
      "import 'https://cdn.example.com/mvu.js'",
    );
    const regexFiles = await repository.list(`${result.path}/regexes`);
    expect((await repository.read(regexFiles[0].path)).content).toContain('状态栏折叠');
  });

  it('挂载的角色资料是只读的', async () => {
    const { repository, tools } = fixture();
    const result = (await tools.get('mount_character_resource')!.execute(
      { name: '英雄传说轨迹系列' },
      'mount',
    )) as { path: string };
    expect((await repository.read(`${result.path}/definition.md`)).readonly).toBe(true);
    await expect(repository.write(`${result.path}/definition.md`, 'x', 'write')).rejects.toMatchObject({
      code: 'READ_ONLY_PATH',
    });
  });

  it('卸载只移除投影', async () => {
    const { repository, tools } = fixture();
    await tools.get('mount_character_resource')!.execute({ name: '英雄传说轨迹系列' }, 'mount');
    await tools.get('unmount_character_resource')!.execute({ name: '英雄传说轨迹系列' }, 'unmount');
    await expect(repository.list(characterResourceRoot('英雄传说轨迹系列'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('按头像 id 也能定位角色卡', async () => {
    const { tools } = fixture();
    const result = (await tools.get('mount_character_resource')!.execute({ name: 'trails.png' }, 'mount')) as {
      name: string;
    };
    expect(result.name).toBe('英雄传说轨迹系列');
  });

  it('投影包含脚本与正则资源', () => {
    const files = projectCharacterResourceFiles({
      avatarId: 'a.png',
      creator: '',
      creatorNotes: '',
      description: '',
      greetings: ['g1'],
      mesExample: '',
      name: '卡',
      personality: '',
      postHistoryInstructions: '',
      regexes: [],
      scenario: '',
      scripts: [],
      systemPrompt: '',
      tags: [],
      version: '',
    });
    expect(files.every(file => file.readonly)).toBe(true);
    expect(files.map(file => file.path)).toEqual(expect.arrayContaining([`${characterResourceRoot('卡')}/meta.yaml`]));
  });
});
