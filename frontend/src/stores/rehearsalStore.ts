/**
 * 连排状态管理（Zustand）
 * 安排连排：汇总参与操耍人、按场次时长合计用时，先把参与人的已排时段
 * （含同一天已排的连排）对一遍，撞期则整场不记下来并返回明细；
 * 取消连排即删除记录，占用的时段随之空出。
 */
import { create } from 'zustand';
import {
  ROW_REVISION,
  listAllRoles,
  listAllScenes,
  listOperators,
  listPlays,
  listRehearsals,
  listScenesByPlay,
  putRehearsal,
  removeRehearsal,
  type RehearsalRow,
} from '../utils/db';
import {
  collectRehearsalConflicts,
  rehearsalDurationMin,
  rehearsalParticipantIds,
  type RehearsalConflict,
  type RehearsalOccupancy,
} from '../types/rehearsal';
import type { Weekday } from '../types/operator';
import { nowIso, uuid } from '../utils/uuid';

export interface ScheduleInput {
  playId: string;
  weekday: Weekday;
  /** 开始时间「分钟偏移」，相对当日 08:00 */
  startMinute: number;
  sceneIds: string[];
  note: string;
}

/** 安排结果：撞期时 ok=false 并带回「谁撞在哪一段」 */
export type ScheduleResult = { ok: true; rehearsal: RehearsalRow } | { ok: false; conflicts: RehearsalConflict[] };

interface RehearsalStoreState {
  rehearsals: RehearsalRow[];
  loading: boolean;
  error: string;
  loadRehearsals: () => Promise<void>;
  schedule: (input: ScheduleInput) => Promise<ScheduleResult>;
  cancel: (rehearsalId: string) => Promise<void>;
  /** 某剧目的排期，按排练日与开始时间排序 */
  rehearsalsOfPlay: (playId: string) => RehearsalRow[];
}

/** 排期排序：先排练日、后开始时间 */
export function sortRehearsals(rows: ReadonlyArray<RehearsalRow>): RehearsalRow[] {
  return [...rows].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
}

export const useRehearsalStore = create<RehearsalStoreState>((set, get) => ({
  rehearsals: [],
  loading: false,
  error: '',

  async loadRehearsals() {
    set({ loading: true, error: '' });
    try {
      const rehearsals = await listRehearsals();
      set({ rehearsals, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '连排排期读取失败' });
    }
  },

  async schedule(input) {
    // 覆盖场次按场序保存，用时按场次时长合计
    const wanted = new Set(input.sceneIds);
    const scenes = await listScenesByPlay(input.playId);
    const covered = scenes.filter((scene) => wanted.has(scene.id));
    const sceneIds = covered.map((scene) => scene.id);
    const durationMin = rehearsalDurationMin(sceneIds, covered);
    if (sceneIds.length === 0 || durationMin <= 0) {
      return { ok: false, conflicts: [] };
    }

    // 参与操耍人从已派角色里汇总；同一天已排的连排也算进占用
    const [roles, operators, allRehearsals, allScenes, plays] = await Promise.all([
      listAllRoles(),
      listOperators(),
      listRehearsals(),
      listAllScenes(),
      listPlays(),
    ]);
    const participantIds = rehearsalParticipantIds(sceneIds, roles);
    const playTitleOf = new Map(plays.map((play) => [play.id, play.title]));
    const occupancies: RehearsalOccupancy[] = allRehearsals.map((row) => ({
      id: row.id,
      weekday: row.weekday,
      startMinute: row.startMinute,
      durationMin: rehearsalDurationMin(row.sceneIds, allScenes),
      participantIds: rehearsalParticipantIds(row.sceneIds, roles),
      label: `《${playTitleOf.get(row.playId) ?? '已删除剧目'}》连排`,
    }));

    const conflicts = collectRehearsalConflicts({
      weekday: input.weekday,
      startMinute: input.startMinute,
      durationMin,
      participantIds,
      operators,
      occupancies,
    });
    if (conflicts.length > 0) return { ok: false, conflicts };

    const stamp = nowIso();
    const row: RehearsalRow = {
      id: uuid(),
      playId: input.playId,
      weekday: input.weekday,
      startMinute: input.startMinute,
      sceneIds,
      note: input.note.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putRehearsal(row);
    await get().loadRehearsals();
    return { ok: true, rehearsal: row };
  },

  async cancel(rehearsalId) {
    await removeRehearsal(rehearsalId);
    await get().loadRehearsals();
  },

  rehearsalsOfPlay(playId) {
    return sortRehearsals(get().rehearsals.filter((row) => row.playId === playId));
  },
}));
