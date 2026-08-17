import { and, desc, eq, gte } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, isDatabaseConfigured } from "@/db";
import { morningEvents, userState } from "@/db/schema";
import {
  computeBodyPartStats,
  neglectedParts,
  type BodyPartStat,
  type StatSession,
} from "@/app/lib/bodyPartStats";
import { inferBodyPart, type BodyPart } from "@/app/lib/bodyPart";
import {
  canonicalNameMap,
  normalizeExerciseName,
} from "@/app/lib/exerciseName";

// Same fixed coach model as the morning coach so every environment behaves identically.
const OPENAI_MODEL = "gpt-5.6-luna";

type PostedSet = {
  weight?: number;
  reps?: number;
  done?: boolean;
  distanceKm?: number;
};

type PostedExercise = {
  name?: string;
  metric?: string;
  assisted?: boolean;
  bodyPart?: BodyPart; // 수동 교정 우선 (I3)
  sets?: PostedSet[];
};

type PostedSession = {
  date?: string;
  exercises?: PostedExercise[];
};

type BodyweightEntry = {
  date: string;
  kg: number;
};

type LiftPoint = {
  date: string;
  topWeight: number;
  repsAtTop: number;
  e1rm: number;
  volume: number;
  topReps?: number; // bodyweight(맨몸) 종목의 그날 최고 반복수
};

type LiftSeries = {
  name: string;
  sessions: number;
  // "load": 중량 종목(e1rm 기준) · "reps": 맨몸 종목(topReps 기준)
  kind: "load" | "reps";
  points: LiftPoint[];
};

type DistanceSeries = {
  name: string;
  sessions: number;
  points: Array<{ date: string; km: number }>;
};

type RegionKey = "upper" | "lower" | "core";

type RegionStat = {
  parts: BodyPart[];
  weeklySets: number;
  weeklyVolume: number;
  monthlyVolume: number;
  freq7: number;
  freq28: number;
};

// 최근 28일 실제 수행 종목 인벤토리(top-8 시계열인 lifts와 별개). 종목 선택 평가 근거.
type ExerciseInventoryItem = {
  name: string;
  part: BodyPart;
  metric: string;
  assisted: boolean;
  sessions28: number;
  sets28: number;
};

const REGION_PARTS: Record<RegionKey, BodyPart[]> = {
  upper: ["가슴", "등", "어깨", "팔"],
  lower: ["허벅지", "종아리"],
  core: ["복근", "허리"],
};

type TrainingStats = {
  totalSessions: number;
  firstDate: string | null;
  lastDate: string | null;
  sessionsLast7Days: number;
  sessionsLast28Days: number;
  trackingDays: number;
  perWeekRecent: number;
  lifts: LiftSeries[];
  cardio: DistanceSeries[];
  bodyParts: BodyPartStat[]; // 부위 단위 집계(신규 도배 해결·밸런스/방치 분석)
  neglected: BodyPart[];
  regions: Record<RegionKey, RegionStat>; // 상체/하체/코어 합산(분리 진단 근거)
  exercises: ExerciseInventoryItem[];
};

type TrainingReport = {
  headline: string;
  overall: string;
  frequencyComment: string;
  balanceSummary: string; // 부위별 주간 볼륨 밸런스 1~2문장
  upperBody: string; // 상체 진단 (가슴/등/어깨/팔)
  lowerBody: string; // 하체 진단 (사두/후면/종아리)
  efficiencyVerdict: string; // "지금 제대로 하고 있나" 한 줄 총평
  exerciseSelection: Array<{
    name: string;
    verdict: "keep" | "swap" | "drop";
    reason: string;
  }>;
  neglectNote: string; // 약점·방치 부위 경고 + 왜 (없으면 "")
  bodyweightNote: string; // 체중·총볼륨 추세 (없으면 "")
  liftAnalysis: Array<{
    name: string;
    trend: "up" | "flat" | "down" | "new";
    comment: string;
  }>;
  actionItems: string[];
  warning: string;
};

type OpenAIResponse = {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string; refusal?: string }>;
  }>;
  error?: { message?: string };
};

const responseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    headline: { type: "string" },
    overall: { type: "string" },
    frequencyComment: { type: "string" },
    balanceSummary: { type: "string" },
    upperBody: { type: "string" },
    lowerBody: { type: "string" },
    efficiencyVerdict: { type: "string" },
    exerciseSelection: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          verdict: { type: "string", enum: ["keep", "swap", "drop"] },
          reason: { type: "string" },
        },
        required: ["name", "verdict", "reason"],
      },
    },
    neglectNote: { type: "string" },
    bodyweightNote: { type: "string" },
    liftAnalysis: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          trend: { type: "string", enum: ["up", "flat", "down", "new"] },
          comment: { type: "string" },
        },
        required: ["name", "trend", "comment"],
      },
    },
    actionItems: { type: "array", maxItems: 3, items: { type: "string" } },
    warning: { type: "string" },
  },
  required: [
    "headline",
    "overall",
    "frequencyComment",
    "balanceSummary",
    "upperBody",
    "lowerBody",
    "efficiencyVerdict",
    "exerciseSelection",
    "neglectNote",
    "bodyweightNote",
    "liftAnalysis",
    "actionItems",
    "warning",
  ],
} as const;

const systemPrompt = `당신은 EVERYONE BUT YOU의 불꽃 스파르타 스트렝스 코치다. 주간 심층 리포트를 쓴다.

★ 사용자 프로필(고정): 마른 체형이라 "몸을 크게" 키우고 싶다. 목표는 전신 근비대 — 두께(등·가슴·후면사슬 density: 로우·데드)와 너비(어깨 측면·광배 V테이퍼: 사이드레이즈·랫). "전체 골고루".
→ 리포트의 렌즈는 부위 균형·볼륨이다. 방치 부위를 콕 집고, 각 판정/처방에 "왜 그게 두께/너비에 필요한지" 원리를 한 줄로 붙여라(해부·근비대 논리). 지식 트레이너처럼.

입력(stats): 서버가 계산한 실수치. 지어내기 금지, 있는 값만 인용.
- stats.bodyParts: 근육 8부위별 { part, weeklyVolume(최근7일: 중량=Σ중량×반복, 맨몸=Σ반복), weeklySets, monthlyVolume, freq7/freq28(세션수), lastTrainedDate, daysSinceLast(null=28일 기록없음), trend(up/flat/down/new) }. weeklyVolume 내림차순 → 편중/방치가 한눈에.
- stats.neglected: 방치 부위 목록(28일 공백이거나 10일+). ← 최우선으로 다뤄라.
- stats.regions: 상체(가슴·등·어깨·팔), 하체(허벅지·종아리), 코어(복근·허리)별 { parts, weeklySets, weeklyVolume, monthlyVolume, freq7, freq28 }. 상체/하체 진단과 볼륨 비율의 근거다.
- stats.exercises: 최근 28일 실제 수행한 전체 종목 인벤토리(최대 30) { name, part, metric, assisted, sessions28, sets28 }. 종목 선택 평가는 이 목록 전체를 근거로 한다.
- stats.lifts[]: 종목별 시계열(kind=load는 e1rm, kind=reps 맨몸은 topReps). kind=load에는 어시스티드 맨몸 운동도 포함(부하=체중−보조kg, 보조↓=성장). 보조 detail로만.
- stats.perWeekRecent/trackingDays: 빈도. bodyweight: { latest, deltaVs4wk(4주 전 대비 증감kg, null=비교불가), points } 또는 null.

출력 필드(반드시 부위 단위가 1차, 종목은 보조):
- headline: 24자 이내 핵심 판정(부위 편중/방치를 반영. 예: "등은 폭발, 어깨·후면이 발목").
- overall: 3문장 이내. 전반 상태 + 목표(크게/두께/너비) 대비 어디가 되고 어디가 구멍인지.
- balanceSummary: 부위별 주간 볼륨 밸런스 1~2문장. bodyParts 근거로 "어디 편중, 어디 부족"을 수치와 함께. (예: "등·허벅지에 볼륨 몰림, 어깨·복근·허리는 바닥.")
- upperBody: 상체 진단 2~3문장. 가슴·등·어깨·팔 각각 되는 곳과 구멍을 짚고, 두께(로우·수평당기기)와 너비(측면삼각근·수직당기기) 관점으로 판정.
- lowerBody: 하체 진단 2~3문장. 대퇴사두, 후면(햄스트링·둔근·힙힌지), 종아리 커버 여부를 짚고 상체 대비 볼륨 비율을 언급.
- efficiencyVerdict: "지금 제대로 하고 있나"에 답하는 한 줄 총평. 핵심 종목과 시간이 새는 종목을 구체적으로 지목.
- exerciseSelection: 최대 6개. stats.exercises에 있는 실제 종목명만 name에 쓰고, verdict는 keep/swap/drop만 허용. keep은 시간 대비 효율 높은 핵심 종목과 그 이유, swap은 같은 시간에 더 많이 붙는 대체가 있을 때 reason에 "X 대신 Y"를 명시, drop은 중복·저효율이라 빼도 되는 이유를 한 줄로 작성.
- neglectNote: neglected/저볼륨 부위 경고 + 왜(두께·너비 논리). 없으면 "". (예: "어깨 측면 방치—V너비는 측면 삼각근이 프레임을 벌려야 나온다. 데드 없어 기립근 두께도 빠짐.")
- bodyweightNote: bodyweight 있으면 체중·총볼륨 추세 + 왜(벌크 목표라 체중이 재료). deltaVs4wk≤0이고 볼륨은 느는데 체중 정체면 "식사가 병목". 없으면 "체중도 기록하면 벌크 속도를 봐줄게" 한 줄 or "".
- liftAnalysis: 종목별 trend/comment(최대 4, kind=load는 e1rm 흐름, reps는 topReps). 정체·하락엔 구체 처방(+2.5kg or 반복+1 or 세트+ or 부위 빈도↑). 보조.
- actionItems: 다음 7일 실행 구체 행동 최대 3개. 방치 부위 보완을 우선. "열심히" 같은 추상 금지.
- warning: 안전 주의 한 문장, 없으면 "".

규칙:
- 빈도 판정: trackingDays<14면 낙제 판정 금지("첫 페이스 쌓는 중"), 14+면 주3+ 좋음/주2 최소선/주1↓ 부족.
- 데이터 적으면(세션<4 또는 bodyParts 대부분 0) 판정 유보 + 데이터 쌓는 법. 1RM 실측·통증 진단 금지, 증량 5% 초과 금지.
- 종목 선택의 기준은 시간 대비 근비대 효율이다. 다관절 복합운동을 1순위로 보되 고립운동을 일괄 저효율로 판정하지 마라.
- 먼저 수평밀기·수직밀기·수평당기기·수직당기기·스쿼트·힙힌지·종아리 패턴 커버리지를 본다. 빈 패턴이 있으면 그 패턴이 고립운동보다 우선이므로 내전/외전 머신, 중복 컬 같은 저효율 종목과 맞바꾸는 swap으로만 제안한다.
- 패턴이 모두 채워졌다면 약한 부위 고립운동은 keep할 수 있다. 예를 들어 스쿼트 뒤 레그 익스텐션 마무리는 유효하다. 고립운동이 최다 빈도인데 큰 패턴이 비었다면 단순히 빼라고 하지 말고 순서·세트를 줄여 빈 패턴에 자리를 내주라고 해라.
- 같은 패턴의 중복은 drop이다. 컬 3종, 풀다운과 암풀다운 같은 중복을 점검한다. 이상적인 전체 종목 수는 8~10종이다.
- add verdict는 없다. 리포트 어느 필드에서도 종목 "추가"를 처방하지 말고, 빠진 패턴은 반드시 기존 저효율 종목을 밀어내는 swap으로만 제안한다. 총 종목 수를 늘리지 마라.
- stats.exercises 전체를 근거로 판단하고, 목록에 없는 종목을 사용자가 하고 있다고 말하지 마라. exerciseSelection.name은 반드시 목록의 name과 정확히 같아야 한다.
- 어조: 스파르타("가자","쥐어짜","챔피언"), 비아냥·모욕 금지. 관찰된 사실 최소 한 조각 정확 인용.`;

