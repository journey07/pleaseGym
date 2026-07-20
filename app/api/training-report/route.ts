import { and, desc, eq, gte } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, isDatabaseConfigured } from "@/db";
import { morningEvents } from "@/db/schema";

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
};

type LiftSeries = {
  name: string;
  sessions: number;
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
  perWeekLast4: number;
  lifts: LiftSeries[];
  cardio: DistanceSeries[];
};

type TrainingReport = {
  headline: string;
  overall: string;
  frequencyComment: string;
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
    "liftAnalysis",
    "actionItems",
    "warning",
  ],
} as const;

const systemPrompt = `당신은 FIRST REP의 스트렝스 코치다. 유일한 관심사는 사용자의 근력과 근육량을 늘리는 것이다.
입력으로 서버가 미리 계산한 훈련 통계(stats)와 최근 아침 체크인 이력(recentCheckins)을 받는다. 이 수치들만 근거로 훈련 상태를 판정하라.

stats 설명:
- perWeekLast4: 최근 4주 평균 주당 세션 수. sessionsLast7Days/28Days도 참고.
- lifts[].points: 날짜별 최고 세트(topWeight×repsAtTop), 추정 1RM(e1rm, Epley), 그 날의 총볼륨(volume=Σ중량×반복). 시간순 정렬.
- cardio[].points: 날짜별 유산소 거리(km).

판정 규칙:
- 빈도: 근성장 기준으로 주 3회 이상이면 좋음, 주 2회는 유지 최소선, 주 1회 이하는 성장에 부족하다고 명확히 말한다.
- 종목별 trend: e1rm 흐름이 최근에 올라가면 up, 2~3주 이상 같은 수준이면 flat(정체), 내려가면 down, 데이터가 2회 이하면 new. 수치를 지어내지 말고 points에 있는 값만 인용한다.
- 정체(flat)나 하락(down)에는 반드시 구체 처방을 단다: 다음 세션에 +2.5kg 또는 반복 +1, 세트 추가, 해당 부위 빈도 증가 중 하나.
- 볼륨이 빈도와 함께 늘고 있는지 언급한다. 상승 중이면 무엇이 효과를 내는지 짚는다.
- actionItems: 다음 7일 안에 실행 가능한 구체 행동만, 최대 3개. "열심히 하기" 같은 추상 조언 금지.
- 최대중량(1RM) 실측 테스트를 권하지 않는다. 통증 진단·치료를 하지 않는다. 무리한 증량(한 번에 5% 초과)을 권하지 않는다.
- 어조: 한국어, 짧고 단호, 데이터 기반, 비난 없이. headline은 24자 이내 핵심 판정. overall은 세 문장 이내.
- 데이터가 적으면(세션 4회 미만) 판정을 유보하고 데이터를 쌓는 법을 안내한다.
- warning: 안전상 주의가 필요할 때 한 문장, 없으면 빈 문자열.`;

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

  const lifts: LiftSeries[] = [...liftMap.entries()]
    .map(([name, byDate]) => ({
      name,
      sessions: byDate.size,
      points: [...byDate.values()]
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-12),
    }))
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

  return {
    totalSessions: sessions.length,
    firstDate: sessions[0]?.date ?? null,
    lastDate: sessions.at(-1)?.date ?? null,
    sessionsLast7Days: sessions.filter(
      (session) => session.date >= last7Cutoff,
    ).length,
    sessionsLast28Days,
    perWeekLast4: round1(sessionsLast28Days / 4),
    lifts,
    cardio,
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
        reasoning: { effort: "low" },
        max_output_tokens: 1200,
        input: [
          { role: "developer", content: systemPrompt },
          {
            role: "user",
            content: JSON.stringify({
              today: dateKeyInSeoul(),
              stats,
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

  const recentCheckins = await getRecentCheckins();

  try {
    const report = await generateReport(apiKey, stats, recentCheckins);
    return NextResponse.json({ report, stats, model: OPENAI_MODEL });
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "OpenAI 응답 시간이 초과됐습니다."
        : "훈련 분석을 만들지 못했습니다.";
    return NextResponse.json({ error: message, stats }, { status: 502 });
  }
}
