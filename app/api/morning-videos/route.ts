import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, isDatabaseConfigured } from "@/db";
import { userState } from "@/db/schema";

// The macOS 6AM routine reads this via curl (no cache: "no-store" possible),
// so the list must never be served stale from the CDN.
export const dynamic = "force-dynamic";

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
      .select({ videos: userState.morningVideos })
      .from(userState)
      .where(eq(userState.ownerId, ownerId()))
      .limit(1);
    return NextResponse.json({
      configured: true,
      videos: state?.videos ?? [],
    });
  } catch {
    return NextResponse.json(
      {
        configured: true,
        error: "Neon에서 아침 영상 목록을 불러오지 못했습니다.",
      },
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

  let body: { videos?: unknown };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "요청 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.videos)) {
    return NextResponse.json(
      { error: "아침 영상 목록은 배열이어야 합니다." },
      { status: 400 },
    );
  }

  const now = new Date();

  try {
    await getDb()
      .insert(userState)
      .values({
        ownerId: ownerId(),
        morningVideos: body.videos,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userState.ownerId,
        set: {
          morningVideos: body.videos,
          updatedAt: now,
        },
      });
    return NextResponse.json({ saved: true, updatedAt: now.toISOString() });
  } catch {
    return NextResponse.json(
      { error: "Neon에 아침 영상 목록을 저장하지 못했습니다." },
      { status: 502 },
    );
  }
}
