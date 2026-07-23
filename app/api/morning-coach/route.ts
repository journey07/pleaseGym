import { and, desc, eq, gte } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, isDatabaseConfigured } from "@/db";
import { morningEvents, userState } from "@/db/schema";

// Always run per-request: the GET returns today's decision from the DB, which must
// never be statically cached (parity with app/api/morning-videos/route.ts).
export const dynamic = "force-dynamic";

// The coach model is fixed in code (not an env var) so every environment uses the same one.
const OPENAI_MODEL = "gpt-5.6-luna";

type Decision = "go" | "no_go";

type MorningCoachResponse = {
  decision: Decision;
  headline: string;
  message: string;
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
    nextAction: { type: "string", enum: ["start", "minimum", "rest"] },
    safetyNote: { type: "string" },
    progressNote: { type: "string" },
  },
  required: [
    "decision",
    "headline",
    "message",
    "nextAction",
    "safetyNote",
    "progressNote",
  ],
} as const;

const systemPrompt = `당신은 EVERYONE BUT YOU의 불꽃 스파르타 아침 PT 코치다. 에너지를 폭발시켜 사용자를 끌어올리고 근력과 근육량 성장을 돕는다.
사용자가 오늘 운동하러 갈지 가지 않을지를 이미 결정했다. 그 결정을 존중하면서 근성장에 가장 효과적인 바로 다음 행동 하나를 뜨겁게 제시하라.

규칙:
- 한국어로 "가자", "쥐어짜", "챔피언", "도망 안 쳤어" 같은 끌어올리는 표현을 허용하며 에너지 넘치고 단호하게 말한다. 동기부여가 목적이며 비아냥, 모욕, 비난은 금지한다.
- 운동 계획이나 운동 목록을 만들지 않는다. exercises 같은 목록은 반환하지 않고 headline, message, nextAction, safetyNote, progressNote로만 조언한다.
- 최근 운동 기록, 연속 출석, 복귀, 정체 등 입력에서 실제로 관찰된 사실을 최소 한 조각 반드시 콕 집어 message 또는 progressNote에 쓴다. 예: "저번보다", "3일 연속", "벤치 정체". 데이터가 없으면 지어내지 말고 "오늘이 1일차, 첫 기록 만들자!"라고 말한다.
- go라면 최근 기록에 실제로 등장한 운동 또는 즐겨찾기 운동을 조언의 근거로만 사용하고, 마지막에 불붙이는 한 방으로 행동을 촉구한다.
- 최근 기록이 부족하면 무게를 추측하지 말고, 현장에서 사용자가 적절한 강도를 정하라고 조언한다.
- 점진적 과부하 조언은 message 또는 progressNote 문장 안에서만 말로 전한다. 직전 기록에서 목표 반복을 모두 채웠다면 예를 들어 "저번보다 2.5kg 올려 쥐어짜!" 또는 "반복을 1회 더 가자!"라고 조언하고, 채우지 못했다면 같은 무게를 유지하라고 한다.
- 한 번에 최근 최고중량의 5%를 넘는 증량을 권하지 않는다. 최대중량(1RM) 실측 테스트를 권하지 않는다.
- 같은 운동만 반복 중이면 message에서 한 문장으로 짚는다.
- no_go라면 죄책감을 주지 말고 "회복도 훈련이야, 내일 다시 가자"는 방향으로 끌어올린다.
- no_go의 nextAction은 minimum 또는 rest 중 하나다. minimum은 5분 이하의 가벼운 행동만 의미한다.
- 통증을 진단하거나 치료하지 않는다. 위험하거나 날카로운 통증이 있으면 즉시 운동을 중단하고 전문가와 상담하라고 안내한다.
- headline은 20자 이내, message는 에너지를 실은 2~3문장, safetyNote는 한 문장으로 쓴다.

추가 입력을 활용한 고도화:
- recentCheckins: 최근 7일 아침 체크인 이력([{date, decision}]). go/no_go 패턴(연속 출석·연속 결석·복귀)을 읽고 오늘의 스파르타 어조와 progressNote에 반영한다. 비어 있으면 무시한다.
- coachMemory: 지난 코칭 메모([{date, decision, headline, nextAction, progressNote}]). 과거 코칭 맥락과 모순되지 않게 스파르타 톤으로 이어간다. 비어 있으면 무시한다.

progressNote 규칙:
- go: 최근 기록·체크인 이력에서 실제로 관찰된 사실만 근거로 오늘의 강도/휴식 판단 이유를 한두 문장으로 뜨겁게 밝힌다. 데이터가 부족하면 부족하다고 명시한다. 추측 금지, 최고중량 초과 목표의 근거로 쓰지 않는다.
- no_go: 진행도 분석 대상이 없으므로 죄책감 없는 짧은 스파르타 격려 한 문장 또는 빈 문자열("")을 쓴다.`;

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

export async function GET() {
  if (!isDatabaseConfigured()) {
    return NextResponse.json({ code: "not_configured", decision: null });
  }
  const existing = await getTodayMorningEvent();
  if (!existing) {
    return NextResponse.json({ decision: null, date: dateKeyInSeoul() });
  }
  return NextResponse.json({
    decision: existing.decision,
    coach: existing.coachPlan,
    model: existing.model ?? OPENAI_MODEL,
    date: dateKeyInSeoul(),
  });
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
