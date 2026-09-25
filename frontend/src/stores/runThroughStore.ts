/**
 * 连排排期状态管理（Zustand）
 * 安排连排前先逐人核对已排时段（含同一天已排的连排），撞期则不落库；
 * 取消连排即删除记录，时段随之重新空出（撞期核对读的是实时数据）。
 */
import { create } from 'zustand';
import {
  ROW_REVISION,
  getPlay,
  listOperators,
  listPlays,
  listRolesByScenes,
  listRunThroughs,
  listScenesByPlay,
  putRunThrough,
  removeRunThrough,
  type RunThroughRow,
} from '../utils/db';
import {
  collectParticipantIds,
  findRunThroughConflicts,
  sumRunThroughMinutes,
  type RunThroughConflict,
} from '../types/runThrough';
import type { Weekday } from '../types/operator';
import { nowIso, uuid } from '../utils/uuid';

export interface ScheduleRunThroughInput {
  playId: string;
  weekday: Weekday;
  /** 相对当日 08:00 的分钟偏移 */
  startMinute: number;
  sceneIds: string[];
  note: string;
}

/** 安排结果：撞期时 ok=false 并带回「谁撞在哪一段」明细，且不落库 */
export type ScheduleRunThroughResult =
  | { ok: true; row: RunThroughRow }
  | { ok: false; conflicts: RunThroughConflict[] };

interface RunThroughStoreState {
  runThroughs: RunThroughRow[];
  loading: boolean;
  error: string;
  loadRunThroughs: () => Promise<void>;
  scheduleRunThrough: (input: ScheduleRunThroughInput) => Promise<ScheduleRunThroughResult>;
  cancelRunThrough: (runThroughId: string) => Promise<void>;
}

export const useRunThroughStore = create<RunThroughStoreState>((set, get) => ({
  runThroughs: [],
  loading: false,
  error: '',

  async loadRunThroughs() {
    set({ loading: true, error: '' });
    try {
      const runThroughs = await listRunThroughs();
      set({ runThroughs, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '连排排期读取失败' });
    }
  },

  async scheduleRunThrough(input) {
    const play = await getPlay(input.playId);
    if (!play) return { ok: false, conflicts: [] };

    // 以库内最新数据为准：场次、已派角色、操耍人档、全社已排连排
    const [scenes, roles, operators, plays, existing] = await Promise.all([
      listScenesByPlay(input.playId),
      listRolesByScenes(input.sceneIds),
      listOperators(),
      listPlays(),
      listRunThroughs(),
    ]);

    const sceneIds = input.sceneIds.filter((id) => scenes.some((scene) => scene.id === id));
    const durationMinute = sumRunThroughMinutes(scenes, sceneIds);
    if (sceneIds.length === 0 || durationMinute <= 0) return { ok: false, conflicts: [] };

    const participantIds = collectParticipantIds(roles, sceneIds);
    const participants = operators.filter((operator) => participantIds.includes(operator.id));
    const playTitleOf = (playId: string): string =>
      plays.find((item) => item.id === playId)?.title ?? '未命名剧目';

    const conflicts = findRunThroughConflicts({
      weekday: input.weekday,
      startMinute: input.startMinute,
      durationMinute,
      participants,
      existing,
      playTitleOf,
    });
    // 有人撞期：这场连排不记下来
    if (conflicts.length > 0) return { ok: false, conflicts };

    const stamp = nowIso();
    const orderedScenes = sceneIds
      .map((id) => scenes.find((scene) => scene.id === id))
      .filter((scene): scene is NonNullable<typeof scene> => scene !== undefined)
      .sort((a, b) => a.seq - b.seq);
    const row: RunThroughRow = {
      id: uuid(),
      playId: input.playId,
      weekday: input.weekday,
      startMinute: input.startMinute,
      durationMinute,
      sceneIds: orderedScenes.map((scene) => scene.id),
      sceneTitles: orderedScenes.map((scene) => scene.title),
      operatorIds: participantIds,
      note: input.note.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putRunThrough(row);
    await get().loadRunThroughs();
    return { ok: true, row };
  },

  async cancelRunThrough(runThroughId) {
    await removeRunThrough(runThroughId);
    await get().loadRunThroughs();
  },
}));
