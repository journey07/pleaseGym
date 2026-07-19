"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type Decision = "go" | "no_go";

type CoachResult = {
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

type StoredSet = {
  id: string;
  weight: number;
  reps: number;
  done: boolean;
  distanceKm?: number;
};

type StoredExercise = {
  id: string;
  name: string;
  metric?: "weight" | "distance";
  sets: StoredSet[];
};

type StoredSession = {
  date?: string;
  exercises?: StoredExercise[];
};

type StoredFavorite = {
  name?: string;
  metric?: "weight" | "distance";
};

type MissionStats = {
  streak: number;
  weekGoes: number;
  totalXp: number;
};

const uid = () => Math.random().toString(36).slice(2, 9);
const pad = (value: number) => String(value).padStart(2, "0");
const todayKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const readArray = <T,>(key: string): T[] => {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(key) ?? "[]",
    ) as unknown;
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
};

type CoachResultCache = {
  date: string;
  decision: Decision;
  coach: CoachResult;
};

const readCoachResultCache = (): CoachResultCache | null => {
  try {
    const raw = window.localStorage.getItem("first-rep-coach-result");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CoachResultCache;
    if (parsed && typeof parsed.date === "string" && parsed.coach) {
      // Drop a stale (previous-day) cache so it never briefly shows after midnight.
      if (parsed.date !== todayKey()) {
        window.localStorage.removeItem("first-rep-coach-result");
        return null;
      }
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
};

const writeCoachResultCache = (value: CoachResultCache) => {
  try {
    window.localStorage.setItem(
      "first-rep-coach-result",
      JSON.stringify(value),
    );
  } catch {
    // Best-effort cache; ignore quota/serialization failures.
  }
};

const readCoachSource = async () => {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (response.ok) {
      const data = (await response.json()) as {
        state?: { history?: unknown; favorites?: unknown } | null;
      };
      if (data.state) {
        const history = Array.isArray(data.state.history)
          ? (data.state.history as StoredSession[])
          : [];
        const favorites = Array.isArray(data.state.favorites)
          ? (data.state.favorites as StoredFavorite[])
          : [];
        window.localStorage.setItem(
          "first-rep-history",
          JSON.stringify(history),
        );
        window.localStorage.setItem(
          "first-rep-favorites",
          JSON.stringify(favorites),
        );
        return { history, favorites };
      }
    }
  } catch {
    // Fall through to the offline cache.
  }

  return {
    history: readArray<StoredSession>("first-rep-history"),
    favorites: readArray<StoredFavorite>("first-rep-favorites"),
  };
};

const buildCoachContext = async () => {
  const source = await readCoachSource();
  const history = source.history
    .filter(
      (session) =>
        typeof session.date === "string" && Array.isArray(session.exercises),
    )
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 6)
    .map((session) => ({
      date: session.date,
      exercises: (session.exercises ?? []).slice(0, 8).map((exercise) => {
        const sets = Array.isArray(exercise.sets)
          ? exercise.sets.filter((set) => set.done)
          : [];
        const isDistance = exercise.metric === "distance";
        const heaviest = sets.reduce(
          (best, set) => (set.weight > best.weight ? set : best),
          { weight: 0, reps: 0 },
        );
        return {
          name: String(exercise.name ?? "").slice(0, 60),
          metric: isDistance ? "distance" : "weight",
          maxKg: isDistance ? 0 : heaviest.weight,
          repsAtMax: isDistance ? 0 : heaviest.reps,
          distanceKm: isDistance
            ? sets.reduce((sum, set) => sum + (set.distanceKm ?? 0), 0)
            : 0,
        };
      }),
    }));

  const favorites = source.favorites.slice(0, 20).map((favorite) => ({
    name: String(favorite.name ?? "").slice(0, 60),
    metric: favorite.metric === "distance" ? "distance" : "weight",
  }));

  return { date: todayKey(), recentSessions: history, favorites };
};

const storeDecision = (decision: Decision) => {
  const key = "first-rep-morning-decisions";
  const current = readArray<{
    date: string;
    decision: Decision;
    decidedAt: string;
    xp?: number;
  }>(key).filter((item) => item.date !== todayKey());
  current.push({
    date: todayKey(),
    decision,
    decidedAt: new Date().toISOString(),
    xp: decision === "go" ? 100 : 0,
  });
  window.localStorage.setItem(key, JSON.stringify(current.slice(-90)));
};

