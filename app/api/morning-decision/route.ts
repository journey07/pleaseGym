import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, isDatabaseConfigured } from "@/db";
import { morningEvents } from "@/db/schema";

// Always run per-request: the GET returns today's decision from the DB, which must
// never be statically cached (parity with app/api/morning-videos/route.ts).
export const dynamic = "force-dynamic";

type Decision = "go" | "no_go";

const dateKeyInSeoul = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const ownerId = () => process.env.FIRST_REP_OWNER_ID ?? "local-owner";

async function storeMorningEvent(decision: Decision) {
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
      decidedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [morningEvents.ownerId, morningEvents.eventDate],
      set: {
        decision,
        updatedAt: now,
      },
    });
}

async function getTodayMorningEvent(): Promise<{
  decision: Decision;
} | null> {
  if (!isDatabaseConfigured()) return null;
  try {
    const [row] = await getDb()
      .select({ decision: morningEvents.decision })
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
    return { decision: row.decision };
  } catch {
    return null;
  }
}

export async function GET() {
  if (!isDatabaseConfigured()) {
    return NextResponse.json({ code: "not_configured", decision: null });
  }
  const existing = await getTodayMorningEvent();
  return NextResponse.json({
    decision: existing?.decision ?? null,
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

  let body: { decision?: Decision };
  try {
    body = JSON.parse(rawBody) as { decision?: Decision };
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

  try {
    await storeMorningEvent(decision);
  } catch {
    return NextResponse.json(
      { error: "결정을 저장하지 못했습니다." },
      { status: 503 },
    );
  }

  return NextResponse.json({ decision, date: dateKeyInSeoul() });
}
