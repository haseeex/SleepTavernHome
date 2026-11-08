import { sha256 } from '../transaction/canonical';
import type { LiveWorkspaceRepository } from '../workspace/live-repository';
import type { WorkspaceFile } from '../workspace/types';
import type { FileOperationPayload, WorkspaceOperationRecord } from './types';

export type OperationReplayDirection = 'redo' | 'undo';

export type OperationReplayConflict = {
  actual?: { path: string; sha256: string };
  expected: 'absent' | { path: string; sha256: string };
  operationId: string;
  path: string;
  reason: string;
  /**
   * 软冲突：文件只是“漂移”了（刷新后重新投影、外部重写、已不存在）。
   * 这种可以直接强制覆盖恢复，不应该拦住用户回退；
   * 缺可靠恢复记录（undoable=false / uncertain）才是硬冲突，必须由用户确认。
   */
  soft?: boolean;
};

export type OperationReplayPlan = {
  conflicts: OperationReplayConflict[];
  direction: OperationReplayDirection;
  operationIds: string[];
};

async function fileHash(file: WorkspaceFile): Promise<string> {
  return sha256(new TextEncoder().encode(file.content));
}

async function tryRead(repository: LiveWorkspaceRepository, path: string): Promise<WorkspaceFile | undefined> {
  try {
    return await repository.read(path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'NOT_FOUND') return undefined;
    throw error;
  }
}

function payloadFor(record: WorkspaceOperationRecord, direction: OperationReplayDirection): FileOperationPayload {
  return direction === 'undo' ? record.inverse : record.forward;
}

/** 预检用的虚拟文件状态：null 表示该路径在该时刻不存在。 */
type VirtualState = Map<string, WorkspaceFile | null>;

function virtualReader(repository: LiveWorkspaceRepository, state: VirtualState) {
  return async (path: string): Promise<WorkspaceFile | undefined> => {
    if (state.has(path)) return state.get(path) ?? undefined;
    const file = await tryRead(repository, path);
    state.set(path, file ?? null);
    return file;
  };
}

/** 把一条已通过预检的操作应用到虚拟状态上，让后续操作看到回退/重做过程中的中间状态。 */
function applyToVirtualState(state: VirtualState, payload: FileOperationPayload): void {
  if (payload.kind === 'create') state.set(payload.path, payload.file);
  else if (payload.kind === 'delete') state.set(payload.path, null);
  else if (payload.kind === 'modify') state.set(payload.path, payload.after);
  else {
    state.set(payload.from, null);
    state.set(payload.path, payload.after);
  }
}

async function inspectPayload(
  read: (path: string) => Promise<WorkspaceFile | undefined>,
  record: WorkspaceOperationRecord,
  payload: FileOperationPayload,
): Promise<OperationReplayConflict | undefined> {
  const sourcePath = payload.kind === 'move' ? payload.from : payload.path;
  const current = await read(sourcePath);
  if (payload.kind === 'create') {
    if (!current) return undefined;
    return {
      actual: { path: sourcePath, sha256: await fileHash(current) },
      expected: 'absent',
      operationId: record.operationId,
      path: sourcePath,
      reason: '目标路径已经存在，不能安全恢复被删除或移动的文件。',
      soft: true,
    };
  }
  if (!current) {
    return {
      expected: { path: sourcePath, sha256: await fileHash(payload.kind === 'delete' ? payload.file : payload.before) },
      operationId: record.operationId,
      path: sourcePath,
      reason: '预期文件已经不存在。',
      soft: true,
    };
  }
  const expectedFile = payload.kind === 'delete' ? payload.file : payload.before;
  const [actualHash, expectedHash] = await Promise.all([fileHash(current), fileHash(expectedFile)]);
  if (actualHash !== expectedHash) {
    return {
      actual: { path: sourcePath, sha256: actualHash },
      expected: { path: sourcePath, sha256: expectedHash },
      operationId: record.operationId,
      path: sourcePath,
      reason: '文件在原操作之后又发生了变化。',
      soft: true,
    };
  }
  if (payload.kind === 'move') {
    const target = await read(payload.path);
    if (target) {
      return {
        actual: { path: payload.path, sha256: await fileHash(target) },
        expected: 'absent',
        operationId: record.operationId,
        path: payload.path,
        reason: '移动目标已经存在。',
        soft: true,
      };
    }
  }
  return undefined;
}

/**
 * 逐条预演整轮回退/重做。
 *
 * ⚠️ 必须按顺序在**虚拟状态**上滚动检查：同一文件在一轮内被改过多次时，
 * 后一个操作回退后的内容才是前一个操作期望的输入。若每条都拿磁盘当前内容比对，
 * 除最后一条外全部会被误判成「文件在原操作之后又发生了变化」，
 * 用户就会看到一个满屏冲突、点哪个都回退不了的弹窗。
 */
export async function planOperationReplay(
  repository: LiveWorkspaceRepository,
  records: WorkspaceOperationRecord[],
  direction: OperationReplayDirection,
): Promise<OperationReplayPlan> {
  const ordered = direction === 'undo' ? [...records].reverse() : [...records];
  const conflicts: OperationReplayConflict[] = [];
  const state: VirtualState = new Map();
  const read = virtualReader(repository, state);
  for (const record of ordered) {
    if (!record.undoable || record.state === 'uncertain') {
      conflicts.push({
        expected: 'absent',
        operationId: record.operationId,
        path: record.forward.path,
        reason: record.warning || '该操作没有可靠的恢复记录。',
      });
      continue;
    }
    const payload = payloadFor(record, direction);
    const conflict = await inspectPayload(read, record, payload);
    if (conflict) conflicts.push(conflict);
    // 冲突的操作会被跳过，不能污染虚拟状态；其余操作照常推进状态。
    else applyToVirtualState(state, payload);
  }
  return { conflicts, direction, operationIds: ordered.map(record => record.operationId) };
}

export async function executeOperationReplay(input: {
  direction: OperationReplayDirection;
  repository: LiveWorkspaceRepository;
  records: WorkspaceOperationRecord[];
  skipOperationIds?: string[];
  /**
   * 强制模式：跳过内容校验，直接把文件写成目标内容。
   * 用于「回退本轮修改」——刷新后重新投影的世界书条目/临时文件内容必然与快照不一致，
   * 严格校验会让回退永远无法完成。
   */
  force?: boolean;
}): Promise<{ appliedOperationIds: string[]; failed: OperationReplayConflict[] }> {
  const ordered = input.direction === 'undo' ? [...input.records].reverse() : [...input.records];
  const skipped = new Set(input.skipOperationIds ?? []);
  const appliedOperationIds: string[] = [];
  const failed: OperationReplayConflict[] = [];
  for (const record of ordered) {
    if (skipped.has(record.operationId)) continue;
    const payload = payloadFor(record, input.direction);
    if (!input.force) {
      // 执行阶段每次都真实读写，天然是串行的，直接读仓库即可。
      const conflict = await inspectPayload(
        path => tryRead(input.repository, path),
        record,
        payload,
      );
      if (conflict) {
        failed.push(conflict);
        continue;
      }
    }
    try {
      const toolCallId = `${input.direction}:${record.operationId}:${crypto.randomUUID()}`;
      if (input.force) await input.repository.replayForce(payload, toolCallId);
      else await input.repository.replay(payload, toolCallId);
      appliedOperationIds.push(record.operationId);
    } catch (error) {
      failed.push({
        expected: 'absent',
        operationId: record.operationId,
        path: payload.path,
        reason: error instanceof Error ? error.message : String(error),
        soft: true,
      });
    }
  }
  return { appliedOperationIds, failed };
}