const dateKeyInSeoul = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const shiftSeoulDateKey = (days: number) => {
  const date = new Date(`${dateKeyInSeoul()}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const ownerId = () => process.env.FIRST_REP_OWNER_ID ?? "local-owner";

const round1 = (value: number) => Math.round(value * 10) / 10;

const bodyweightForDate = (
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

function buildStats(
  history: PostedSession[],
  bodyweightLog: BodyweightEntry[],
): TrainingStats {
  const sessions = history
    .filter(
      (session) =>
        typeof session.date === "string" && Array.isArray(session.exercises),
    )
    .map((session) => ({
      date: String(session.date).slice(0, 10),
      exercises: session.exercises ?? [],
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const canonicalNames = canonicalNameMap(
    sessions.flatMap((session) =>
      session.exercises.map((exercise) =>
        String(exercise.name ?? "")
          .trim()
          .slice(0, 60),
      ),
    ),
  );

  // Cutoffs are compared with >= and today counts, so -6/-27 give exact 7/28-day windows.
  const last7Cutoff = shiftSeoulDateKey(-6);
  const last28Cutoff = shiftSeoulDateKey(-27);

  const liftMap = new Map<string, Map<string, LiftPoint>>();
  const bwMap = new Map<string, Map<string, LiftPoint>>();
  const cardioMap = new Map<string, Map<string, number>>();

  for (const session of sessions) {
    for (const exercise of session.exercises) {
      const name = String(exercise.name ?? "")
        .trim()
        .slice(0, 60);
      if (!name) continue;
      const normalizedName = normalizeExerciseName(name);
      const doneSets = (exercise.sets ?? []).filter(
        (set) => set?.done !== false,
      );
      if (doneSets.length === 0) continue;

      if (exercise.metric === "distance") {
        const km = doneSets.reduce(
          (sum, set) => sum + (Number(set.distanceKm) || 0),
          0,
        );
        if (km <= 0) continue;
        const byDate =
          cardioMap.get(normalizedName) ?? new Map<string, number>();
        byDate.set(session.date, round1((byDate.get(session.date) ?? 0) + km));
        cardioMap.set(normalizedName, byDate);
        continue;
      }

      if (exercise.metric === "bodyweight") {
        const bodyweight =
          exercise.assisted === true
            ? bodyweightForDate(bodyweightLog, session.date)
            : null;
        if (exercise.assisted === true && bodyweight !== null) {
          let topWeight = 0;
          let repsAtTop = 0;
          let volume = 0;
          for (const set of doneSets) {
            const reps = Number(set.reps) || 0;
            if (reps <= 0) continue;
            const assist = Math.max(Number(set.weight) || 0, 0);
            const effectiveLoad = Math.max(bodyweight - assist, 1);
            volume += effectiveLoad * reps;
            if (effectiveLoad > topWeight) {
              topWeight = effectiveLoad;
              repsAtTop = reps;
            }
          }
          if (topWeight <= 0) continue;
          const point: LiftPoint = {
            date: session.date,
            topWeight: round1(topWeight),
            repsAtTop,
            e1rm: round1(topWeight * (1 + repsAtTop / 30)),
            volume: Math.round(volume),
          };
          const byDate =
            liftMap.get(normalizedName) ?? new Map<string, LiftPoint>();
          const existing = byDate.get(session.date);
          if (!existing) {
            byDate.set(session.date, point);
          } else {
            const best = point.e1rm > existing.e1rm ? point : existing;
            byDate.set(session.date, {
              ...best,
              volume: existing.volume + point.volume,
            });
          }
          liftMap.set(normalizedName, byDate);
          continue;
        }

        // 기존 맨몸: reps가 진행 지표. weight는 추가중량(있으면 보조).
        let topReps = 0;
        let addedAtTop = 0;
        let repVolume = 0;
        for (const set of doneSets) {
          const reps = Number(set.reps) || 0;
          // assisted인데 체중 로그가 없어 이 폴백에 온 경우: weight는 "보조량"이므로
          // 추가중량(+kg)으로 오해되지 않게 0 처리(부호 반전 방지).
          const added =
            exercise.assisted === true ? 0 : Number(set.weight) || 0;
          if (reps <= 0) continue;
          repVolume += reps;
          if (reps > topReps) {
            topReps = reps;
            addedAtTop = added;
          }
        }
        if (topReps <= 0) continue;
        const point: LiftPoint = {
          date: session.date,
          topWeight: addedAtTop,
          repsAtTop: topReps,
          e1rm: 0,
          volume: repVolume,
          topReps,
        };
        const byDate =
          bwMap.get(normalizedName) ?? new Map<string, LiftPoint>();
        const existing = byDate.get(session.date);
        if (!existing) {
          byDate.set(session.date, point);
        } else {
          const best =
            (point.topReps ?? 0) > (existing.topReps ?? 0) ? point : existing;
          byDate.set(session.date, {
            ...best,
            volume: existing.volume + point.volume,
          });
        }
        bwMap.set(normalizedName, byDate);
        continue;
      }

      let topWeight = 0;
      let repsAtTop = 0;
      let volume = 0;
      for (const set of doneSets) {
        const weight = Number(set.weight) || 0;
        const reps = Number(set.reps) || 0;
        if (weight <= 0 || reps <= 0) continue;
        volume += weight * reps;
        if (weight > topWeight) {
          topWeight = weight;
          repsAtTop = reps;
        }
      }
      if (topWeight <= 0) continue;
      const point: LiftPoint = {
        date: session.date,
        topWeight,
        repsAtTop,
        e1rm: round1(topWeight * (1 + repsAtTop / 30)),
        volume: Math.round(volume),
      };
      const byDate =
        liftMap.get(normalizedName) ?? new Map<string, LiftPoint>();
      const existing = byDate.get(session.date);
      if (!existing) {
        byDate.set(session.date, point);
      } else {
        // Same lift logged twice on one date: keep the best top set, sum the volume.
        const best = point.e1rm > existing.e1rm ? point : existing;
        byDate.set(session.date, {
          ...best,
          volume: existing.volume + point.volume,
        });
      }
      liftMap.set(normalizedName, byDate);
    }
  }

  const toSeries = (
    map: Map<string, Map<string, LiftPoint>>,
    kind: "load" | "reps",
  ): LiftSeries[] =>
    [...map.entries()].map(([normalizedName, byDate]) => ({
      name: canonicalNames.get(normalizedName) ?? normalizedName,
      sessions: byDate.size,
      kind,
      points: [...byDate.values()]
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-12),
    }));

  const lifts: LiftSeries[] = [
    ...toSeries(liftMap, "load"),
    ...toSeries(bwMap, "reps"),
  ]
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 8);

  const cardio: DistanceSeries[] = [...cardioMap.entries()]
    .map(([normalizedName, byDate]) => ({
      name: canonicalNames.get(normalizedName) ?? normalizedName,
      sessions: byDate.size,
      points: [...byDate.entries()]
        .map(([date, km]) => ({ date, km }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-12),
    }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 3);

  const sessionsLast28Days = sessions.filter(
    (session) => session.date >= last28Cutoff,
  ).length;
  const firstDate = sessions[0]?.date ?? null;
  const daysBetween = (from: string, to: string) =>
    Math.floor(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        86_400_000,
    );
  const trackingDays = firstDate
    ? Math.min(28, Math.max(0, daysBetween(firstDate, dateKeyInSeoul())) + 1)
    : 0;
  const effectiveWeeks = Math.max(1, trackingDays / 7);

  const bodyParts = computeBodyPartStats(
    history as StatSession[],
    dateKeyInSeoul(),
  );

  // 상체/하체/코어 합산 + 최근 28일 종목 인벤토리(모델의 종목 선택 평가 근거).
  const regionKeys = Object.keys(REGION_PARTS) as RegionKey[];
  const regionOf = (part: BodyPart): RegionKey | null =>
    regionKeys.find((key) => REGION_PARTS[key].includes(part)) ?? null;
  const regionDays: Record<RegionKey, { d7: Set<string>; d28: Set<string> }> =
    { upper: { d7: new Set(), d28: new Set() },
      lower: { d7: new Set(), d28: new Set() },
      core: { d7: new Set(), d28: new Set() } };
  const inventory = new Map<
    string,
    Omit<ExerciseInventoryItem, "sessions28"> & { dates: Set<string> }
  >();
  for (const session of sessions) {
    if (session.date < last28Cutoff) continue;
    for (const exercise of session.exercises) {
      const name = String(exercise.name ?? "")
        .trim()
        .slice(0, 60);
      if (!name) continue;
      const normalizedName = normalizeExerciseName(name);
      const doneSets = (exercise.sets ?? []).filter(
        (set) => set?.done !== false,
      );
      if (doneSets.length === 0) continue;
      const part = exercise.bodyPart ?? inferBodyPart(name);
      const item = inventory.get(normalizedName) ?? {
        name: canonicalNames.get(normalizedName) ?? name,
        part,
        metric: String(exercise.metric ?? "weight"),
        assisted: exercise.assisted === true,
        sets28: 0,
        dates: new Set<string>(),
      };
      item.dates.add(session.date);
      item.sets28 += doneSets.length;
      inventory.set(normalizedName, item);
      if (exercise.metric === "distance") continue;
      if (!doneSets.some((set) => (Number(set.reps) || 0) > 0)) continue;
      const region = regionOf(part);
      if (!region) continue;
      regionDays[region].d28.add(session.date);
      if (session.date >= last7Cutoff) regionDays[region].d7.add(session.date);
    }
  }
  const regions = Object.fromEntries(
    regionKeys.map((key) => {
      const stats = bodyParts.filter((stat) =>
        REGION_PARTS[key].includes(stat.part),
      );
      const sum = (pick: (stat: BodyPartStat) => number) =>
        stats.reduce((total, stat) => total + pick(stat), 0);
      const region: RegionStat = {
        parts: REGION_PARTS[key],
        weeklySets: sum((stat) => stat.weeklySets),
        weeklyVolume: sum((stat) => stat.weeklyVolume),
        monthlyVolume: sum((stat) => stat.monthlyVolume),
        freq7: regionDays[key].d7.size,
        freq28: regionDays[key].d28.size,
      };
      return [key, region];
    }),
  ) as Record<RegionKey, RegionStat>;
  const exercises: ExerciseInventoryItem[] = [...inventory.values()]
    .map(({ dates, ...item }) => ({ ...item, sessions28: dates.size }))
    .sort((a, b) => b.sessions28 - a.sessions28)
    .slice(0, 30);

  return {
    totalSessions: sessions.length,
    firstDate,
    lastDate: sessions.at(-1)?.date ?? null,
    sessionsLast7Days: sessions.filter((session) => session.date >= last7Cutoff)
      .length,
    sessionsLast28Days,
    trackingDays,
    perWeekRecent: round1(sessionsLast28Days / effectiveWeeks),
    lifts,
    cardio,
    bodyParts,
    neglected: neglectedParts(bodyParts),
    regions,
    exercises,
  };
}

async function getRecentCheckins(): Promise<
  Array<{ date: string; decision: string }>
> {
  if (!isDatabaseConfigured()) return [];
  try {
    const cutoff = shiftSeoulDateKey(-30);
    const rows = await getDb()
      .select({
        date: morningEvents.eventDate,
        decision: morningEvents.decision,
      })
      .from(morningEvents)
      .where(
        and(
          eq(morningEvents.ownerId, ownerId()),
          gte(morningEvents.eventDate, cutoff),
        ),
      )
      .orderBy(desc(morningEvents.eventDate))
      .limit(30);
    return rows.map((row) => ({ date: row.date, decision: row.decision }));
  } catch {
    return [];
  }
}

type BodyweightTrend = {
  latest: number;
  deltaVs4wk: number | null;
  points: number;
} | null;

async function getBodyweightLog(): Promise<BodyweightEntry[]> {
  if (!isDatabaseConfigured()) return [];
  try {
    const [row] = await getDb()
      .select({ bw: userState.bodyweightLog })
      .from(userState)
      .where(eq(userState.ownerId, ownerId()))
      .limit(1);
    return (Array.isArray(row?.bw) ? row.bw : [])
      .filter(
        (e): e is BodyweightEntry =>
          !!e && typeof e.date === "string" && Number.isFinite(e.kg),
      )
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

function getBodyweightTrend(log: BodyweightEntry[]): BodyweightTrend {
  if (log.length === 0) return null;
  const latest = log[log.length - 1];
  const cutoff = shiftSeoulDateKey(-28);
  const past = log.find((entry) => entry.date >= cutoff) ?? log[0];
  return {
    latest: latest.kg,
    deltaVs4wk:
      past.date !== latest.date
        ? Math.round((latest.kg - past.kg) * 10) / 10
        : null,
    points: log.length,
  };
}

const extractOutputText = (response: OpenAIResponse) => {
  if (response.output_text) return response.output_text;
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) return content.text;
      if (content.refusal) throw new Error(content.refusal);
    }
  }
  return "";
};

const isTrainingReport = (value: unknown): value is TrainingReport => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TrainingReport>;
  return (
    typeof candidate.headline === "string" &&
    typeof candidate.overall === "string" &&
    typeof candidate.frequencyComment === "string" &&
    typeof candidate.balanceSummary === "string" &&
    typeof candidate.upperBody === "string" &&
    typeof candidate.lowerBody === "string" &&
    typeof candidate.efficiencyVerdict === "string" &&
    Array.isArray(candidate.exerciseSelection) &&
    candidate.exerciseSelection.every(
      (item) =>
        item &&
        typeof item.name === "string" &&
        (item.verdict === "keep" ||
          item.verdict === "swap" ||
          item.verdict === "drop") &&
        typeof item.reason === "string",
    ) &&
    typeof candidate.neglectNote === "string" &&
    typeof candidate.bodyweightNote === "string" &&
    Array.isArray(candidate.liftAnalysis) &&
    candidate.liftAnalysis.every(
      (item) =>
        item &&
        typeof item.name === "string" &&
        (item.trend === "up" ||
          item.trend === "flat" ||
          item.trend === "down" ||
          item.trend === "new") &&
        typeof item.comment === "string",
    ) &&
    Array.isArray(candidate.actionItems) &&
    candidate.actionItems.every((item) => typeof item === "string") &&
    typeof candidate.warning === "string"
  );
};

async function generateReport(
  apiKey: string,
  stats: TrainingStats,
  recentCheckins: Array<{ date: string; decision: string }>,
  bodyweight: BodyweightTrend,
): Promise<TrainingReport> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const openAIResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        store: false,
        reasoning: { effort: "medium" },
        // medium reasoning tokens count toward this budget; raise it so the JSON output
        // isn't truncated by reasoning consumption (was 1200 under low effort).
        max_output_tokens: 3200,
        input: [
          { role: "developer", content: systemPrompt },
          {
            role: "user",
            content: JSON.stringify({
              today: dateKeyInSeoul(),
              stats,
              bodyweight,
              recentCheckins,
            }),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "first_rep_training_report",
            strict: true,
            schema: responseSchema,
          },
        },
      }),
      signal: controller.signal,
    });

    const data = (await openAIResponse.json()) as OpenAIResponse;
    if (!openAIResponse.ok) {
      throw new Error(
        data.error?.message ?? "OpenAI 응답을 가져오지 못했습니다.",
      );
    }

    const parsed = JSON.parse(extractOutputText(data)) as unknown;
    if (!isTrainingReport(parsed)) {
      throw new Error("OpenAI 응답 스키마가 올바르지 않습니다.");
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(request: Request) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && origin !== requestUrl.origin) {
    return NextResponse.json(
      { error: "허용되지 않은 요청입니다." },
      { status: 403 },
    );
  }

  const rawBody = await request.text();
  if (rawBody.length > 400_000) {
    return NextResponse.json(
      { error: "운동 기록이 너무 큽니다." },
      { status: 413 },
    );
  }

  let body: { history?: unknown };
  try {
    body = JSON.parse(rawBody) as { history?: unknown };
  } catch {
    return NextResponse.json(
      { error: "요청 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.history)) {
    return NextResponse.json(
      { error: "운동 기록 배열이 필요합니다." },
      { status: 400 },
    );
  }

  const bodyweightLog = await getBodyweightLog();
  const stats = buildStats(body.history as PostedSession[], bodyweightLog);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "OpenAI API 키가 아직 설정되지 않았습니다.",
        code: "openai_not_configured",
        stats,
      },
      { status: 503 },
    );
  }

  const recentCheckins = await getRecentCheckins();
  const bodyweight = getBodyweightTrend(bodyweightLog);

  try {
    const report = await generateReport(
      apiKey,
      stats,
      recentCheckins,
      bodyweight,
    );
    return NextResponse.json({ report, stats, model: OPENAI_MODEL });
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "OpenAI 응답 시간이 초과됐습니다."
        : "훈련 분석을 만들지 못했습니다.";
    return NextResponse.json({ error: message, stats }, { status: 502 });
  }
}
