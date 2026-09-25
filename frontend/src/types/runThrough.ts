/**
 * 连排（RunThrough）数据模型
 * 一出台戏某次整段排练的排期记录：排练日 + 开始时间 + 连排场次。
 * 参与操耍人从已派角色汇总，用时按场次时长合计；
 * 安排前逐人核对已排时段（含同一天已排的连排），撞期则不记录。
 */
import type { Operator, BusySlot, SlotRange, Weekday } from './operator';
import { WEEKDAY_LABEL, minuteToClock, slotsOverlap } from './operator';
import type { ShadowRole } from './role';
import type { Scene } from './scene';

export interface RunThrough {
  /** 主键，uuid */
  id: string;
  /** 所属剧目 id */
  playId: string;
  /** 排练日，0 = 周日 */
  weekday: Weekday;
  /** 开始时间：相对当日 08:00 的分钟偏移，与 BusySlot 同一基准 */
  startMinute: number;
  /** 用时（分钟）：各连排场次时长合计 */
  durationMinute: number;
  /** 连排场次 id 列表 */
  sceneIds: string[];
  /** 场次标题快照，排期列表直接可读（场次后续改动不影响历史排期） */
  sceneTitles: string[];
  /** 参与操耍人 id 快照（安排时从已派角色汇总） */
  operatorIds: string[];
  /** 备注 */
  note: string;
  /** 创建时间（ISO 字符串） */
  createdAt: string;
  /** 最近修改时间（ISO 字符串） */
  updatedAt: string;
}

/** 安排连排时的表单草稿（id / 用时 / 快照 / 时间戳由 store 生成） */
export type RunThroughDraft = Pick<RunThrough, 'playId' | 'weekday' | 'startMinute' | 'sceneIds' | 'note'>;

/** 撞期条目：谁撞在哪一段 */
export interface RunThroughConflict {
  /** operator = 参与人已有安排；runThrough = 同一天已排的连排 */
  kind: 'operator' | 'runThrough';
  /** 操耍人姓名，或已排连排的剧目名 */
  who: string;
  /** 被撞的既有安排备注 */
  label: string;
  /** 排练日 */
  weekday: Weekday;
  /** 被撞时段起止（分钟偏移） */
  busyStart: number;
  busyEnd: number;
  /** 与本次连排的重叠段（分钟偏移） */
  overlapStart: number;
  overlapEnd: number;
}

/** 把撞期条目格式化成「谁撞在哪一段」的一句话 */
export function describeRunThroughConflict(conflict: RunThroughConflict): string {
  const busy = `${WEEKDAY_LABEL[conflict.weekday]} ${minuteToClock(conflict.busyStart)}-${minuteToClock(conflict.busyEnd)}`;
  const overlap = `${minuteToClock(conflict.overlapStart)}-${minuteToClock(conflict.overlapEnd)}`;
  if (conflict.kind === 'operator') {
    return `${conflict.who} 撞在 ${busy}「${conflict.label}」，重叠 ${overlap}`;
  }
  return `${conflict.who}当天 ${busy} 已排连排「${conflict.label}」，重叠 ${overlap}`;
}

/** 从已派角色里汇总参与操耍人 id（去重，保持出现顺序） */
export function collectParticipantIds(
  roles: ReadonlyArray<Pick<ShadowRole, 'sceneId' | 'operatorId'>>,
  sceneIds: ReadonlyArray<string>,
): string[] {
  const wanted = new Set(sceneIds);
  const ids: string[] = [];
  roles.forEach((role) => {
    if (role.operatorId !== null && wanted.has(role.sceneId) && !ids.includes(role.operatorId)) {
      ids.push(role.operatorId);
    }
  });
  return ids;
}

/** 连排用时：按勾选的场次时长合计（分钟） */
export function sumRunThroughMinutes(
  scenes: ReadonlyArray<Pick<Scene, 'id' | 'durationMin'>>,
  sceneIds: ReadonlyArray<string>,
): number {
  const wanted = new Set(sceneIds);
  return scenes
    .filter((scene) => wanted.has(scene.id))
    .reduce((acc, scene) => acc + (Number.isFinite(scene.durationMin) ? Math.max(0, scene.durationMin) : 0), 0);
}

/** 排期列表排序：先排练日，再开始时间 */
export function compareRunThroughs(a: Pick<RunThrough, 'weekday' | 'startMinute'>, b: Pick<RunThrough, 'weekday' | 'startMinute'>): number {
  if (a.weekday !== b.weekday) return a.weekday - b.weekday;
  return a.startMinute - b.startMinute;
}

/**
 * 安排前的撞期核对：
 * 1. 逐个参与操耍人核对其已排时段（busySlots）；
 * 2. 同一天已排的连排（全社，含本剧）也算占用。
 * 返回空数组表示可以安排。
 */
export function findRunThroughConflicts(args: {
  weekday: Weekday;
  startMinute: number;
  durationMinute: number;
  participants: ReadonlyArray<Pick<Operator, 'id' | 'name' | 'busySlots'>>;
  existing: ReadonlyArray<Pick<RunThrough, 'id' | 'playId' | 'weekday' | 'startMinute' | 'durationMinute' | 'note'>>;
  playTitleOf: (playId: string) => string;
  /** 排除某条已排连排（如改期场景排除自身） */
  excludeId?: string;
}): RunThroughConflict[] {
  const { weekday, startMinute, durationMinute, participants, existing, playTitleOf, excludeId } = args;
  const target: SlotRange = {
    slotId: '__candidate__',
    weekday,
    startMinute,
    endMinute: startMinute + Math.max(0, durationMinute),
    label: '本次连排',
  };
  const conflicts: RunThroughConflict[] = [];

  participants.forEach((operator) => {
    operator.busySlots.forEach((slot: BusySlot) => {
      const range: SlotRange = {
        slotId: slot.id,
        weekday: slot.weekday,
        startMinute: slot.startMinute,
        endMinute: slot.startMinute + slot.durationMinute,
        label: slot.label,
      };
      if (!slotsOverlap(target, range)) return;
      conflicts.push({
        kind: 'operator',
        who: operator.name,
        label: slot.label,
        weekday: slot.weekday,
        busyStart: range.startMinute,
        busyEnd: range.endMinute,
        overlapStart: Math.max(target.startMinute, range.startMinute),
        overlapEnd: Math.min(target.endMinute, range.endMinute),
      });
    });
  });

  existing.forEach((item) => {
    if (excludeId !== undefined && item.id === excludeId) return;
    const range: SlotRange = {
      slotId: item.id,
      weekday: item.weekday,
      startMinute: item.startMinute,
      endMinute: item.startMinute + item.durationMinute,
      label: item.note,
    };
    if (!slotsOverlap(target, range)) return;
    conflicts.push({
      kind: 'runThrough',
      who: `《${playTitleOf(item.playId)}》`,
      label: item.note || '已排连排',
      weekday: item.weekday,
      busyStart: range.startMinute,
      busyEnd: range.endMinute,
      overlapStart: Math.max(target.startMinute, range.startMinute),
      overlapEnd: Math.min(target.endMinute, range.endMinute),
    });
  });

  return conflicts;
}
