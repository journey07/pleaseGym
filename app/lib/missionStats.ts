// 모닝 HUD 통계. 목적은 "꾸준함" 하나이므로 횟수와 기간만 센다.
// 순수 모듈: todayKey를 인자로 받고 내부에서 오늘을 구하지 않는다(테스트 가능).

type MissionSet = {
  weight?: number;
  reps?: number;
  done?: boolean;
};

type MissionExercise = {
  name?: string;
  metric?: "weight" | "bodyweight" | "distance";
  assisted?: boolean;
  sets?: MissionSet[];
};

type MissionSession = {
  date?: string;
  exercises?: MissionExercise[];
};

export type MissionStats = {
  thisWeekCount: number;
  weeklyGoal: number;
  remainingThisWeek: number;
  streakDays: number;
  streakStartDate: string | null;
  streakBroken: boolean;
};

type ComputeMissionStatsInput = {
  sessions: MissionSession[];
  todayKey: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKLY_GOAL = 3;
// 쉬는 날은 최대 2일까지 인정한다. 즉 세션 간격이 3일 이내여야 스트릭이 이어진다.
const MAX_REST_DAYS = 2;
const MAX_SESSION_GAP = MAX_REST_DAYS + 1;

const parseDateKey = (dateKey: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateKey);
  if (!match) return null;
  const value = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  const date = new Date(value);
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  )
    return null;
  return value;
};

const formatDateKey = (value: number) => {
  const date = new Date(value);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const validDateKey = (dateKey: string) => {
  const value = parseDateKey(dateKey);
  return value === null ? null : formatDateKey(value);
};

const daysBetween = (earlier: string, later: string) => {
  const earlierValue = parseDateKey(earlier);
  const laterValue = parseDateKey(later);
  if (earlierValue === null || laterValue === null) return Infinity;
  return Math.round((laterValue - earlierValue) / DAY_MS);
};

export const weekStartKey = (dateKey: string) => {
  const value = parseDateKey(dateKey);
  if (value === null) return dateKey;
  const weekday = new Date(value).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  return formatDateKey(value - daysSinceMonday * DAY_MS);
};

/** "2026-08-05" → "8월 5일" */
export const koreanDateLabel = (dateKey: string) => {
  const value = parseDateKey(dateKey);
  if (value === null) return dateKey;
  const date = new Date(value);
  return `${date.getUTCMonth() + 1}월 ${date.getUTCDate()}일`;
};

export const computeMissionStats = ({
  sessions,
  todayKey,
}: ComputeMissionStatsInput): MissionStats => {
  const today = validDateKey(todayKey) ?? todayKey;
  const sessionDates = [
    ...new Set(
      sessions
        .map((session) =>
          typeof session.date === "string" ? validDateKey(session.date) : null,
        )
        .filter((date): date is string => date !== null && date <= today),
    ),
  ].sort();

  const thisWeek = weekStartKey(today);
  const thisWeekCount = sessionDates.filter(
    (date) => weekStartKey(date) === thisWeek,
  ).length;

  // 스트릭: 마지막 세션이 유예 안에 있어야 살아 있고, 거슬러 올라가며 간격을 본다.
  let streakDays = 0;
  let streakStartDate: string | null = null;
  let streakBroken = true;
  const latestSession = sessionDates.at(-1);
  if (latestSession && daysBetween(latestSession, today) <= MAX_SESSION_GAP) {
    streakBroken = false;
    let startIndex = sessionDates.length - 1;
    for (let index = sessionDates.length - 1; index > 0; index -= 1) {
      if (
        daysBetween(sessionDates[index - 1], sessionDates[index]) >
        MAX_SESSION_GAP
      )
        break;
      startIndex = index - 1;
    }
    streakStartDate = sessionDates[startIndex];
    // 시작일 당일을 1일째로 센다.
    streakDays = daysBetween(streakStartDate, today) + 1;
  }

  return {
    thisWeekCount,
    weeklyGoal: WEEKLY_GOAL,
    remainingThisWeek: Math.max(0, WEEKLY_GOAL - thisWeekCount),
    streakDays,
    streakStartDate,
    streakBroken,
  };
};

// ── 3년 뒤의 나 ──────────────────────────────────────────────
// 목표 수치는 고정한다(흔들리면 목표가 아니다). 현재값만 기록에서 계산해 거리를 보여준다.

export type VisionRow = {
  key: "weight" | "pullup" | "squat";
  label: string;
  current: number | null;
  target: number;
  /** 화면에 붙는 짧은 꼬리말. 남은 양이나 진행률. */
  note: string;
};

const VISION_TARGET = { weight: 73, pullupAssist: 0, squatE1rm: 100 };
const SQUAT_NAME = /^스쿼트$|^back ?squat$/i;
const PULLUP_NAME = /풀업|pull ?up|친업|chin ?up/i;

const round1 = (value: number) => Math.round(value * 10) / 10;
const e1rm = (weight: number, reps: number) => weight * (1 + reps / 30);

export const computeVision = (
  sessions: MissionSession[],
  latestWeight: number | null,
): VisionRow[] => {
  let squatBest = 0;
  let pullupAssist: number | null = null;

  for (const session of sessions) {
    for (const exercise of session.exercises ?? []) {
      const name = String(exercise.name ?? "").trim();
      if (!name) continue;
      const done = (exercise.sets ?? []).filter((set) => set.done !== false);

      if (SQUAT_NAME.test(name.replace(/\s+/g, ""))) {
        for (const set of done) {
          const weight = Number(set.weight) || 0;
          const reps = Number(set.reps) || 0;
          if (weight > 0 && reps > 0)
            squatBest = Math.max(squatBest, e1rm(weight, reps));
        }
      }

      // 어시스티드 풀업은 보조가 적을수록 강하다. 최소 보조를 기록으로 본다.
      if (PULLUP_NAME.test(name)) {
        const assisted =
          exercise.assisted === true || /assisted|어시스티드/i.test(name);
        for (const set of done) {
          const reps = Number(set.reps) || 0;
          if (reps <= 0) continue;
          const assist = assisted ? Math.max(Number(set.weight) || 0, 0) : 0;
          if (assist <= 0 && !assisted) {
            pullupAssist = 0;
            continue;
          }
          if (assist > 0)
            pullupAssist =
              pullupAssist === null ? assist : Math.min(pullupAssist, assist);
        }
      }
    }
  }

  const weightNote =
    latestWeight === null
      ? "체중을 기록하면 거리를 보여준다"
      : latestWeight >= VISION_TARGET.weight
        ? "도달했다"
        : `${round1(VISION_TARGET.weight - latestWeight)}kg 남았다`;

  const squatNote =
    squatBest <= 0
      ? "아직 기록이 없다"
      : `${Math.round((squatBest / VISION_TARGET.squatE1rm) * 100)}% 왔다`;

  const pullupNote =
    pullupAssist === null
      ? "아직 기록이 없다"
      : pullupAssist <= 0
        ? "보조를 뗐다"
        : `보조 ${round1(pullupAssist)}kg 남았다`;

  return [
    {
      key: "weight",
      label: "체중",
      current: latestWeight,
      target: VISION_TARGET.weight,
      note: weightNote,
    },
    {
      key: "pullup",
      label: "풀업",
      current: pullupAssist,
      target: VISION_TARGET.pullupAssist,
      note: pullupNote,
    },
    {
      key: "squat",
      label: "스쿼트",
      current: squatBest > 0 ? round1(squatBest) : null,
      target: VISION_TARGET.squatE1rm,
      note: squatNote,
    },
  ];
};
