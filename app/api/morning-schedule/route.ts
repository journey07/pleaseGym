import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, isDatabaseConfigured } from "@/db";
import { userState } from "@/db/schema";

// The macOS sync agent curls this, so it must never be served stale from the CDN.
export const dynamic = "force-dynamic";

const ownerId = () => process.env.FIRST_REP_OWNER_ID ?? "local-owner";

type Schedule = { enabled: boolean; hour: number; minute: number };
const DEFAULT: Schedule = { enabled: true, hour: 7, minute: 29 };

const normalize = (raw: unknown): Schedule => {
  const s = (raw ?? {}) as Partial<Schedule>;
  const hour = Number(s.hour);
  const minute = Number(s.minute);
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : DEFAULT.enabled,
    hour:
      Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT.hour,
    minute:
      Number.isInteger(minute) && minute >= 0 && minute <= 59
        ? minute
        : DEFAULT.minute,
  };
};

const unavailable = () =>
  NextResponse.json(
    { configured: false, error: "DATABASE_URL is not configured." },
    { status: 503 },
  );

export async function GET() {
  if (!isDatabaseConfigured())
    return NextResponse.json({ configured: false, schedule: DEFAULT });
  try {
    const [row] = await getDb()
      .select({ schedule: userState.morningSchedule })
      .from(userState)
      .where(eq(userState.ownerId, ownerId()))
      .limit(1);
    return NextResponse.json({
      configured: true,
      schedule: normalize(row?.schedule),
    });
  } catch {
    return NextResponse.json({ configured: true, schedule: DEFAULT });
  }
}

export async function PUT(request: Request) {
  if (!isDatabaseConfigured()) return unavailable();

  const rawBody = await request.text();
  if (rawBody.length > 2_000) {
    return NextResponse.json(
      { error: "저장 데이터가 너무 큽니다." },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: "요청 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const schedule = normalize(body);
  const now = new Date();
  try {
    // 부분 upsert: morning_schedule 컬럼만 → 다른 컬럼과 충돌 없음.
    await getDb()
      .insert(userState)
      .values({ ownerId: ownerId(), morningSchedule: schedule, updatedAt: now })
      .onConflictDoUpdate({
        target: userState.ownerId,
        set: { morningSchedule: schedule, updatedAt: now },
      });
    return NextResponse.json({ saved: true, schedule });
  } catch {
    return NextResponse.json(
      { error: "설정을 저장하지 못했습니다." },
      { status: 502 },
    );
  }
}
