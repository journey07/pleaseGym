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
import type { BodyPart } from "@/app/lib/bodyPart";

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
  bodyPart?: BodyPart; // 수동 교정 우선 (I3)
  sets?: PostedSet[];
};

type PostedSession = {
  date?: string;
  exercises?: PostedExercise[];
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
};

type TrainingReport = {
  headline: string;
  overall: string;
  frequencyComment: string;
  balanceSummary: string; // 부위별 주간 볼륨 밸런스 1~2문장
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
    neglectNote: { type: "string" },
    bodyweightNote: { type: "string" },
    liftAnalysis: {
      type: "array",
      maxItems: 6,
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
- stats.lifts[]: 종목별 시계열(kind=load는 e1rm, kind=reps 맨몸은 topReps). 보조 detail로만.
- stats.perWeekRecent/trackingDays: 빈도. bodyweight: { latest, deltaVs4wk(4주 전 대비 증감kg, null=비교불가), points } 또는 null.

출력 필드(반드시 부위 단위가 1차, 종목은 보조):
- headline: 24자 이내 핵심 판정(부위 편중/방치를 반영. 예: "등은 폭발, 어깨·후면이 발목").
- overall: 3문장 이내. 전반 상태 + 목표(크게/두께/너비) 대비 어디가 되고 어디가 구멍인지.
- balanceSummary: 부위별 주간 볼륨 밸런스 1~2문장. bodyParts 근거로 "어디 편중, 어디 부족"을 수치와 함께. (예: "등·허벅지에 볼륨 몰림, 어깨·복근·허리는 바닥.")
- neglectNote: neglected/저볼륨 부위 경고 + 왜(두께·너비 논리). 없으면 "". (예: "어깨 측면 방치—V너비는 측면 삼각근이 프레임을 벌려야 나온다. 데드 없어 기립근 두께도 빠짐.")
- bodyweightNote: bodyweight 있으면 체중·총볼륨 추세 + 왜(벌크 목표라 체중이 재료). deltaVs4wk≤0이고 볼륨은 느는데 체중 정체면 "식사가 병목". 없으면 "체중도 기록하면 벌크 속도를 봐줄게" 한 줄 or "".
- liftAnalysis: 종목별 trend/comment(최대 6, kind=load는 e1rm 흐름, reps는 topReps). 정체·하락엔 구체 처방(+2.5kg or 반복+1 or 세트+ or 부위 빈도↑). 보조.
- actionItems: 다음 7일 실행 구체 행동 최대 3개. 방치 부위 보완을 우선. "열심히" 같은 추상 금지.
- warning: 안전 주의 한 문장, 없으면 "".

규칙:
- 빈도 판정: trackingDays<14면 낙제 판정 금지("첫 페이스 쌓는 중"), 14+면 주3+ 좋음/주2 최소선/주1↓ 부족.
- 데이터 적으면(세션<4 또는 bodyParts 대부분 0) 판정 유보 + 데이터 쌓는 법. 1RM 실측·통증 진단 금지, 증량 5% 초과 금지.
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

function buildStats(history: PostedSession[]): TrainingStats {
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
        const byDate = cardioMap.get(name) ?? new Map<string, number>();
        byDate.set(session.date, round1((byDate.get(session.date) ?? 0) + km));
        cardioMap.set(name, byDate);
        continue;
      }

      if (exercise.metric === "bodyweight") {
        // 맨몸: reps가 진행 지표. weight는 추가중량(있으면 보조).
        let topReps = 0;
        let addedAtTop = 0;
        let repVolume = 0;
        for (const set of doneSets) {
          const reps = Number(set.reps) || 0;
          const added = Number(set.weight) || 0;
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
        const byDate = bwMap.get(name) ?? new Map<string, LiftPoint>();
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
        bwMap.set(name, byDate);
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
      const byDate = liftMap.get(name) ?? new Map<string, LiftPoint>();
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
      liftMap.set(name, byDate);
    }
  }

  const toSeries = (
    map: Map<string, Map<string, LiftPoint>>,
    kind: "load" | "reps",
  ): LiftSeries[] =>
    [...map.entries()].map(([name, byDate]) => ({
      name,
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
    .map(([name, byDate]) => ({
      name,
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

async function getBodyweightTrend(): Promise<BodyweightTrend> {
  if (!isDatabaseConfigured()) return null;
  try {
    const [row] = await getDb()
      .select({ bw: userState.bodyweightLog })
      .from(userState)
      .where(eq(userState.ownerId, ownerId()))
      .limit(1);
    const log = (Array.isArray(row?.bw) ? row.bw : []).filter(
      (e): e is { date: string; kg: number } =>
        !!e && typeof e.date === "string" && Number.isFinite(e.kg),
    );
    if (log.length === 0) return null;
    const sorted = [...log].sort((a, b) => a.date.localeCompare(b.date));
    const latest = sorted[sorted.length - 1];
    const cutoff = shiftSeoulDateKey(-28);
    const past = sorted.find((e) => e.date >= cutoff) ?? sorted[0];
    return {
      latest: latest.kg,
      deltaVs4wk:
        past && past.date !== latest.date
          ? Math.round((latest.kg - past.kg) * 10) / 10
          : null,
      points: sorted.length,
    };
  } catch {
    return null;
  }
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
        max_output_tokens: 2400,
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

  const stats = buildStats(body.history as PostedSession[]);

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

  const [recentCheckins, bodyweight] = await Promise.all([
    getRecentCheckins(),
    getBodyweightTrend(),
  ]);

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
