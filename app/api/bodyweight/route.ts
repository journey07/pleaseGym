import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, isDatabaseConfigured } from "@/db";
import { userState } from "@/db/schema";

export const dynamic = "force-dynamic";

const ownerId = () => process.env.FIRST_REP_OWNER_ID ?? "local-owner";

type Entry = { date: string; kg: number };

const unavailable = () =>
  NextResponse.json(
    { configured: false, error: "DATABASE_URL is not configured." },
    { status: 503 },
  );

const readLog = async (): Promise<Entry[]> => {
  const [state] = await getDb()
    .select({ log: userState.bodyweightLog })
    .from(userState)
    .where(eq(userState.ownerId, ownerId()))
    .limit(1);
  const raw = state?.log ?? [];
  return Array.isArray(raw)
    ? (raw.filter(
        (e) =>
          e &&
          typeof (e as Entry).date === "string" &&
          Number.isFinite((e as Entry).kg),
      ) as Entry[])
    : [];
};

export async function GET() {
  if (!isDatabaseConfigured()) return unavailable();
  try {
    const log = await readLog();
    log.sort((a, b) => a.date.localeCompare(b.date));
    return NextResponse.json({ configured: true, log });
  } catch {
    return NextResponse.json(
      { configured: true, error: "체중 기록을 불러오지 못했습니다." },
      { status: 502 },
    );
  }
}

export async function PUT(request: Request) {
  if (!isDatabaseConfigured()) return unavailable();

  const rawBody = await request.text();
  if (rawBody.length > 100_000) {
    return NextResponse.json(
      { error: "저장 데이터가 너무 큽니다." },
      { status: 413 },
    );
  }

  let body: { date?: string; kg?: number };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "요청 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const date =
    typeof body.date === "string" ? body.date.slice(0, 10) : undefined;
  const kg = Number(body.kg);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(kg)) {
    return NextResponse.json(
      { error: "날짜(YYYY-MM-DD)와 체중(kg)이 필요합니다." },
      { status: 400 },
    );
  }
  if (kg <= 0 || kg > 500) {
    return NextResponse.json(
      { error: "체중 값이 범위를 벗어났습니다." },
      { status: 400 },
    );
  }

  const now = new Date();
  try {
    // read-modify-write: 같은 날짜는 교체, 최근 200개만 유지.
    const current = await readLog();
    const merged = [...current.filter((e) => e.date !== date), { date, kg }]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-200);

    // 부분 upsert: bodyweight_log 컬럼만 건드려 /api/state의 다른 컬럼과 충돌 없음.
    await getDb()
      .insert(userState)
      .values({ ownerId: ownerId(), bodyweightLog: merged, updatedAt: now })
      .onConflictDoUpdate({
        target: userState.ownerId,
        set: { bodyweightLog: merged, updatedAt: now },
      });
    return NextResponse.json({ saved: true, log: merged });
  } catch {
    return NextResponse.json(
      { error: "체중을 저장하지 못했습니다." },
      { status: 502 },
    );
  }
}
