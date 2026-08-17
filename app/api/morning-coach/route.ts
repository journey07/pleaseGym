import { and, desc, eq, gte } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, isDatabaseConfigured } from "@/db";
import { morningEvents, userState } from "@/db/schema";
import {
  computeBodyPartStats,
  neglectedParts,
  type StatExercise,
  type StatSession,
} from "@/app/lib/bodyPartStats";
import { inferBodyPart, type BodyPart } from "@/app/lib/bodyPart";
import {
  canonicalNameMap,
  normalizeExerciseName,
} from "@/app/lib/exerciseName";

// Always run per-request: the GET returns today's decision from the DB, which must
// never be statically cached (parity with app/api/morning-videos/route.ts).
export const dynamic = "force-dynamic";

// The coach model is fixed in code (not an env var) so every environment uses the same one.
const OPENAI_MODEL = "gpt-5.6-luna";

type Decision = "go" | "no_go";
type WorkoutSplit = "upper" | "lower" | "full" | "cardio";
type SuggestedSplit = Exclude<WorkoutSplit, "cardio">;

type LastSameSplitExercise = {
  name: string;
  metric: "weight" | "bodyweight" | "distance";
  assisted: boolean;
  sets: number;
  topWeight: number;
  repsAtTop: number;
  lastDate: string;
  suggested: string;
};

type MorningCoachResponse = {
  decision: Decision;
  headline: string;
  message: string;
  nextAction: "start" | "minimum" | "rest";
  safetyNote: string;
  progressNote: string;
  todaySplit: SuggestedSplit | "rest";
  todayPlan: Array<{
    name: string;
    target: string;
    note: string;
    lastDate: string;
  }>;
};

type MorningCoachModelResponse = Omit<MorningCoachResponse, "todayPlan"> & {
  todayPlan: Array<{ note: string }>;
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
    todaySplit: {
      type: "string",
      enum: ["upper", "lower", "full", "rest"],
    },
    todayPlan: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          note: { type: "string" },
        },
        required: ["note"],
      },
    },
  },
  required: [
    "decision",
    "headline",
    "message",
    "nextAction",
    "safetyNote",
    "progressNote",
    "todaySplit",
    "todayPlan",
  ],
} as const;

