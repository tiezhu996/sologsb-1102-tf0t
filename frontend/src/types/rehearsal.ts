/**
 * 连排（Rehearsal）数据模型
 * 一出台戏在某个排练日的一次连排：选排练日、开始时间与覆盖场次。
 * 参与操耍人从已派角色里汇总，用时按场次时长合计；
 * 安排前对参与人的已排时段（含同一天已排的连排），撞期则整场不记下。
 */
import type { Scene } from './scene';
import type { ShadowRole } from './role';
import type { Operator, Weekday } from './operator';
import { WEEKDAY_LABEL, minuteToClock } from './operator';

export interface Rehearsal {
  /** 主键，uuid */
  id: string;
  /** 所属剧目 id */
  playId: string;
  /** 排练日，0 = 周日 */
  weekday: Weekday;
  /** 开始时间「分钟偏移」，相对当日 08:00（与操耍人已排时段同一基准） */
  startMinute: number;
  /** 本次连排覆盖的场次 id，按场序保存 */
  sceneIds: string[];
  /** 备注，如「合乐前最后一次连排」 */
  note: string;
  /** 创建时间（ISO 字符串） */
  createdAt: string;
  /** 最近修改时间（ISO 字符串） */
  updatedAt: string;
}

/** 安排连排时的表单草稿（id / 时间戳由 store 生成） */
export type RehearsalDraft = Pick<Rehearsal, 'weekday' | 'startMinute' | 'sceneIds' | 'note'>;

/** 连排用时：按覆盖场次的时长合计（分钟）；已被删除的场次自动跳过 */
export function rehearsalDurationMin(
  sceneIds: ReadonlyArray<string>,
  scenes: ReadonlyArray<Pick<Scene, 'id' | 'durationMin'>>,
): number {
  const byId = new Map(scenes.map((scene) => [scene.id, scene.durationMin]));
  return sceneIds.reduce((acc, id) => {
    const duration = byId.get(id);
    return acc + (typeof duration === 'number' && Number.isFinite(duration) ? Math.max(0, duration) : 0);
  }, 0);
}

/** 参与操耍人 id：从覆盖场次的已派角色里汇总去重 */
export function rehearsalParticipantIds(
  sceneIds: ReadonlyArray<string>,
  roles: ReadonlyArray<Pick<ShadowRole, 'sceneId' | 'operatorId'>>,
): string[] {
  const covered = new Set(sceneIds);
  const ids = new Set<string>();
  roles.forEach((role) => {
    if (role.operatorId !== null && covered.has(role.sceneId)) ids.add(role.operatorId);
  });
  return [...ids];
}

/** 撞期记录：谁撞在哪一段 */
export interface RehearsalConflict {
  operatorId: string;
  operatorName: string;
  weekday: Weekday;
  /** 重叠区间起点（分钟偏移，08:00 基准） */
  overlapStart: number;
  /** 重叠区间终点 */
  overlapEnd: number;
  /** 撞上的那段安排，如「周一上午·连排《借伞》」或「《借伞》周三连排」 */
  sourceLabel: string;
}

/** 已排连排参与撞期判定的投影（用时与参与人按当前场次 / 角色实时派生） */
export interface RehearsalOccupancy {
  id: string;
  weekday: Weekday;
  startMinute: number;
  durationMin: number;
  participantIds: string[];
  label: string;
}

export interface RehearsalConflictInput {
  weekday: Weekday;
  startMinute: number;
  durationMin: number;
  participantIds: string[];
  operators: ReadonlyArray<Pick<Operator, 'id' | 'name' | 'busySlots'>>;
  /** 全部剧目已排的连排（函数内部只取同一天） */
  occupancies: ReadonlyArray<RehearsalOccupancy>;
}

/**
 * 安排连排前，把参与人的已排时段对一遍：
 * 1. 操耍人档里登记的已排时段；
 * 2. 同一天已排的连排（与本次有共同参与人即算撞期）。
 */
export function collectRehearsalConflicts(input: RehearsalConflictInput): RehearsalConflict[] {
  const end = input.startMinute + input.durationMin;
  const participants = new Set(input.participantIds);
  const conflicts: RehearsalConflict[] = [];

  input.operators.forEach((operator) => {
    if (!participants.has(operator.id)) return;
    operator.busySlots.forEach((slot) => {
      if (slot.weekday !== input.weekday) return;
      const overlapStart = Math.max(input.startMinute, slot.startMinute);
      const overlapEnd = Math.min(end, slot.startMinute + slot.durationMinute);
      if (overlapStart >= overlapEnd) return;
      conflicts.push({
        operatorId: operator.id,
        operatorName: operator.name,
        weekday: input.weekday,
        overlapStart,
        overlapEnd,
        sourceLabel: slot.label,
      });
    });
  });

  input.occupancies.forEach((occupancy) => {
    if (occupancy.weekday !== input.weekday) return;
    const overlapStart = Math.max(input.startMinute, occupancy.startMinute);
    const overlapEnd = Math.min(end, occupancy.startMinute + occupancy.durationMin);
    if (overlapStart >= overlapEnd) return;
    occupancy.participantIds.forEach((operatorId) => {
      if (!participants.has(operatorId)) return;
      // 同一位操耍人撞在同一场连排只报一次
      if (conflicts.some((item) => item.operatorId === operatorId && item.sourceLabel === occupancy.label)) return;
      conflicts.push({
        operatorId,
        operatorName: input.operators.find((item) => item.id === operatorId)?.name ?? '（已删除）',
        weekday: input.weekday,
        overlapStart,
        overlapEnd,
        sourceLabel: occupancy.label,
      });
    });
  });

  return conflicts.sort(
    (a, b) => a.overlapStart - b.overlapStart || a.operatorName.localeCompare(b.operatorName, 'zh-Hans-CN'),
  );
}

/** 撞期文案：「霍连生 撞在周三 14:00-14:32（周三上午·新编场）」 */
export function describeRehearsalConflict(conflict: RehearsalConflict): string {
  const from = minuteToClock(conflict.overlapStart);
  const to = minuteToClock(conflict.overlapEnd);
  return `${conflict.operatorName} 撞在${WEEKDAY_LABEL[conflict.weekday]} ${from}-${to}（${conflict.sourceLabel}）`;
}
