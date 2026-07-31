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
  assisted?: boolean;
  bodyPart?: BodyPart;
  sets?: StatSet[];
};
export type StatSession = { date?: string; exercises?: StatExercise[] };
export type BodyweightEntry = { date: string; kg: number };

export type BodyPartStat = {
  part: BodyPart;
  weeklySets: number; // 최근 7일 유효 세트 수
  // 최근 7일 볼륨. 체중 로그가 있으면 전 종목 Σ(실부하kg×reps),
  // 없으면 중량=Σw×r · 맨몸=Σreps(기존 폴백).
  weeklyVolume: number;
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

/**
 * 그 날짜에 유효한 체중(kg). 로그가 비면 null.
 * 해당 날짜 이하의 마지막 기록을 쓰고, 첫 기록보다 이른 날짜는 첫 기록으로 소급한다
 * (→ 로그가 하나라도 있으면 모든 날짜가 값을 가져 부위 볼륨 단위가 섞이지 않는다).
 * bodyweightLog는 date 오름차순이어야 한다.
 */
export const bodyweightForDate = (
  bodyweightLog: BodyweightEntry[],
  date: string,
): number | null => {
  if (bodyweightLog.length === 0) return null;
  let latest: BodyweightEntry | undefined;
  for (const entry of bodyweightLog) {
    if (entry.date.slice(0, 10) > date) break;
    latest = entry;
  }
  return (latest ?? bodyweightLog[0]).kg;
};

/**
 * 맨몸 세트의 실부하(kg). assisted는 머신이 체중을 덜어주므로 보조가 줄수록 부하가 커진다
 * (일반 웨이트와 부호 반대) → 체중 − 보조. 그 외엔 체중 + 추가중량.
 */
const bodyweightLoad = (
  ex: StatExercise,
  setWeight: number,
  bodyweight: number,
): number => {
  const extra = Math.max(setWeight, 0);
  return ex.assisted === true
    ? Math.max(bodyweight - extra, 1)
    : bodyweight + extra;
};

// 한 운동의 볼륨과 유효 세트 수. 거리(유산소)는 부위 집계 대상 아님 → null.
// bodyweight: 그 세션 날짜의 체중(없으면 null → 맨몸은 reps 폴백).
const exerciseVolume = (
  ex: StatExercise,
  bodyweight: number | null,
): { volume: number; sets: number } | null => {
  if (ex.metric === "distance") return null;
  const done = (ex.sets ?? []).filter((s) => s?.done !== false);
  let volume = 0;
  let sets = 0;
  for (const s of done) {
    const reps = Number(s.reps) || 0;
    if (reps <= 0) continue;
    const weight = Number(s.weight) || 0;
    if (ex.metric === "bodyweight") {
      volume +=
        bodyweight === null
          ? reps
          : bodyweightLoad(ex, weight, bodyweight) * reps;
    } else {
      volume += weight * reps;
    }
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
 * bodyweightLog를 주면 맨몸 종목도 실부하kg로 환산해 중량 종목과 같은 단위로 합산한다.
 */
export const computeBodyPartStats = (
  sessions: StatSession[],
  todayKey: string,
  bodyweightLog: BodyweightEntry[] = [],
): BodyPartStat[] => {
  const bwLog = [...bodyweightLog]
    .filter((e) => !!e && typeof e.date === "string" && Number.isFinite(e.kg))
    .sort((a, b) => a.date.localeCompare(b.date));
  const bwCache = new Map<string, number | null>();
  const bodyweightOn = (date: string): number | null => {
    if (!bwCache.has(date)) bwCache.set(date, bodyweightForDate(bwLog, date));
    return bwCache.get(date) ?? null;
  };
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
    const bodyweight = bodyweightOn(date);
    for (const ex of session.exercises) {
      const vol = exerciseVolume(ex, bodyweight);
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
