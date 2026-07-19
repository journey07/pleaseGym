import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, isDatabaseConfigured } from "@/db";
import { userState } from "@/db/schema";

const ownerId = () => process.env.FIRST_REP_OWNER_ID ?? "local-owner";

const unavailable = () =>
  NextResponse.json(
    {
      configured: false,
      error: "DATABASE_URL is not configured.",
    },
    { status: 503 },
  );

export async function GET() {
  if (!isDatabaseConfigured()) return unavailable();

  try {
    const [state] = await getDb()
      .select()
      .from(userState)
      .where(eq(userState.ownerId, ownerId()))
      .limit(1);
    return NextResponse.json({
      configured: true,
      state: state
        ? {
            history: state.workoutHistory,
            favorites: state.favorites,
            coachMemory: state.coachMemory,
            updatedAt: state.updatedAt,
          }
        : null,
    });
  } catch {
    return NextResponse.json(
      { configured: true, error: "Neon에서 기록을 불러오지 못했습니다." },
      { status: 502 },
    );
  }
}

export async function PUT(request: Request) {
  if (!isDatabaseConfigured()) return unavailable();

  const rawBody = await request.text();
  if (rawBody.length > 500_000) {
    return NextResponse.json(
      { error: "저장 데이터가 너무 큽니다." },
      { status: 413 },
    );
  }

  let body: { history?: unknown; favorites?: unknown; coachMemory?: unknown };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "요청 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.history) || !Array.isArray(body.favorites)) {
    return NextResponse.json(
      { error: "운동 기록과 즐겨찾기는 배열이어야 합니다." },
      { status: 400 },
    );
  }

  const hasCoachMemory = Array.isArray(body.coachMemory);
  const coachMemory = hasCoachMemory ? (body.coachMemory as unknown[]) : [];
  const now = new Date();

  try {
    await getDb()
      .insert(userState)
      .values({
        ownerId: ownerId(),
        workoutHistory: body.history,
        favorites: body.favorites,
        coachMemory,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userState.ownerId,
        set: {
          workoutHistory: body.history,
          favorites: body.favorites,
          // Preserve existing coachMemory when the client omits it — the morning coach owns that field.
          ...(hasCoachMemory ? { coachMemory } : {}),
          updatedAt: now,
        },
      });
    return NextResponse.json({ saved: true, updatedAt: now.toISOString() });
  } catch {
    return NextResponse.json(
      { error: "Neon에 기록을 저장하지 못했습니다." },
      { status: 502 },
    );
  }
}
