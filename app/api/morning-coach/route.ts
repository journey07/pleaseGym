import { and, desc, eq, gte } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, isDatabaseConfigured } from "@/db";
import { morningEvents, userState } from "@/db/schema";

// The coach model is fixed in code (not an env var) so every environment uses the same one.
const OPENAI_MODEL = "gpt-5.6-luna";

type Decision = "go" | "no_go";

type MorningCoachResponse = {
  decision: Decision;
  headline: string;
  message: string;
  planLabel: string;
  exercises: Array<{
    name: string;
    metric: "weight" | "distance";
    sets: number;
    reps: number;
    targetValue: number;
    unit: "kg" | "km";
  }>;
  nextAction: "start" | "minimum" | "rest";
  safetyNote: string;
  progressNote: string;
};

type CoachMemoryEntry = {
  date: string;
  decision: Decision;
  headline: string;
  nextAction: MorningCoachResponse["nextAction"];
  progressNote: string;
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
    decision: { type: "string", enum: ["go", "no_go"] },
    headline: { type: "string" },
    message: { type: "string" },
    planLabel: { type: "string" },
    exercises: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          metric: { type: "string", enum: ["weight", "distance"] },
          sets: { type: "integer", minimum: 1, maximum: 4 },
          reps: { type: "integer", minimum: 1, maximum: 30 },
          targetValue: { type: "number", minimum: 0 },
          unit: { type: "string", enum: ["kg", "km"] },
        },
        required: ["name", "metric", "sets", "reps", "targetValue", "unit"],
      },
    },
    nextAction: { type: "string", enum: ["start", "minimum", "rest"] },
    safetyNote: { type: "string" },
    progressNote: { type: "string" },
  },
  required: [
    "decision",
    "headline",
    "message",
    "planLabel",
    "exercises",
    "nextAction",
    "safetyNote",
    "progressNote",
  ],
} as const;

const systemPrompt = `당신은 FIRST REP의 아침 운동 코치다.
사용자가 오늘 운동하러 갈지 가지 않을지를 이미 결정했다. 결정을 존중하면서 바로 다음 행동 하나를 제시하라.

규칙:
- 한국어로 짧고 단호하지만 비난하지 않는다.
- go라면 최근 기록에 실제로 등장한 운동 또는 즐겨찾기 운동만 사용한다.
- 최근 기록이 부족하면 무게를 추측하지 말고 targetValue를 0으로 두어 현장에서 사용자가 입력하게 한다.
- 기록이 있더라도 최근 최고중량보다 공격적으로 올리지 않는다. 최대중량 테스트를 권하지 않는다.
- 운동은 최대 4개, 세트는 운동당 최대 4세트다.
- no_go라면 죄책감을 주지 않는다. 운동 계획을 만들지 말고 exercises는 빈 배열로 둔다.
- no_go의 nextAction은 minimum 또는 rest 중 하나다. minimum은 5분 이하의 가벼운 행동만 의미한다.
- 통증을 진단하거나 치료하지 않는다. 위험하거나 날카로운 통증이 있으면 운동 중단과 전문가 상담을 안내한다.
- headline은 18자 이내, message는 두 문장 이내, safetyNote는 한 문장 이내로 쓴다.

추가 입력을 활용한 고도화:
- recentCheckins: 최근 7일 아침 체크인 이력([{date, decision}]). go/no_go 패턴(연속 출석·연속 결석·복귀)을 읽고 오늘의 어조와 progressNote에 반영하라. 비어 있으면 무시한다.
- coachMemory: 지난 코칭 메모([{date, decision, headline, nextAction, progressNote}]). 과거 코칭 맥락과 모순되지 않게 이어가라. 비어 있으면 무시한다.

progressNote 규칙:
- go: 최근 기록·체크인 이력에서 실제로 관찰된 사실만 근거로 오늘의 강도/휴식 판단 이유를 한두 문장으로 밝힌다. 데이터가 부족하면 부족하다고 명시한다. 추측 금지, 최고중량 초과 목표의 근거로 쓰지 않는다.
- no_go: 진행도 분석 대상이 없으므로 짧은 격려 한 문장 또는 빈 문자열("")을 쓴다.`;