const systemPrompt = `당신은 EVERYONE BUT YOU의 불꽃 스파르타 아침 PT 코치다. 에너지를 폭발시켜 사용자를 끌어올린다.

★ 사용자 프로필(고정): 마른 체형이라 "몸을 크게" 키우고 싶다. 목표는 전신 근비대 — 특히 두께(등·가슴·후면사슬 density)와 너비(어깨 측면·광배 V테이퍼). "전체 골고루" 커지는 것.
→ 모든 조언은 이 렌즈로: 부위 균형과 볼륨으로 판단하고, 방치된 부위를 콕 집고, 왜 그게 두께/너비에 필요한지 한 줄로 설명하라. 잔소리 말고 지식 트레이너처럼.

사용자가 오늘 갈지/안 갈지 이미 결정했다(decision). 존중하면서 근성장에 가장 효과적인 바로 다음 행동 하나를 뜨겁게 제시하라.

입력 데이터:
- bodyParts: 근육 8부위별 { part, weeklyVolume(최근7일 볼륨: 중량=Σ중량×반복, 맨몸=Σ반복), weeklySets, freq28(최근28일 세션수), daysSinceLast(마지막 훈련 후 경과일, null=최근28일 기록없음), trend(up/flat/down/new) }. weeklyVolume 내림차순.
- neglected: 방치 부위 목록(28일 공백이거나 10일+ 안 함). 이게 있으면 우선 콕 집어라.
- bodyweight: { latest(kg), deltaVs4wk(4주 전 대비 증감kg, null=비교불가) } 또는 null.
- recentCheckins: 최근 7일 go/no_go 이력. coachMemory: 지난 코칭 메모.
- recentSplits: 최근 6세션의 { date, split(upper/lower/full/cardio), exercises }. 상체와 하체를 번갈아 했는지 파악하는 근거다.
- suggestedSplit: 서버가 최근 분할과 부위별 공백으로 계산한 오늘 권장 분할. 모델이 바꾸지 않는다.
- lastSameSplit: 오늘 계획의 기준이 되는 최근 세션의 실제 종목별 { name, metric, assisted, sets, topWeight, repsAtTop, lastDate, suggested }. 서버가 name과 suggested를 오늘 계획에 직접 넣으므로 모델은 참고만 한다.

작성 규칙(스파르타 톤 유지):
- 한국어로 "가자","쥐어짜","챔피언" 같은 끌어올리는 표현 OK. 비아냥·모욕·비난 금지.
- **message(핵심, 3~4문장)**: ① 몸 스냅샷 1줄(어디 편중/어디 방치를 bodyParts 근거로) → ② 최근 대비 피드백 1개(올라간/정체된 부위나 종목 콕) → ③ 오늘 분할과 무게 방향 한 줄(예: "오늘은 하체, 스쿼트 +2.5kg"). go면 오늘 처방, no_go면 회복 방향. 세부 종목별 조언은 todayPlan의 note에 쓴다.
- **progressNote(왜, 1~2문장)**: 그 처방/경고가 왜 사용자의 두께·너비 목표에 필요한지 원리를 설명하라(해부/근비대 논리). 예: "측면 삼각근이 어깨를 옆으로 벌려 V실루엣을 만든다", "데드/기립근 없으면 등 두께가 안 큰다". no_go면 죄책감 없는 짧은 격려 한 줄 또는 "".
- 관찰된 사실만 인용, 수치 지어내기 금지. bodyParts가 전부 비어 있으면(첫 기록) "오늘이 시작, 첫 데이터 만들자"로.
- 점진적 과부하: 무게는 최근 최고중량 5% 이내 증량만. 1RM 실측 테스트 금지. 통증 진단·치료 금지(위험한 통증은 중단+전문가 안내).
- go면 todaySplit은 suggestedSplit 그대로다. todayPlan에는 lastSameSplit 순서대로 최대 8개의 note만 반환한다. name과 target은 반환하지 않는다. lastSameSplit이 비었으면 todayPlan=[]로 두고 message에서 "첫 기록 만들자"고 한다.
- 종목을 늘리지 않는다. 시간 대비 효율상 교체가 필요하면 todayPlan의 note 한 곳에만 "X 대신 Y"를 명시할 수 있다.
- 교체는 수평밀기·수직밀기·수평당기기·수직당기기·스쿼트·힙힌지·종아리 패턴의 빈칸을 중복·저효율 종목과 맞바꿀 때만 제안한다. 고립운동을 일괄 저효율로 판정하지 않는다.
- no_go면 todaySplit="rest", todayPlan=[]로 둔다.
- coachMemory와 recentCheckins을 보고 연속 출석이나 정체가 실제로 보일 때만 언급한다.
- bodyweight가 있으면: 벌크 목표상 체중 정체(deltaVs4wk≤0)면 "볼륨보다 식사부터"를 한 번 짚어도 좋다. 없으면 "체중도 기록하자" 정도만.
- nextAction: go면 start(운동 시작), no_go면 minimum(5분 이하 가벼운 것) 또는 rest.
- headline 20자 이내, safetyNote 한 문장. exercises 필드는 반환하지 않는다. todayPlan의 각 object에는 note만 반환한다.`;

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

const daysBetweenDateKeys = (from: string, to: string) =>
  Math.floor(
    (Date.parse(`${to}T00:00:00Z`) -
      Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );

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
    typeof candidate.progressNote === "string" &&
    (candidate.todaySplit === "upper" ||
      candidate.todaySplit === "lower" ||
      candidate.todaySplit === "full" ||
      candidate.todaySplit === "rest") &&
    Array.isArray(candidate.todayPlan) &&
    candidate.todayPlan.length <= 8 &&
    candidate.todayPlan.every(
      (item) =>
        !!item &&
        typeof item === "object" &&
        typeof item.name === "string" &&
        typeof item.target === "string" &&
        typeof item.note === "string" &&
        typeof item.lastDate === "string",
    ) &&
    (candidate.decision === "no_go"
      ? candidate.todaySplit === "rest" && candidate.todayPlan.length === 0
      : candidate.todaySplit !== "rest")
  );
};

