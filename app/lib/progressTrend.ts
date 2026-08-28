import { inferBodyPart, type BodyPart } from "./bodyPart";
import type { StatSession } from "./bodyPartStats";
import { canonicalNameMap, normalizeExerciseName } from "./exerciseName";
import {
  assistedLoad,
  bodyweightForDate,
  detectAssisted,
  estimateOneRepMax,
  sessionLoadOf,
  type BodyweightEntry,
} from "./trainingLoad";

export type LiftVerdict = "growing" | "stalled" | "declining" | "idle";

export type RegionKey = "upper" | "lower" | "core";

export type LiftTrend = {
  name: string;
  region: RegionKey | "other";
  verdict: LiftVerdict;
  changePct: number;
  from: number;
  to: number;
  unit: "kg" | "회";
  sessions: number;
  daysSinceLast: number;
  note: string;
};

export type RegionTrend = {
  region: RegionKey;
  setsThisWeek: number;
  setsPrevWeek: number;
  changePct: number;
  verdict: "up" | "flat" | "down";
};

export const REGION_PARTS: Record<RegionKey, BodyPart[]> = {
  upper: ["가슴", "등", "어깨", "팔"],
  lower: ["허벅지", "종아리"],
  core: ["복근", "허리"],
};

type TrendSet = { weight: number; reps: number };

type LiftDay = {
  date: string;
  kind: "load" | "reps";
  region: LiftTrend["region"];
  loadSets: TrendSet[];
  topReps: number;
};

type LiftPoint = {
  date: string;
  value: number;
  topValue: number;
};

const DAY_MS = 86_400_000;
const REGION_KEYS: RegionKey[] = ["upper", "lower", "core"];

const dayKey = (raw: string): string => String(raw).slice(0, 10);