const getRuntimeSecret = (name: "OPENAI_API_KEY") => process.env[name];

const dateKeyInSeoul = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

// Shift a Seoul date key (YYYY-MM-DD) by a number of days, returning another date key.
const shiftSeoulDateKey = (days: number) => {
  const date = new Date(`${dateKeyInSeoul()}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const ownerId = () => process.env.FIRST_REP_OWNER_ID ?? "local-owner";

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

const isMorningCoachResponse = (
  value: unknown,
): value is MorningCoachResponse => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MorningCoachResponse>;
  return (
    (candidate.decision === "go" || candidate.decision === "no_go") &&
    typeof candidate.headline === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.planLabel === "string" &&
    Array.isArray(candidate.exercises) &&
    (candidate.nextAction === "start" ||
      candidate.nextAction === "minimum" ||
      candidate.nextAction === "rest") &&
    typeof candidate.safetyNote === "string" &&
    typeof candidate.progressNote === "string"
  );
};

async function storeMorningEvent(
  decision: Decision,
  model?: string,
  coachPlan?: MorningCoachResponse,
) {
  if (!isDatabaseConfigured()) return;
  const db = getDb();
  const eventDate = dateKeyInSeoul();
  const eventId = `${ownerId()}:${eventDate}`;
  const now = new Date();

  await db
    .insert(morningEvents)
    .values({
      id: eventId,
      ownerId: ownerId(),
      eventDate,
      decision,
      model: model ?? null,
      coachPlan: coachPlan
        ? (coachPlan as unknown as Record<string, unknown>)
        : null,
      decidedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [morningEvents.ownerId, morningEvents.eventDate],
      set: {
        decision,
        ...(model ? { model } : {}),
        ...(coachPlan
          ? { coachPlan: coachPlan as unknown as Record<string, unknown> }
          : {}),
        updatedAt: now,
      },
    });
}

// Today's committed check-in, if any. coachPlan is returned only when it passes the current schema
// (an older stored plan without progressNote is treated as "no plan" so the coach regenerates it).
async function getTodayMorningEvent(): Promise<{
  decision: Decision;
  model: string | null;
  coachPlan: MorningCoachResponse | null;
} | null> {
  if (!isDatabaseConfigured()) return null;
  try {
    const [row] = await getDb()
      .select()
      .from(morningEvents)
      .where(
        and(
          eq(morningEvents.ownerId, ownerId()),
          eq(morningEvents.eventDate, dateKeyInSeoul()),
        ),
      )
      .limit(1);
    if (!row) return null;
    if (row.decision !== "go" && row.decision !== "no_go") return null;
    const coachPlan =
      row.coachPlan && isMorningCoachResponse(row.coachPlan)
        ? row.coachPlan
        : null;
    return { decision: row.decision, model: row.model ?? null, coachPlan };
  } catch {
    return null;
  }
}

async function getRecentCheckins(): Promise<
  Array<{ date: string; decision: string }>
> {
  if (!isDatabaseConfigured()) return [];
  try {
    const cutoff = shiftSeoulDateKey(-7);
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
      // Newest first so a full window never truncates today's row before the limit.
      .orderBy(desc(morningEvents.eventDate))
      .limit(7);
    return rows.map((row) => ({ date: row.date, decision: row.decision }));
  } catch {
    return [];
  }
}

async function getCoachMemory(): Promise<unknown[]> {
  if (!isDatabaseConfigured()) return [];
  try {
    const [row] = await getDb()
      .select({ coachMemory: userState.coachMemory })
      .from(userState)
      .where(eq(userState.ownerId, ownerId()))
      .limit(1);
    const memory = Array.isArray(row?.coachMemory) ? row.coachMemory : [];
    return memory.slice(-5);
  } catch {
    return [];
  }
}

// Append one compact memory note for today, preserving workoutHistory/favorites (partial update only).
async function appendCoachMemory(plan: MorningCoachResponse) {
  if (!isDatabaseConfigured()) return;
  try {
    const db = getDb();
    const [row] = await db
      .select({ coachMemory: userState.coachMemory })
      .from(userState)
      .where(eq(userState.ownerId, ownerId()))
      .limit(1);
    const existing = Array.isArray(row?.coachMemory) ? row.coachMemory : [];
    const date = dateKeyInSeoul();
    const clip = (text: string) => text.slice(0, 200);
    const entry: CoachMemoryEntry = {
      date,
      decision: plan.decision,
      headline: clip(plan.headline),
      nextAction: plan.nextAction,
      progressNote: clip(plan.progressNote),
    };
    const withoutToday = existing.filter(
      (item) =>
        !(
          item &&
          typeof item === "object" &&
          (item as { date?: string }).date === date
        ),
    );
    const nextMemory = [...withoutToday, entry].slice(-30);
    const now = new Date();

    await db
      .insert(userState)
      .values({
        ownerId: ownerId(),
        coachMemory: nextMemory,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userState.ownerId,
        set: { coachMemory: nextMemory, updatedAt: now },
      });
  } catch {
    // Memory is best-effort — a failure here must not block the coach response.
  }
}

async function generateCoachPlan(
  apiKey: string,
  decision: Decision,
  context: unknown,
  recentCheckins: Array<{ date: string; decision: string }>,
  coachMemory: unknown[],
): Promise<MorningCoachResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

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
        max_output_tokens: 800,
        input: [
          { role: "developer", content: systemPrompt },
          {
            role: "user",
            content: JSON.stringify({
              decision,
              context: context ?? {},
              recentCheckins,
              coachMemory,
            }),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "first_rep_morning_coach",
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

    const outputText = extractOutputText(data);
    const parsed = JSON.parse(outputText) as unknown;
    if (!isMorningCoachResponse(parsed) || parsed.decision !== decision) {
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
  if (rawBody.length > 24_000) {
    return NextResponse.json(
      { error: "운동 기록이 너무 큽니다." },
      { status: 413 },
    );
  }

  let body: { decision?: Decision; context?: unknown };
  try {
    body = JSON.parse(rawBody) as { decision?: Decision; context?: unknown };
  } catch {
    return NextResponse.json(
      { error: "요청 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const decision = body.decision;
  if (decision !== "go" && decision !== "no_go") {
    return NextResponse.json(
      { error: "결정을 선택해주세요." },
      { status: 400 },
    );
  }

  const existing = await getTodayMorningEvent();

  // Same decision as today and a valid cached plan already exists → idempotent, no OpenAI call.
  // (Switching go↔no_go, or retrying a failed coach, falls through and regenerates.)
  if (existing && existing.decision === decision && existing.coachPlan) {
    return NextResponse.json({
      coach: existing.coachPlan,
      model: existing.model ?? OPENAI_MODEL,
      code: "already_checked_in",
    });
  }

  const apiKey = getRuntimeSecret("OPENAI_API_KEY");
  if (!apiKey) {
    // The decision is still recorded (first check-in or a switch) so it is not lost.
    try {
      await storeMorningEvent(decision);
    } catch {
      // The decision remains cached in the browser even if Neon is temporarily unavailable.
    }
    return NextResponse.json(
      {
        error: "OpenAI API 키가 아직 설정되지 않았습니다.",
        code: "openai_not_configured",
      },
      { status: 503 },
    );
  }

  // Record the decision. For a coach retry (same decision, no plan) the upsert is idempotent.
  try {
    await storeMorningEvent(decision);
  } catch {
    // The decision remains cached in the browser even if Neon is temporarily unavailable.
  }

  const [recentCheckins, coachMemory] = await Promise.all([
    getRecentCheckins(),
    getCoachMemory(),
  ]);

  try {
    const parsed = await generateCoachPlan(
      apiKey,
      decision,
      body.context,
      recentCheckins,
      coachMemory,
    );

    try {
      await storeMorningEvent(decision, OPENAI_MODEL, parsed);
    } catch {
      // A successful coaching response should still reach the user when Neon is unavailable.
    }
    try {
      await appendCoachMemory(parsed);
    } catch {
      // Memory append is best-effort.
    }

    return NextResponse.json({ coach: parsed, model: OPENAI_MODEL });
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "OpenAI 응답 시간이 초과됐습니다."
        : "AI 코치 응답을 만들지 못했습니다.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