const isMorningCoachModelResponse = (
  value: unknown,
): value is MorningCoachModelResponse => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MorningCoachModelResponse>;
  return (
    (candidate.decision === "go" || candidate.decision === "no_go") &&
    typeof candidate.headline === "string" &&
    typeof candidate.message === "string" &&
    (candidate.nextAction === "start" ||
      candidate.nextAction === "minimum" ||
      candidate.nextAction === "rest") &&
    typeof candidate.safetyNote === "string" &&
    typeof candidate.progressNote === "string" &&
    (candidate.todaySplit === "upper" ||
      candidate.todaySplit === "lower" ||
      candidate.todaySplit === "full" ||
      candidate.todaySplit === "rest") &&
    Array.isArray(candidate.todayPlan) &&
    candidate.todayPlan.length <= 8 &&
    candidate.todayPlan.every(
      (item) =>
        !!item &&
        typeof item === "object" &&
        typeof item.note === "string",
    ) &&
    (candidate.decision === "no_go"
      ? candidate.todaySplit === "rest"
      : candidate.todaySplit !== "rest")
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
      row.coachPlan &&
      isMorningCoachResponse(row.coachPlan) &&
      row.coachPlan.decision === row.decision
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

// 서버에서 전체 workoutHistory + bodyweightLog를 읽어 부위 스냅샷을 만든다.
// 6세션 클라 컨텍스트로는 "방치 부위"(창 밖 마지막 훈련일) 판정이 불가하기 때문(B1).
type CoachStats = {
  bodyParts: Array<{
    part: string;
    weeklyVolume: number;
    weeklySets: number;
    freq28: number;
    daysSinceLast: number | null;
    trend: string;
  }>;
  neglected: string[];
  bodyweight: { latest: number; deltaVs4wk: number | null } | null;
  recentSplits: Array<{
    date: string;
    split: WorkoutSplit;
    exercises: string[];
  }>;
  suggestedSplit: SuggestedSplit;
  lastSameSplit: LastSameSplitExercise[];
};

const UPPER_PARTS: BodyPart[] = ["가슴", "등", "어깨", "팔"];
const LOWER_PARTS: BodyPart[] = ["허벅지", "종아리", "허리"];

const completedSets = (exercise: StatExercise) =>
  (exercise.sets ?? []).filter((set) => set?.done !== false);

const splitOf = (session: StatSession): WorkoutSplit => {
  let upperSets = 0;
  let lowerSets = 0;
  let strengthSets = 0;
  let distanceSets = 0;

  for (const exercise of session.exercises ?? []) {
    const sets = completedSets(exercise).length;
    if (sets === 0) continue;
    if (exercise.metric === "distance") {
      distanceSets += sets;
      continue;
    }
    strengthSets += sets;
    const part = exercise.bodyPart ?? inferBodyPart(String(exercise.name ?? ""));
    if (UPPER_PARTS.includes(part)) upperSets += sets;
    if (LOWER_PARTS.includes(part)) lowerSets += sets;
  }

  const classifiedSets = upperSets + lowerSets;
  if (strengthSets === 0 && distanceSets > 0) return "cardio";
  if (classifiedSets > 0 && upperSets / classifiedSets >= 0.7)
    return "upper";
  if (classifiedSets > 0 && lowerSets / classifiedSets >= 0.7)
    return "lower";
  return "full";
};

const formatTargetNumber = (value: number) =>
  Number.isInteger(value)
    ? String(value)
    : String(Math.round(value * 100) / 100);

const progressionFor = (
  metric: LastSameSplitExercise["metric"],
  assisted: boolean,
  topWeight: number,
  repsAtTop: number,
) => {
  if (metric === "distance") return "제안 없음";
  if (metric === "bodyweight" && assisted) {
    const nextWeight = Math.max(0, topWeight - 2.5);
    return `보조 ${formatTargetNumber(nextWeight)}kg × ${repsAtTop}`;
  }
  if (metric === "bodyweight") return `${repsAtTop + 1}회`;
  if (topWeight <= 0) return `${repsAtTop + 1}회`;
  if (repsAtTop >= 8) {
    const nextWeight =
      Math.floor(Math.min(topWeight + 2.5, topWeight * 1.05) * 2) / 2;
    return `${formatTargetNumber(nextWeight)}kg × ${repsAtTop}`;
  }
  return `${formatTargetNumber(topWeight)}kg × ${repsAtTop + 1}`;
};

const planExercise = (
  exercise: StatExercise,
  lastDate: string,
  canonicalNames: Map<string, string>,
): LastSameSplitExercise | null => {
  const originalName = String(exercise.name ?? "").trim();
  if (!originalName) return null;
  const name =
    canonicalNames.get(normalizeExerciseName(originalName)) ?? originalName;
  const metric =
    exercise.metric === "distance"
      ? "distance"
      : exercise.metric === "bodyweight"
        ? "bodyweight"
        : "weight";
  const assisted = exercise.assisted === true;
  const sets = completedSets(exercise).filter((set) => {
    if (metric === "distance") return Number(set.distanceKm) > 0;
    return Number(set.reps) > 0;
  });
  if (sets.length === 0) return null;

  let topWeight = 0;
  let repsAtTop = 0;
  if (metric === "bodyweight" && !assisted) {
    repsAtTop = sets.reduce(
      (best, set) => Math.max(best, Number(set.reps) || 0),
      0,
    );
  } else if (metric !== "distance") {
    const weights = sets.map((set) => Number(set.weight) || 0);
    const positiveWeights = weights.filter((weight) => weight > 0);
    topWeight = assisted
      ? positiveWeights.length > 0
        ? Math.min(...positiveWeights)
        : 0
      : Math.max(...weights);
    repsAtTop = sets.reduce(
      (best, set) =>
        (Number(set.weight) || 0) === topWeight
          ? Math.max(best, Number(set.reps) || 0)
          : best,
      0,
    );
  }

  return {
    name,
    metric,
    assisted,
    sets: sets.length,
    topWeight,
    repsAtTop,
    lastDate,
    suggested: progressionFor(metric, assisted, topWeight, repsAtTop),
  };
};

const olderSplit = (bodyParts: CoachStats["bodyParts"]): SuggestedSplit => {
  const averageAge = (parts: BodyPart[]) => {
    const ages = parts.flatMap((part) => {
      const age = bodyParts.find((stat) => stat.part === part)?.daysSinceLast;
      return age === null || age === undefined ? [] : [age];
    });
    if (ages.length === 0) return 0;
    return ages.reduce((sum, age) => sum + age, 0) / ages.length;
  };
  return averageAge(LOWER_PARTS) > averageAge(UPPER_PARTS)
    ? "lower"
    : "upper";
};

async function getCoachStats(): Promise<CoachStats | null> {
  if (!isDatabaseConfigured()) return null;
  try {
    const [row] = await getDb()
      .select({
        history: userState.workoutHistory,
        bw: userState.bodyweightLog,
      })
      .from(userState)
      .where(eq(userState.ownerId, ownerId()))
      .limit(1);
    const history = Array.isArray(row?.history)
      ? (row.history as StatSession[])
      : [];
    const today = dateKeyInSeoul();
    const stats = computeBodyPartStats(history, today);
    const bodyParts = stats.map((s) => ({
      part: s.part,
      weeklyVolume: s.weeklyVolume,
      weeklySets: s.weeklySets,
      freq28: s.freq28,
      daysSinceLast: s.daysSinceLast,
      trend: s.trend,
    }));
    const sortedSessions = history
      .filter(
        (session) =>
          typeof session?.date === "string" &&
          Array.isArray(session.exercises),
      )
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const canonicalNames = canonicalNameMap(
      [...sortedSessions].reverse().flatMap((session) =>
        (session.exercises ?? []).map((exercise) =>
          String(exercise.name ?? "").trim(),
        ),
      ),
    );
    const sessionsWithSplits = sortedSessions.map((session) => ({
      session,
      date: String(session.date).slice(0, 10),
      split: splitOf(session),
    }));
    const recentSplits = sessionsWithSplits.slice(0, 6).map((item) => ({
      date: item.date,
      split: item.split,
      exercises: Array.from(
        new Map(
          (item.session.exercises ?? [])
            .filter((exercise) => completedSets(exercise).length > 0)
            .map((exercise) => {
              const name = String(exercise.name ?? "").trim();
              const normalizedName = normalizeExerciseName(name);
              return [
                normalizedName,
                canonicalNames.get(normalizedName) ?? name,
              ] as const;
            })
            .filter(([normalizedName]) => normalizedName),
        ).values(),
      ),
    }));
    const latestStrengthSplit = sessionsWithSplits.find(
      (item) => item.split !== "cardio",
    )?.split;
    const suggestedSplit: SuggestedSplit =
      latestStrengthSplit === "upper"
        ? "lower"
        : latestStrengthSplit === "lower"
          ? "upper"
          : olderSplit(bodyParts);
    const sameSplitSession =
      sessionsWithSplits.find((item) => item.split === suggestedSplit) ??
      sessionsWithSplits.find((item) => item.split !== "cardio");
    const sameSplitAge = sameSplitSession
      ? daysBetweenDateKeys(sameSplitSession.date, today)
      : Number.POSITIVE_INFINITY;
    const lastSameSplit =
      sameSplitSession && sameSplitAge >= 0 && sameSplitAge <= 60
        ? (sameSplitSession.session.exercises ?? []).reduce<
            LastSameSplitExercise[]
          >((planned, exercise) => {
            const item = planExercise(
              exercise,
              sameSplitSession.date,
              canonicalNames,
            );
            if (!item) return planned;
            const normalizedName = normalizeExerciseName(item.name);
            if (
              planned.some(
                (existing) =>
                  normalizeExerciseName(existing.name) === normalizedName,
              )
            )
              return planned;
            planned.push(item);
            return planned;
          }, [])
        : [];

    const bwLog = (Array.isArray(row?.bw) ? row.bw : []).filter(
      (e): e is { date: string; kg: number } =>
        !!e && typeof e.date === "string" && Number.isFinite(e.kg),
    );
    let bodyweight: CoachStats["bodyweight"] = null;
    if (bwLog.length > 0) {
      const sorted = [...bwLog].sort((a, b) => a.date.localeCompare(b.date));
      const latest = sorted[sorted.length - 1];
      const cutoff = shiftSeoulDateKey(-28);
      const past = sorted.find((e) => e.date >= cutoff) ?? sorted[0];
      bodyweight = {
        latest: latest.kg,
        deltaVs4wk:
          past && past.date !== latest.date
            ? Math.round((latest.kg - past.kg) * 10) / 10
            : null,
      };
    }

    return {
      bodyParts,
      neglected: neglectedParts(stats),
      bodyweight,
      recentSplits,
      suggestedSplit,
      lastSameSplit,
    };
  } catch {
    return null;
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
  coachStats: CoachStats | null,
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
        reasoning: { effort: "medium" },
        max_output_tokens: 2000,
        input: [
          { role: "developer", content: systemPrompt },
          {
            role: "user",
            content: JSON.stringify({
              decision,
              bodyParts: coachStats?.bodyParts ?? [],
              neglected: coachStats?.neglected ?? [],
              bodyweight: coachStats?.bodyweight ?? null,
              recentSplits: coachStats?.recentSplits ?? [],
              suggestedSplit: coachStats?.suggestedSplit ?? "full",
              lastSameSplit: coachStats?.lastSameSplit ?? [],
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
    if (!isMorningCoachModelResponse(parsed) || parsed.decision !== decision) {
      throw new Error("OpenAI 응답 스키마가 올바르지 않습니다.");
    }
    if (
      (decision === "no_go" && parsed.todaySplit !== "rest") ||
      (decision === "go" &&
        parsed.todaySplit !== (coachStats?.suggestedSplit ?? "full"))
    ) {
      throw new Error("OpenAI 운동 분할이 입력 기록과 일치하지 않습니다.");
    }
    const todayPlan =
      decision === "no_go"
        ? []
        : (coachStats?.lastSameSplit ?? [])
            .slice(0, 8)
            .map((exercise, index) => ({
              name: exercise.name,
              target: exercise.suggested,
              note: parsed.todayPlan[index]?.note ?? "",
              lastDate: exercise.lastDate,
            }));
    return { ...parsed, todayPlan };
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

  const [recentCheckins, coachMemory, coachStats] = await Promise.all([
    getRecentCheckins(),
    getCoachMemory(),
    getCoachStats(),
  ]);

  try {
    const parsed = await generateCoachPlan(
      apiKey,
      decision,
      body.context,
      recentCheckins,
      coachMemory,
      coachStats,
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