const daysBetween = (fromKey: string, toKey: string): number => {
  const from = Date.parse(`${fromKey}T00:00:00Z`);
  const to = Date.parse(`${toKey}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.floor((to - from) / DAY_MS);
};

const round1 = (value: number): number => Math.round(value * 10) / 10;

const formatNumber = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1);

const regionOf = (part: BodyPart): LiftTrend["region"] => {
  for (const region of REGION_KEYS) {
    if (REGION_PARTS[region].includes(part)) return region;
  }
  return "other";
};

const percentChange = (from: number, to: number): number => {
  if (from === 0) return to === 0 ? 0 : 100;
  return round1(((to - from) / from) * 100);
};

const validSessions = (sessions: StatSession[], todayKey: string) =>
  sessions
    .filter(
      (session) =>
        typeof session.date === "string" && Array.isArray(session.exercises),
    )
    .map((session) => ({
      date: dayKey(session.date!),
      exercises: session.exercises ?? [],
    }))
    .filter(({ date }) => {
      const ago = daysBetween(date, todayKey);
      return ago >= 0 && Number.isFinite(ago);
    })
    .sort((a, b) => a.date.localeCompare(b.date));

export const computeLiftTrends = (
  sessions: StatSession[],
  todayKey: string,
  bodyweightLog: BodyweightEntry[] = [],
): LiftTrend[] => {
  const pastSessions = validSessions(sessions, todayKey);
  const canonicalNames = canonicalNameMap(
    pastSessions.flatMap((session) =>
      session.exercises.map((exercise) => String(exercise.name ?? "")),
    ),
  );
  const lifts = new Map<string, Map<string, LiftDay>>();

  for (const session of pastSessions) {
    for (const exercise of session.exercises) {
      const name = String(exercise.name ?? "").trim().slice(0, 60);
      const normalizedName = normalizeExerciseName(name);
      if (!normalizedName || exercise.metric === "distance") continue;

      const sets = (exercise.sets ?? [])
        .filter((set) => set?.done !== false)
        .map((set) => ({
          weight: Number(set.weight) || 0,
          reps: Number(set.reps) || 0,
        }))
        .filter((set) => set.reps > 0);
      if (sets.length === 0) continue;

      const assisted = detectAssisted(name, exercise.assisted);
      const kind = assisted || exercise.metric !== "bodyweight" ? "load" : "reps";
      const key = `${normalizedName}\u0000${kind}`;
      const byDate = lifts.get(key) ?? new Map<string, LiftDay>();
      const existing = byDate.get(session.date);
      const region = regionOf(
        exercise.bodyPart ?? inferBodyPart(name),
      );

      if (kind === "reps") {
        const topReps = sets.reduce(
          (best, set) => Math.max(best, set.reps),
          existing?.topReps ?? 0,
        );
        byDate.set(session.date, {
          date: session.date,
          kind,
          region,
          loadSets: [],
          topReps,
        });
        lifts.set(key, byDate);
        continue;
      }

      const bodyweight = assisted
        ? bodyweightForDate(bodyweightLog, session.date)
        : null;
      if (assisted && bodyweight === null) continue;
      const loadSets = sets
        .map((set) => ({
          weight: assisted
            ? assistedLoad(bodyweight!, set.weight)
            : set.weight,
          reps: set.reps,
        }))
        .filter((set) => set.weight > 0);
      if (loadSets.length === 0) continue;

      byDate.set(session.date, {
        date: session.date,
        kind,
        region,
        loadSets: [...(existing?.loadSets ?? []), ...loadSets],
        topReps: 0,
      });
      lifts.set(key, byDate);
    }
  }

  const trends: LiftTrend[] = [];
  for (const [key, byDate] of lifts) {
    const allPoints: LiftPoint[] = [...byDate.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((day) => {
        if (day.kind === "reps") {
          return {
            date: day.date,
            value: day.topReps,
            topValue: day.topReps,
          };
        }
        const sessionLoad = sessionLoadOf(day.loadSets);
        const e1rm = day.loadSets.reduce(
          (best, set) =>
            Math.max(best, estimateOneRepMax(set.weight, set.reps)),
          0,
        );
        return {
          date: day.date,
          value: round1(sessionLoad || e1rm),
          topValue: round1(
            day.loadSets.reduce(
              (best, set) => Math.max(best, set.weight),
              0,
            ),
          ),
        };
      });
    const lastDate = allPoints.at(-1)!.date;
    const points = allPoints.filter((point) => {
      const ago = daysBetween(point.date, lastDate);
      return ago >= 0 && ago <= 27;
    });
    if (points.length < 2) continue;
    const first = points[0];
    const last = points.at(-1)!;
    const changePct = percentChange(first.value, last.value);
    const daysSinceLast = daysBetween(last.date, todayKey);
    const recentTop = points.slice(-3).map((point) => point.topValue);
    const sameRecentTop =
      recentTop.length === 3 &&
      recentTop.every((value) => value === recentTop[0]);
    let verdict: LiftVerdict;
    if (daysSinceLast >= 14) verdict = "idle";
    else if (changePct <= -10) verdict = "declining";
    else if (sameRecentTop && changePct < 3) verdict = "stalled";
    else if (changePct >= 3) verdict = "growing";
    else verdict = "stalled";

    const unit = byDate.values().next().value!.kind === "reps" ? "회" : "kg";
    const note =
      verdict === "idle"
        ? `${formatNumber(last.value)}${unit}, ${daysSinceLast}일 공백`
        : sameRecentTop && verdict === "stalled"
          ? `${formatNumber(last.topValue)}${unit} 3세션 동일`
          : `${formatNumber(first.value)}→${formatNumber(last.value)}${unit}`;
    const [normalizedName] = key.split("\u0000");
    const lastDay = byDate.get(last.date)!;
    trends.push({
      name: canonicalNames.get(normalizedName) ?? normalizedName,
      region: lastDay.region,
      verdict,
      changePct,
      from: first.value,
      to: last.value,
      unit,
      sessions: points.length,
      daysSinceLast,
      note,
    });
  }

  const regionOrder: Record<LiftTrend["region"], number> = {
    upper: 0,
    lower: 1,
    core: 2,
    other: 3,
  };
  return trends.sort(
    (a, b) =>
      regionOrder[a.region] - regionOrder[b.region] ||
      b.sessions - a.sessions ||
      a.name.localeCompare(b.name, "ko"),
  );
};

export const computeRegionTrends = (
  sessions: StatSession[],
  todayKey: string,
): RegionTrend[] => {
  const setsByRegion: Record<RegionKey, [number, number]> = {
    upper: [0, 0],
    lower: [0, 0],
    core: [0, 0],
  };

  for (const session of validSessions(sessions, todayKey)) {
    const ago = daysBetween(session.date, todayKey);
    if (ago > 13) continue;
    const week = ago <= 6 ? 0 : 1;
    for (const exercise of session.exercises) {
      if (exercise.metric === "distance") continue;
      const name = String(exercise.name ?? "");
      const region = regionOf(
        exercise.bodyPart ?? inferBodyPart(name),
      );
      if (region === "other") continue;
      const validSets = (exercise.sets ?? []).filter(
        (set) => set?.done !== false && (Number(set.reps) || 0) > 0,
      ).length;
      setsByRegion[region][week] += validSets;
    }
  }

  return REGION_KEYS.map((region) => {
    const [setsThisWeek, setsPrevWeek] = setsByRegion[region];
    const changePct = percentChange(setsPrevWeek, setsThisWeek);
    const verdict: RegionTrend["verdict"] =
      changePct >= 10 ? "up" : changePct <= -10 ? "down" : "flat";
    return {
      region,
      setsThisWeek,
      setsPrevWeek,
      changePct,
      verdict,
    };
  });
};

export const computeProgressTrends = (
  sessions: StatSession[],
  todayKey: string,
  bodyweightLog: BodyweightEntry[] = [],
): { liftTrends: LiftTrend[]; regionTrends: RegionTrend[] } => ({
  liftTrends: computeLiftTrends(sessions, todayKey, bodyweightLog),
  regionTrends: computeRegionTrends(sessions, todayKey),
});
