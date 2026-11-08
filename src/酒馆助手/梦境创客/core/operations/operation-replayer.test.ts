import { describe, expect, it } from 'vitest';
import { LiveWorkspaceRepository, type LiveWorkspaceApplyInput, type LiveWorkspaceSource } from '../workspace/live-repository';
import { MemoryWorkspaceRepository } from '../workspace/memory-repository';
import type { WorkspaceFile } from '../workspace/types';
import { createWorkspaceOperationRecord } from './file-operation';
import { executeOperationReplay, planOperationReplay } from './operation-replayer';

function file(content: string, path = '/character/description.md'): WorkspaceFile {
  return { content, mediaType: 'text/markdown', path, readonly: false, resourceId: path };
}

class Source implements LiveWorkspaceSource {
  constructor(public files: WorkspaceFile[]) {}
  async load() { return structuredClone(this.files); }
  async apply(input: LiveWorkspaceApplyInput) {
    const repository = new MemoryWorkspaceRepository({ files: this.files });
    for (const [index, change] of input.changes.entries()) {
      const id = `${input.toolCallId}:${index}`;
      if (change.kind === 'create') await repository.stageFiles([change.after], id);
      else if (change.kind === 'delete') await repository.remove(change.path, id);
      else if (change.kind === 'move') await repository.move(change.from, change.path, id);
      else await repository.write(change.path, change.after.content, id, { overwrite: true });
    }
    this.files = repository.snapshot();
    return { changes: repository.changes(), files: structuredClone(this.files), status: 'success' as const };
  }
}

describe('operation replayer', () => {
  it('按逆序Undo并可顺序Redo标准补丁', async () => {
    const source = new Source([file('第二版\n')]);
    const repository = new LiveWorkspaceRepository({ source });
    await repository.initialize();
    const record = await createWorkspaceOperationRecord({
      actor: 'agent', approvalMode: 'manual',
      change: { before: file('第一版\n'), after: file('第二版\n'), kind: 'modify', path: '/character/description.md' },
      operationId: 'op', toolCallId: 'tool', turnId: 'turn',
    });
    expect((await planOperationReplay(repository, [record], 'undo')).conflicts).toEqual([]);
    expect(await executeOperationReplay({ direction: 'undo', records: [record], repository })).toMatchObject({
      appliedOperationIds: ['op'], failed: [],
    });
    expect((await repository.read('/character/description.md')).content).toBe('第一版\n');
    await executeOperationReplay({ direction: 'redo', records: [record], repository });
    expect((await repository.read('/character/description.md')).content).toBe('第二版\n');
  });

  it('模拟阶段识别外部修改，跳过冲突仍可处理其他操作', async () => {
    const source = new Source([file('外部编辑\n')]);
    const repository = new LiveWorkspaceRepository({ source });
    await repository.initialize();
    const record = await createWorkspaceOperationRecord({
      actor: 'agent', approvalMode: 'manual',
      change: { before: file('旧\n'), after: file('新\n'), kind: 'modify', path: '/character/description.md' },
      operationId: 'op', toolCallId: 'tool', turnId: 'turn',
    });
    expect((await planOperationReplay(repository, [record], 'undo')).conflicts).toMatchObject([
      { operationId: 'op', reason: '文件在原操作之后又发生了变化。' },
    ]);
    expect(await executeOperationReplay({ direction: 'undo', records: [record], repository, skipOperationIds: ['op'] }))
      .toEqual({ appliedOperationIds: [], failed: [] });
  });

  it('同一文件在一轮内被多次修改时不误报冲突', async () => {
    // 磁盘上只有最后一次修改后的内容。旧实现逐条拿磁盘当前内容比对，
    // 导致前两条被误判成「文件在原操作之后又发生了变化」，弹窗满屏冲突。
    const source = new Source([file('第三版\n')]);
    const repository = new LiveWorkspaceRepository({ source });
    await repository.initialize();
    const path = '/character/description.md';
    const first = await createWorkspaceOperationRecord({
      actor: 'agent', approvalMode: 'manual',
      change: { before: file('第一版\n'), after: file('第二版\n'), kind: 'modify', path },
      operationId: 'op-1', toolCallId: 'tool-1', turnId: 'turn',
    });
    const second = await createWorkspaceOperationRecord({
      actor: 'agent', approvalMode: 'manual',
      change: { before: file('第二版\n'), after: file('第三版\n'), kind: 'modify', path },
      operationId: 'op-2', toolCallId: 'tool-2', turnId: 'turn',
    });
    expect((await planOperationReplay(repository, [first, second], 'undo')).conflicts).toEqual([]);
    const undone = await executeOperationReplay({ direction: 'undo', records: [first, second], repository });
    expect(undone.failed).toEqual([]);
    expect(undone.appliedOperationIds).toEqual(['op-2', 'op-1']);
    expect((await repository.read(path)).content).toBe('第一版\n');
  });

  it('同一轮内先创建再修改，回退时能正确删除', async () => {
    const source = new Source([file('创建后改过\n', '/character/new.md')]);
    const repository = new LiveWorkspaceRepository({ source });
    await repository.initialize();
    const path = '/character/new.md';
    const created = await createWorkspaceOperationRecord({
      actor: 'agent', approvalMode: 'manual',
      change: { after: file('初版\n', path), kind: 'create', path },
      operationId: 'op-create', toolCallId: 'tool-1', turnId: 'turn',
    });
    const edited = await createWorkspaceOperationRecord({
      actor: 'agent', approvalMode: 'manual',
      change: { before: file('初版\n', path), after: file('创建后改过\n', path), kind: 'modify', path },
      operationId: 'op-edit', toolCallId: 'tool-2', turnId: 'turn',
    });
    expect((await planOperationReplay(repository, [created, edited], 'undo')).conflicts).toEqual([]);
    await executeOperationReplay({ direction: 'undo', records: [created, edited], repository });
    await expect(repository.read(path)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