const shiftDateKey = (key: string, amount: number) => {
  const date = new Date(`${key}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const calculateMissionStats = (): MissionStats => {
  const decisions = readArray<{
    date?: string;
    decision?: Decision;
    xp?: number;
  }>("first-rep-morning-decisions");
  const activeDates = new Set(
    decisions
      .filter((item) => item.decision === "go" && typeof item.date === "string")
      .map((item) => item.date as string),
  );

  readArray<StoredSession>("first-rep-history").forEach((session) => {
    if (typeof session.date === "string")
      activeDates.add(session.date.slice(0, 10));
  });

  const today = todayKey();
  let cursor = activeDates.has(today) ? today : shiftDateKey(today, -1);
  let streak = 0;
  while (activeDates.has(cursor) && streak < 365) {
    streak += 1;
    cursor = shiftDateKey(cursor, -1);
  }

  const weekGoes = Array.from({ length: 7 }, (_, index) =>
    shiftDateKey(today, -index),
  ).filter((key) => activeDates.has(key)).length;
  const totalXp = decisions.reduce(
    (sum, item) => sum + (item.decision === "go" ? (item.xp ?? 100) : 0),
    0,
  );

  return { streak, weekGoes, totalXp };
};

export default function MorningBridge() {
  const [dateLabel, setDateLabel] = useState("");
  const [decision, setDecision] = useState<Decision | null>(null);
  const [todayDecision, setTodayDecision] = useState<Decision | null>(null);
  const [coach, setCoach] = useState<CoachResult | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">(
    "idle",
  );
  const [error, setError] = useState("");
  const [missionStats, setMissionStats] = useState<MissionStats>({
    streak: 0,
    weekGoes: 0,
    totalXp: 0,
  });
  const [skipOpen, setSkipOpen] = useState(false);
  const [skipProgress, setSkipProgress] = useState(0);
  const [skipHolding, setSkipHolding] = useState(false);
  const holdInterval = useRef<number | null>(null);
  const holdTimeout = useRef<number | null>(null);

  useEffect(() => {
    setDateLabel(
      new Intl.DateTimeFormat("ko-KR", {
        month: "long",
        day: "numeric",
        weekday: "long",
      }).format(new Date()),
    );
    setMissionStats(calculateMissionStats());

    // Restore today's committed decision so re-tapping the same one won't re-run the coach.
    const decisions = readArray<{ date?: string; decision?: Decision }>(
      "first-rep-morning-decisions",
    );
    const todays = decisions.find((item) => item.date === todayKey());
    if (todays?.decision === "go" || todays?.decision === "no_go") {
      setTodayDecision(todays.decision);
    }
    // If we cached today's coach result, restore the whole card without another request.
    const cached = readCoachResultCache();
    if (cached && cached.date === todayKey()) {
      setTodayDecision(cached.decision);
      setDecision(cached.decision);
      setCoach(cached.coach);
      setStatus("done");
    }
  }, []);

  const clearSkipHold = () => {
    if (holdInterval.current !== null)
      window.clearInterval(holdInterval.current);
    if (holdTimeout.current !== null) window.clearTimeout(holdTimeout.current);
    holdInterval.current = null;
    holdTimeout.current = null;
    setSkipHolding(false);
    setSkipProgress(0);
  };

  useEffect(
    () => () => {
      if (holdInterval.current !== null)
        window.clearInterval(holdInterval.current);
      if (holdTimeout.current !== null)
        window.clearTimeout(holdTimeout.current);
    },
    [],
  );

  const choose = async (nextDecision: Decision) => {
    if (status === "loading") return;

    // Re-selecting the same decision that already has a coached plan → render the cache, no re-POST.
    if (nextDecision === todayDecision) {
      const cached = readCoachResultCache();
      if (
        cached &&
        cached.date === todayKey() &&
        cached.decision === nextDecision
      ) {
        setDecision(nextDecision);
        setCoach(cached.coach);
        setError("");
        setStatus("done");
        setSkipOpen(false);
        clearSkipHold();
        return;
      }
    }

    setDecision(nextDecision);
    setCoach(null);
    setError("");
    setStatus("loading");
    setSkipOpen(false);
    clearSkipHold();

    // Log XP only on the first decision of the day or a real switch — not a same-decision re-tap.
    if (nextDecision !== todayDecision) {
      storeDecision(nextDecision);
      setTodayDecision(nextDecision);
      setMissionStats(calculateMissionStats());
    }

    try {
      const response = await fetch("/api/morning-coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: nextDecision,
          context: await buildCoachContext(),
        }),
      });
      const data = (await response.json()) as {
        coach?: CoachResult;
        error?: string;
        code?: string;
      };
      if (!response.ok || !data.coach) {
        const suffix =
          data.code === "openai_not_configured"
            ? " 서버에 OPENAI_API_KEY를 설정하면 바로 활성화됩니다."
            : "";
        throw new Error(
          `${data.error ?? "AI 코치 응답을 받지 못했습니다."}${suffix}`,
        );
      }
      setCoach(data.coach);
      setStatus("done");
      // Cache today's result for reload restore and same-decision duplicate guard (incl. DB-less local).
      writeCoachResultCache({
        date: todayKey(),
        decision: nextDecision,
        coach: data.coach,
      });
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "AI 코치 연결에 실패했습니다.",
      );
      setStatus("error");
    }
  };

  const startSkipHold = () => {
    if (skipHolding || status === "loading") return;
    const startedAt = performance.now();
    setSkipHolding(true);
    setSkipProgress(1);
    holdInterval.current = window.setInterval(() => {
      setSkipProgress(
        Math.min(100, ((performance.now() - startedAt) / 3000) * 100),
      );
    }, 40);
    holdTimeout.current = window.setTimeout(() => {
      if (holdInterval.current !== null)
        window.clearInterval(holdInterval.current);
      holdInterval.current = null;
      holdTimeout.current = null;
      setSkipHolding(false);
      setSkipProgress(100);
      void choose("no_go");
    }, 3000);
  };

  const usePlan = () => {
    if (!coach || coach.exercises.length === 0) return;
    const exercises: StoredExercise[] = coach.exercises.map((exercise) => ({
      id: uid(),
      name: exercise.name,
      metric: exercise.metric,
      sets:
        exercise.metric === "distance"
          ? [
              {
                id: uid(),
                weight: 0,
                reps: 1,
                done: true,
                distanceKm: exercise.targetValue,
              },
            ]
          : Array.from({ length: exercise.sets }, () => ({
              id: uid(),
              weight: exercise.targetValue,
              reps: exercise.reps,
              done: true,
            })),
    }));
    window.localStorage.setItem(
      "first-rep-coach-draft",
      JSON.stringify({
        date: todayKey(),
        createdAt: new Date().toISOString(),
        exercises,
      }),
    );
    window.location.assign("/?coach=today");
  };

  return (
    <main className="morning-page">
      <section className="morning-card">
        <header className="morning-head">
          <Link href="/" aria-label="운동 달력으로 돌아가기">
            <span>1</span>
            <b>FIRST REP</b>
          </Link>
          <p>{dateLabel || "오늘"}</p>
        </header>

        <div className="mission-hud" aria-label="운동 퀘스트 현황">
          <div>
            <span className="streak-fire" aria-hidden="true">
              ◆
            </span>
            <p>
              <b>{missionStats.streak || "NEW"}</b>
              <small>DAY STREAK</small>
            </p>
          </div>
          <div className="mission-progress">
            <span>
              <b>WEEK MISSION</b>
              <small>{missionStats.weekGoes}/4 출석</small>
            </span>
            <i>
              <em
                style={{
                  width: `${Math.min(100, (missionStats.weekGoes / 4) * 100)}%`,
                }}
              />
            </i>
          </div>
          <div className="xp-total">
            <small>TOTAL XP</small>
            <b>{missionStats.totalXp.toLocaleString("ko-KR")}</b>
          </div>
        </div>

        <div className="morning-copy">
          <span>06:00 · TODAY&apos;S QUEST</span>
          <h1>
            {decision === null
              ? "첫 세트를 쟁취하라."
              : decision === "go"
                ? "퀘스트를 수락했다."
                : "오늘 퀘스트를 포기했다."}
          </h1>
          <p>
            {decision === null
              ? "목표는 운동을 잘하는 게 아닙니다. 헬스장에 도착해 첫 세트를 시작하는 것입니다."
              : "결정은 기록됐습니다. AI가 바로 다음 행동만 정리합니다."}
          </p>
        </div>

        {decision === null && !skipOpen && (
          <section className="quest-card" aria-label="오늘의 운동 퀘스트">
            <div className="quest-card-top">
              <span>MAIN QUEST · 01</span>
              <b>+100 XP</b>
            </div>
            <div className="quest-objective">
              <span aria-hidden="true">01</span>
              <div>
                <small>OBJECTIVE</small>
                <strong>헬스장에 가서 첫 세트 완료</strong>
              </div>
            </div>
            <button
              className="quest-accept"
              onClick={() => choose("go")}
              disabled={status === "loading"}
            >
              <span>퀘스트 수락 · 지금 출발</span>
              <b aria-hidden="true">→</b>
            </button>
            <button className="skip-open" onClick={() => setSkipOpen(true)}>
              오늘은 패스
            </button>
          </section>
        )}

        {decision === null && skipOpen && (
          <section className="skip-gate" aria-label="오늘 운동 포기 확인">
            <span>ABANDON QUEST?</span>
            <h2>정말 오늘을 넘길 건가요?</h2>
            <p>
              회복이 필요한 날이라면 괜찮습니다. 다만 순간의 귀찮음이라면, 다시
              퀘스트로 돌아가세요.
            </p>
            <button
              className={`hold-to-skip ${skipHolding ? "holding" : ""}`}
              style={
                { "--hold-progress": `${skipProgress}%` } as React.CSSProperties
              }
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                startSkipHold();
              }}
              onPointerUp={clearSkipHold}
              onPointerCancel={clearSkipHold}
              onKeyDown={(event) => {
                if (
                  (event.key === " " || event.key === "Enter") &&
                  !event.repeat
                ) {
                  event.preventDefault();
                  startSkipHold();
                }
              }}
              onKeyUp={(event) => {
                if (event.key === " " || event.key === "Enter") clearSkipHold();
              }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <span>
                {skipHolding ? "계속 누르세요" : "3초 길게 눌러 포기 확정"}
              </span>
              <i aria-hidden="true" />
            </button>
            <button
              className="return-quest"
              onClick={() => {
                clearSkipHold();
                setSkipOpen(false);
              }}
            >
              ← 다시 퀘스트로 돌아가기
            </button>
          </section>
        )}

        {decision !== null && (
          <div className={`decision-lock ${decision}`}>
            <span>
              {decision === "go" ? "QUEST ACCEPTED" : "QUEST ABANDONED"}
            </span>
            <strong>{decision === "go" ? "+100 XP" : "NO XP"}</strong>
          </div>
        )}

        {status === "loading" && (
          <div className="coach-loading" role="status">
            <span />
            <p>최근 기록을 읽고 있습니다.</p>
          </div>
        )}

        {status === "error" && (
          <section className="coach-error" role="alert">
            <b>결정은 저장됐습니다.</b>
            <p>{error}</p>
            <div>
              <button onClick={() => decision && choose(decision)}>
                다시 연결
              </button>
              <Link href="/">달력으로 이동</Link>
            </div>
          </section>
        )}

        {status === "done" && coach && (
          <section className="coach-result">
            <div className="coach-result-head">
              <span>OPENAI COACH</span>
              <i>{coach.nextAction}</i>
            </div>
            <h2>{coach.headline}</h2>
            <p>{coach.message}</p>

            {coach.exercises.length > 0 && (
              <div className="coach-plan">
                <b>{coach.planLabel}</b>
                {coach.exercises.map((exercise, index) => (
                  <div key={`${exercise.name}-${index}`}>
                    <span>{pad(index + 1)}</span>
                    <strong>{exercise.name}</strong>
                    <small>
                      {exercise.metric === "distance"
                        ? `${exercise.targetValue}km`
                        : `${exercise.sets} × ${exercise.reps} · ${exercise.targetValue || "직접 입력"}kg`}
                    </small>
                  </div>
                ))}
              </div>
            )}

            {coach.progressNote && (
              <p className="coach-progress">
                <span>PROGRESS</span>
                {coach.progressNote}
              </p>
            )}

            <small className="safety-note">{coach.safetyNote}</small>
            <div className="coach-actions">
              {coach.exercises.length > 0 ? (
                <button onClick={usePlan}>이 계획으로 시작</button>
              ) : (
                <Link className="primary" href="/">
                  오늘 결정 완료
                </Link>
              )}
              <button
                className="secondary"
                onClick={() => {
                  setDecision(null);
                  setCoach(null);
                  setStatus("idle");
                  setSkipOpen(false);
                }}
              >
                결정 바꾸기
              </button>
            </div>
          </section>
        )}
      </section>
    </main>
  );
}
