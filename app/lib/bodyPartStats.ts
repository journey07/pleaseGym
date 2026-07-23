// 부위(bodyPart) 단위 집계 — 서버 route + 클라이언트 공용 순수 함수.
// "신규 도배" 해결의 핵심: 종목명이 아니라 부위로 볼륨/빈도/방치를 집계한다.
// 부위는 exercise.bodyPart(수동 교정 우선) ?? inferBodyPart(name).

import { BodyPart, MUSCLE_PARTS, inferBodyPart } from "./bodyPart";

export type StatSet = {
  weight?: number;
  reps?: number;
  distanceKm?: number;
  done?: boolean;
};
export type StatExercise = {
  name?: string;
  metric?: string;
  bodyPart?: BodyPart;
  sets?: StatSet[];
};
export type StatSession = { date?: string; exercises?: StatExercise[] };

export type BodyPartStat = {
  part: BodyPart;
  weeklySets: number; // 최근 7일 유효 세트 수
  weeklyVolume: number; // 최근 7일 볼륨(중량=Σw×r, 맨몸=Σreps)
  monthlyVolume: number; // 최근 28일 볼륨
  lastTrainedDate: string | null;
  daysSinceLast: number | null; // today 기준 경과일
  freq7: number; // 최근 7일 이 부위를 건드린 세션 수
  freq28: number; // 최근 28일
  trend: "up" | "flat" | "down" | "new";
};

const dayKey = (raw: string): string => String(raw).slice(0, 10);

const daysBetween = (fromKey: string, toKey: string): number => {
  const from = Date.parse(`${fromKey}T00:00:00Z`);
  const to = Date.parse(`${toKey}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return Number.POSITIVE_INFINITY;
  return Math.floor((to - from) / 86_400_000);
};

// 한 운동의 볼륨과 유효 세트 수. 거리(유산소)는 부위 집계 대상 아님 → null.
const exerciseVolume = (
  ex: StatExercise,
): { volume: number; sets: number } | null => {
  if (ex.metric === "distance") return null;
  const done = (ex.sets ?? []).filter((s) => s?.done !== false);
  let volume = 0;
  let sets = 0;
  for (const s of done) {
    const reps = Number(s.reps) || 0;
    if (reps <= 0) continue;
    const weight = Number(s.weight) || 0;
    volume += ex.metric === "bodyweight" ? reps : weight * reps;
    sets += 1;
  }
  if (sets === 0) return null;
  return { volume, sets };
};

const partOf = (ex: StatExercise): BodyPart =>
  ex.bodyPart ?? inferBodyPart(String(ex.name ?? ""));

/**
 * 근육 8부위(기타·거리 제외) 집계. todayKey(YYYY-MM-DD) 기준 상대 창.
 * weeklyVolume 내림차순 정렬(편중 파악 쉽게).
 */
export const computeBodyPartStats = (
  sessions: StatSession[],
  todayKey: string,
): BodyPartStat[] => {
  const acc = new Map<
    BodyPart,
    {
      weeklySets: number;
      weeklyVolume: number;
      monthlyVolume: number;
      lastTrainedDate: string | null;
      days7: Set<string>;
      days28: Set<string>;
      weekVolume: [number, number, number, number]; // 주1(최근)~주4
    }
  >();
  for (const part of MUSCLE_PARTS) {
    acc.set(part, {
      weeklySets: 0,
      weeklyVolume: 0,
      monthlyVolume: 0,
      lastTrainedDate: null,
      days7: new Set(),
      days28: new Set(),
      weekVolume: [0, 0, 0, 0],
    });
  }

  for (const session of sessions) {
    if (!session?.date || !Array.isArray(session.exercises)) continue;
    const date = dayKey(session.date);
    const ago = daysBetween(date, todayKey);
    if (ago < 0 || ago > 27) continue; // 최근 28일만
    for (const ex of session.exercises) {
      const vol = exerciseVolume(ex);
      if (!vol) continue;
      const part = partOf(ex);
      const a = acc.get(part);
      if (!a) continue; // 기타는 MUSCLE_PARTS에 없음 → 스킵

      a.monthlyVolume += vol.volume;
      a.days28.add(date);
      const week = Math.min(3, Math.floor(ago / 7));
      a.weekVolume[week] += vol.volume;
      if (ago <= 6) {
        a.weeklyVolume += vol.volume;
        a.weeklySets += vol.sets;
        a.days7.add(date);
      }
      if (!a.lastTrainedDate || date > a.lastTrainedDate) {
        a.lastTrainedDate = date;
      }
    }
  }

  const result: BodyPartStat[] = MUSCLE_PARTS.map((part) => {
    const a = acc.get(part)!;
    const nonZeroWeeks = a.weekVolume.filter((v) => v > 0).length;
    const recent = a.weekVolume[0] + a.weekVolume[1];
    const older = a.weekVolume[2] + a.weekVolume[3];
    let trend: BodyPartStat["trend"];
    if (nonZeroWeeks <= 1) trend = "new";
    else if (recent > older * 1.1) trend = "up";
    else if (recent < older * 0.9) trend = "down";
    else trend = "flat";
    return {
      part,
      weeklySets: a.weeklySets,
      weeklyVolume: Math.round(a.weeklyVolume),
      monthlyVolume: Math.round(a.monthlyVolume),
      lastTrainedDate: a.lastTrainedDate,
      daysSinceLast: a.lastTrainedDate
        ? daysBetween(a.lastTrainedDate, todayKey)
        : null,
      freq7: a.days7.size,
      freq28: a.days28.size,
      trend,
    };
  });

  return result.sort((x, y) => y.weeklyVolume - x.weeklyVolume);
};

// 방치 부위: 최근 28일 한 번도 안 했거나(daysSinceLast null) 10일 이상 공백.
export const neglectedParts = (stats: BodyPartStat[]): BodyPart[] =>
  stats
    .filter((s) => s.daysSinceLast === null || s.daysSinceLast >= 10)
    .map((s) => s.part);
