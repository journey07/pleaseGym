import { NextResponse } from "next/server";
import { getDb, isDatabaseConfigured } from "@/db";
import { morningEvents } from "@/db/schema";

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
  },
  required: ["decision", "headline", "message", "planLabel", "exercises", "nextAction", "safetyNote"],
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
- headline은 18자 이내, message는 두 문장 이내, safetyNote는 한 문장 이내로 쓴다.`;

const getRuntimeSecret = (name: "OPENAI_API_KEY" | "OPENAI_MODEL") => process.env[name];

const dateKeyInSeoul = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

const ownerId = () => process.env.FIRST_REP_OWNER_ID ?? "local-owner";

async function storeMorningEvent(decision: Decision, model?: string, coachPlan?: MorningCoachResponse) {
  if (!isDatabaseConfigured()) return;
  const db = getDb();
  const eventDate = dateKeyInSeoul();
  const eventId = `${ownerId()}:${eventDate}`;
  const now = new Date();

  await db.insert(morningEvents).values({
    id: eventId,
    ownerId: ownerId(),
    eventDate,
    decision,
    model: model ?? null,
    coachPlan: coachPlan ? coachPlan as unknown as Record<string, unknown> : null,
    decidedAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [morningEvents.ownerId, morningEvents.eventDate],
    set: {
      decision,
      ...(model ? { model } : {}),
      ...(coachPlan ? { coachPlan: coachPlan as unknown as Record<string, unknown> } : {}),
      updatedAt: now,
    },
  });
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

const isMorningCoachResponse = (value: unknown): value is MorningCoachResponse => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MorningCoachResponse>;
  return (candidate.decision === "go" || candidate.decision === "no_go")
    && typeof candidate.headline === "string"
    && typeof candidate.message === "string"
    && typeof candidate.planLabel === "string"
    && Array.isArray(candidate.exercises)
    && (candidate.nextAction === "start" || candidate.nextAction === "minimum" || candidate.nextAction === "rest")
    && typeof candidate.safetyNote === "string";
};

export async function POST(request: Request) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && origin !== requestUrl.origin) {
    return NextResponse.json({ error: "허용되지 않은 요청입니다." }, { status: 403 });
  }

  const rawBody = await request.text();
  if (rawBody.length > 24_000) {
    return NextResponse.json({ error: "운동 기록이 너무 큽니다." }, { status: 413 });
  }

  let body: { decision?: Decision; context?: unknown };
  try {
    body = JSON.parse(rawBody) as { decision?: Decision; context?: unknown };
  } catch {
    return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  if (body.decision !== "go" && body.decision !== "no_go") {
    return NextResponse.json({ error: "결정을 선택해주세요." }, { status: 400 });
  }

  try {
    await storeMorningEvent(body.decision);
  } catch {
    // The decision remains cached in the browser even if Neon is temporarily unavailable.
  }

  const apiKey = getRuntimeSecret("OPENAI_API_KEY");
  if (!apiKey) {
    return NextResponse.json({
      error: "OpenAI API 키가 아직 설정되지 않았습니다.",
      code: "openai_not_configured",
    }, { status: 503 });
  }

  const model = getRuntimeSecret("OPENAI_MODEL") ?? "gpt-5.6-luna";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const openAIResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        store: false,
        reasoning: { effort: "low" },
        max_output_tokens: 800,
        input: [
          { role: "developer", content: systemPrompt },
          {
            role: "user",
            content: JSON.stringify({
              decision: body.decision,
              context: body.context ?? {},
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

    const data = await openAIResponse.json() as OpenAIResponse;
    if (!openAIResponse.ok) {
      return NextResponse.json({
        error: data.error?.message ?? "OpenAI 응답을 가져오지 못했습니다.",
      }, { status: openAIResponse.status });
    }

    const outputText = extractOutputText(data);
    const parsed = JSON.parse(outputText) as unknown;
    if (!isMorningCoachResponse(parsed) || parsed.decision !== body.decision) {
      throw new Error("OpenAI 응답 스키마가 올바르지 않습니다.");
    }


    try {
      await storeMorningEvent(body.decision, model, parsed);
    } catch {
      // A successful coaching response should still reach the user when Neon is unavailable.
    }

    return NextResponse.json({ coach: parsed, model });
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "OpenAI 응답 시간이 초과됐습니다."
      : "AI 코치 응답을 만들지 못했습니다.";
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
