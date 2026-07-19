"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Tab = "today" | "live" | "history" | "coach";
type Readiness = "push" | "maintain" | "recover";

type WorkoutSet = {
  id: string;
  weight: number;
  reps: number;
  done: boolean;
  previous?: string;
};

type Exercise = {
  id: string;
  name: string;
  sets: WorkoutSet[];
};

type Session = {
  id: string;
  date: string;
  title: string;
  durationMinutes: number;
  lane: Readiness;
  exercises: Exercise[];
};

const uid = () => Math.random().toString(36).slice(2, 9);

const createWorkout = (): Exercise[] => [
  {
    id: uid(),
    name: "백 스쿼트",
    sets: [
      { id: uid(), weight: 50, reps: 8, done: false, previous: "50 × 8" },
      { id: uid(), weight: 60, reps: 6, done: false, previous: "57.5 × 6" },
      { id: uid(), weight: 60, reps: 6, done: false, previous: "57.5 × 5" },
      { id: uid(), weight: 55, reps: 8, done: false, previous: "55 × 8" },
    ],
  },
  {
    id: uid(),
    name: "벤치 프레스",
    sets: [
      { id: uid(), weight: 42.5, reps: 8, done: false, previous: "42.5 × 8" },
      { id: uid(), weight: 47.5, reps: 6, done: false, previous: "45 × 7" },
      { id: uid(), weight: 47.5, reps: 6, done: false, previous: "45 × 6" },
    ],
  },
  {
    id: uid(),
    name: "시티드 케이블 로우",
    sets: [
      { id: uid(), weight: 45, reps: 10, done: false, previous: "42.5 × 10" },
      { id: uid(), weight: 45, reps: 10, done: false, previous: "42.5 × 10" },
      { id: uid(), weight: 45, reps: 10, done: false, previous: "42.5 × 9" },
    ],
  },
];

const seedHistory: Session[] = [
  {
    id: "seed-1",
    date: "2026-07-17T06:14:00+09:00",
    title: "Full Body · A",
    durationMinutes: 38,
    lane: "push",
    exercises: [
      { id: "e-1", name: "백 스쿼트", sets: [
        { id: "s-1", weight: 50, reps: 8, done: true },
        { id: "s-2", weight: 57.5, reps: 6, done: true },
        { id: "s-3", weight: 57.5, reps: 5, done: true },
        { id: "s-4", weight: 55, reps: 8, done: true },
      ] },
      { id: "e-2", name: "벤치 프레스", sets: [
        { id: "s-5", weight: 42.5, reps: 8, done: true },
        { id: "s-6", weight: 45, reps: 7, done: true },
        { id: "s-7", weight: 45, reps: 6, done: true },
      ] },
      { id: "e-3", name: "시티드 케이블 로우", sets: [
        { id: "s-8", weight: 42.5, reps: 10, done: true },
        { id: "s-9", weight: 42.5, reps: 10, done: true },
        { id: "s-10", weight: 42.5, reps: 9, done: true },
      ] },
    ],
  },
  {
    id: "seed-2",
    date: "2026-07-14T06:18:00+09:00",
    title: "Full Body · B",
    durationMinutes: 34,
    lane: "maintain",
    exercises: [
      { id: "e-4", name: "백 스쿼트", sets: [
        { id: "s-11", weight: 50, reps: 8, done: true },
        { id: "s-12", weight: 55, reps: 6, done: true },
        { id: "s-13", weight: 55, reps: 6, done: true },
      ] },
      { id: "e-5", name: "벤치 프레스", sets: [
        { id: "s-14", weight: 40, reps: 8, done: true },
        { id: "s-15", weight: 42.5, reps: 7, done: true },
        { id: "s-16", weight: 42.5, reps: 6, done: true },
      ] },
      { id: "e-6", name: "랫 풀다운", sets: [
        { id: "s-17", weight: 45, reps: 10, done: true },
        { id: "s-18", weight: 45, reps: 9, done: true },
        { id: "s-19", weight: 40, reps: 11, done: true },
      ] },
    ],
  },
];

const sessionSets = (session: Session) => session.exercises.flatMap((exercise) => exercise.sets.filter((set) => set.done));
const sessionVolume = (session: Session) => sessionSets(session).reduce((total, set) => total + set.weight * set.reps, 0);
const formatNumber = (value: number) => new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(value);
const formatDate = (date: string) => new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "short" }).format(new Date(date));

const laneCopy: Record<Readiness, { label: string; title: string; detail: string }> = {
  push: { label: "A · PUSH", title: "정상 세션", detail: "점진적 과부하 적용 · 35분" },
  maintain: { label: "B · MAINTAIN", title: "볼륨 70%", detail: "핵심 리프트 유지 · 25분" },
  recover: { label: "C · RECOVER", title: "회복 프로토콜", detail: "관절·코어 중심 · 12분" },
};

export default function Home() {
  const [tab, setTab] = useState<Tab>("today");
  const [readiness, setReadiness] = useState<Readiness>("push");
  const [exercises, setExercises] = useState<Exercise[]>(createWorkout);
  const [history, setHistory] = useState<Session[]>(seedHistory);
  const [newExercise, setNewExercise] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [restSeconds, setRestSeconds] = useState(0);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [toast, setToast] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem("first-rep-history");
    if (stored) {
      try { setHistory(JSON.parse(stored)); } catch { /* keep demo history */ }
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (loaded) window.localStorage.setItem("first-rep-history", JSON.stringify(history));
  }, [history, loaded]);

  useEffect(() => {
    if (!sessionStartedAt) return;
    const tick = () => setElapsed(Math.floor((Date.now() - sessionStartedAt) / 1000));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [sessionStartedAt]);

  useEffect(() => {
    if (restSeconds <= 0) return;
    const timer = window.setInterval(() => setRestSeconds((current) => Math.max(0, current - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [restSeconds]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const activeStats = useMemo(() => {
    const doneSets = exercises.flatMap((exercise) => exercise.sets.filter((set) => set.done));
    return {
      sets: doneSets.length,
      volume: doneSets.reduce((sum, set) => sum + set.weight * set.reps, 0),
      max: doneSets.reduce((max, set) => Math.max(max, set.weight), 0),
    };
  }, [exercises]);

  const allTimeStats = useMemo(() => {
    const sets = history.flatMap(sessionSets);
    return {
      sessions: history.length,
      sets: sets.length,
      volume: history.reduce((sum, session) => sum + sessionVolume(session), 0),
      max: sets.reduce((max, set) => Math.max(max, set.weight), 0),
    };
  }, [history]);

  const exerciseRecords = useMemo(() => {
    const records = new Map<string, { sessions: Set<string>; sets: number; max: number; best: string; volume: number }>();
    history.forEach((session) => session.exercises.forEach((exercise) => {
      const current = records.get(exercise.name) ?? { sessions: new Set<string>(), sets: 0, max: 0, best: "—", volume: 0 };
      current.sessions.add(session.id);
      exercise.sets.filter((set) => set.done).forEach((set) => {
        current.sets += 1;
        current.volume += set.weight * set.reps;
        if (set.weight > current.max) {
          current.max = set.weight;
          current.best = `${formatNumber(set.weight)}kg × ${set.reps}`;
        }
      });
      records.set(exercise.name, current);
    }));
    return [...records.entries()].map(([name, record]) => ({ name, ...record, sessions: record.sessions.size }));
  }, [history]);

  const startWorkout = () => {
    setSessionStartedAt(Date.now());
    setElapsed(0);
    setTab("live");
  };

  const updateSet = (exerciseId: string, setId: string, patch: Partial<WorkoutSet>) => {
    setExercises((current) => current.map((exercise) => exercise.id === exerciseId
      ? { ...exercise, sets: exercise.sets.map((set) => set.id === setId ? { ...set, ...patch } : set) }
      : exercise));
  };

  const toggleSet = (exerciseId: string, set: WorkoutSet) => {
    updateSet(exerciseId, set.id, { done: !set.done });
    if (!set.done) setRestSeconds(90);
  };

  const addSet = (exerciseId: string) => {
    setExercises((current) => current.map((exercise) => {
      if (exercise.id !== exerciseId) return exercise;
      const last = exercise.sets.at(-1);
      return { ...exercise, sets: [...exercise.sets, { id: uid(), weight: last?.weight ?? 0, reps: last?.reps ?? 8, done: false, previous: "—" }] };
    }));
  };

  const removeSet = (exerciseId: string, setId: string) => {
    setExercises((current) => current.map((exercise) => exercise.id === exerciseId
      ? { ...exercise, sets: exercise.sets.filter((set) => set.id !== setId) }
      : exercise));
  };

  const addExercise = (event: FormEvent) => {
    event.preventDefault();
    const name = newExercise.trim();
    if (!name) return;
    setExercises((current) => [...current, {
      id: uid(),
      name,
      sets: [{ id: uid(), weight: 0, reps: 8, done: false, previous: "—" }],
    }]);
    setNewExercise("");
  };

  const finishWorkout = () => {
    if (activeStats.sets === 0) {
      setToast("완료한 세트가 아직 없습니다.");
      return;
    }
    const completedExercises = exercises
      .map((exercise) => ({ ...exercise, sets: exercise.sets.filter((set) => set.done) }))
      .filter((exercise) => exercise.sets.length > 0);
    const session: Session = {
      id: uid(),
      date: new Date().toISOString(),
      title: `Morning Strength · ${laneCopy[readiness].label.charAt(0)}`,
      durationMinutes: Math.max(1, Math.round(elapsed / 60)),
      lane: readiness,
      exercises: completedExercises,
    };
    setHistory((current) => [session, ...current]);
    setExercises(createWorkout());
    setSessionStartedAt(null);
    setElapsed(0);
    setRestSeconds(0);
    setToast(`${sessionSets(session).length}세트 · ${formatNumber(sessionVolume(session))}kg 저장 완료`);
    setTab("history");
  };

  const elapsedLabel = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  const restLabel = `${String(Math.floor(restSeconds / 60)).padStart(2, "0")}:${String(restSeconds % 60).padStart(2, "0")}`;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setTab("today")} aria-label="FIRST REP 홈">
          <span className="brand-mark">1</span>
          <span><strong>FIRST REP</strong><small>06:00 PROTOCOL</small></span>
        </button>
        <nav aria-label="주요 메뉴">
          <button className={tab === "today" ? "active" : ""} onClick={() => setTab("today")}><span>01</span>오늘</button>
          <button className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}><span>02</span>운동 기록</button>
          <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}><span>03</span>히스토리</button>
          <button className={tab === "coach" ? "active" : ""} onClick={() => setTab("coach")}><span>04</span>AI 코치</button>
        </nav>
        <div className="streak-card">
          <span>CONSISTENCY</span>
          <strong>12</strong>
          <p>일 연속 계획 이행</p>
          <div><i style={{ width: "78%" }} /></div>
          <small>이번 달 7 / 9 세션</small>
        </div>
        <div className="profile-line"><span>IJ</span><div><b>Injeon</b><small>Strength · Level 04</small></div></div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div><span className="status-dot" /> MORNING SYSTEM ONLINE</div>
          <div className="top-actions"><span>SEOUL · KST</span><button onClick={() => setTab("history")}>기록 보기</button></div>
        </header>

        {tab === "today" && (
          <section className="page today-page">
            <div className="page-kicker">SUNDAY · JUL 19</div>
            <div className="today-grid">
              <div className="contract-card">
                <div className="contract-head">
                  <span>TODAY&apos;S CONTRACT</span>
                  <span className="time">06:16</span>
                </div>
                <h1>첫 세트 전까지<br />협상하지 않는다.</h1>
                <p className="lead">지난 2회 기록과 오늘 컨디션을 기준으로 만든 35분 전신 세션입니다.</p>

                <div className="readiness-label"><b>오늘의 레인 선택</b><span>수면 · 통증 · 가용 시간을 반영하세요</span></div>
                <div className="readiness-options">
                  {(Object.keys(laneCopy) as Readiness[]).map((lane) => (
                    <button key={lane} className={readiness === lane ? "selected" : ""} onClick={() => setReadiness(lane)}>
                      <span>{laneCopy[lane].label}</span>
                      <b>{laneCopy[lane].title}</b>
                      <small>{laneCopy[lane].detail}</small>
                    </button>
                  ))}
                </div>

                <div className="plan-preview">
                  <div className="plan-title"><span>오늘 처방</span><span>{exercises.reduce((sum, exercise) => sum + exercise.sets.length, 0)} SETS</span></div>
                  {exercises.map((exercise, index) => (
                    <div className="plan-row" key={exercise.id}>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <b>{exercise.name}</b>
                      <small>{exercise.sets.length}세트 · 최고 {formatNumber(Math.max(...exercise.sets.map((set) => set.weight)))}kg</small>
                    </div>
                  ))}
                </div>

                <button className="primary-action" onClick={startWorkout}><span>처방 수락하고 시작</span><b>FIRST REP →</b></button>
              </div>

              <aside className="today-rail">
                <div className="metric-card hero-metric">
                  <span>FIRST REP DEADLINE</span>
                  <strong>06:20</strong>
                  <p>남은 시간 <b>04:12</b></p>
                </div>
                <div className="coach-note">
                  <span>AI COACH · WHY</span>
                  <p>스쿼트는 최근 두 세션에서 목표 반복을 모두 달성했습니다. 오늘 두 번째 세트부터 <b>+2.5kg</b>를 제안합니다.</p>
                </div>
                <div className="last-session">
                  <div><span>LAST SESSION</span><small>7월 17일</small></div>
                  <strong>10 sets</strong>
                  <p>총 볼륨 {formatNumber(sessionVolume(seedHistory[0]))}kg</p>
                  <ul>
                    <li><span>백 스쿼트</span><b>57.5kg</b></li>
                    <li><span>벤치 프레스</span><b>45kg</b></li>
                    <li><span>케이블 로우</span><b>42.5kg</b></li>
                  </ul>
                </div>
              </aside>
            </div>
          </section>
        )}

        {tab === "live" && (
          <section className="page live-page">
            <div className="live-header">
              <div><span className="page-kicker">NOW TRAINING</span><h1>Morning Strength</h1></div>
              <div className="live-totals">
                <div><span>TIME</span><b>{elapsedLabel}</b></div>
                <div><span>SETS</span><b>{activeStats.sets}</b></div>
                <div><span>VOLUME</span><b>{formatNumber(activeStats.volume)}<small>kg</small></b></div>
              </div>
            </div>

            <div className="live-grid">
              <div className="exercise-stack">
                {exercises.map((exercise, exerciseIndex) => {
                  const completed = exercise.sets.filter((set) => set.done);
                  const max = completed.reduce((value, set) => Math.max(value, set.weight), 0);
                  const volume = completed.reduce((value, set) => value + set.weight * set.reps, 0);
                  return (
                    <article className="exercise-card" key={exercise.id}>
                      <header>
                        <div><span>EXERCISE {String(exerciseIndex + 1).padStart(2, "0")}</span><h2>{exercise.name}</h2></div>
                        <div className="exercise-summary"><span>{completed.length}/{exercise.sets.length} SETS</span><b>MAX {formatNumber(max)}kg</b><small>VOL {formatNumber(volume)}kg</small></div>
                      </header>
                      <div className="set-table">
                        <div className="set-row set-head"><span>SET</span><span>PREVIOUS</span><span>KG</span><span>REPS</span><span>DONE</span><span /></div>
                        {exercise.sets.map((set, index) => (
                          <div className={`set-row ${set.done ? "completed" : ""}`} key={set.id}>
                            <b>{index + 1}</b>
                            <span className="previous">{set.previous ?? "—"}</span>
                            <input aria-label={`${exercise.name} ${index + 1}세트 중량`} type="number" inputMode="decimal" step="0.5" min="0" value={set.weight} onChange={(event) => updateSet(exercise.id, set.id, { weight: Number(event.target.value) })} />
                            <input aria-label={`${exercise.name} ${index + 1}세트 반복`} type="number" inputMode="numeric" step="1" min="0" value={set.reps} onChange={(event) => updateSet(exercise.id, set.id, { reps: Number(event.target.value) })} />
                            <button className="done-button" onClick={() => toggleSet(exercise.id, set)} aria-label={`${exercise.name} ${index + 1}세트 ${set.done ? "완료 취소" : "완료"}`}>{set.done ? "✓" : ""}</button>
                            <button className="remove-button" onClick={() => removeSet(exercise.id, set.id)} aria-label={`${index + 1}세트 삭제`}>×</button>
                          </div>
                        ))}
                      </div>
                      <button className="add-set" onClick={() => addSet(exercise.id)}>＋ 세트 추가</button>
                    </article>
                  );
                })}
                <form className="add-exercise" onSubmit={addExercise}>
                  <input value={newExercise} onChange={(event) => setNewExercise(event.target.value)} placeholder="운동 이름 입력" aria-label="추가할 운동 이름" />
                  <button type="submit">운동 추가</button>
                </form>
              </div>

              <aside className="live-rail">
                <div className={`rest-timer ${restSeconds > 0 ? "running" : ""}`}>
                  <span>REST TIMER</span>
                  <strong>{restLabel}</strong>
                  <p>{restSeconds > 0 ? "호흡을 정리하고 다음 세트를 준비하세요." : "세트를 완료하면 90초가 시작됩니다."}</p>
                  {restSeconds > 0 && <button onClick={() => setRestSeconds(0)}>건너뛰기</button>}
                </div>
                <div className="live-coach">
                  <span>COACH SIGNAL</span>
                  <h3>{activeStats.sets < 2 ? "첫 두 세트는 폼 우선." : "속도가 유지되면 계획대로."}</h3>
                  <p>목표 RPE 7–8. 날카로운 통증이 있으면 즉시 중량을 낮추거나 세션을 중단하세요.</p>
                </div>
                <button className="finish-button" onClick={finishWorkout}><span>세션 종료</span><b>{activeStats.sets} SETS · {formatNumber(activeStats.volume)}kg</b></button>
              </aside>
            </div>
          </section>
        )}

        {tab === "history" && (
          <section className="page history-page">
            <div className="page-title-row"><div><span className="page-kicker">TRAINING LEDGER</span><h1>숫자가 기억하게 한다.</h1></div><button onClick={startWorkout}>＋ 새 운동</button></div>
            <div className="stat-grid">
              <div><span>SESSIONS</span><strong>{allTimeStats.sessions}</strong><small>저장된 운동</small></div>
              <div><span>TOTAL SETS</span><strong>{allTimeStats.sets}</strong><small>완료 세트</small></div>
              <div><span>TOTAL VOLUME</span><strong>{formatNumber(allTimeStats.volume)}<i>kg</i></strong><small>중량 × 반복</small></div>
              <div><span>HEAVIEST</span><strong>{formatNumber(allTimeStats.max)}<i>kg</i></strong><small>단일 세트 최고</small></div>
            </div>

            <div className="history-layout">
              <div className="session-list">
                <div className="section-title"><h2>세션 기록</h2><span>최근순</span></div>
                {history.map((session) => (
                  <article className="session-card" key={session.id}>
                    <header>
                      <div><span>{formatDate(session.date)}</span><h3>{session.title}</h3></div>
                      <div><b>{session.durationMinutes}분</b><small>{sessionSets(session).length}세트 · {formatNumber(sessionVolume(session))}kg</small></div>
                    </header>
                    <div className="session-exercises">
                      {session.exercises.map((exercise) => {
                        const sets = exercise.sets.filter((set) => set.done);
                        const max = sets.reduce((value, set) => Math.max(value, set.weight), 0);
                        const volume = sets.reduce((value, set) => value + set.weight * set.reps, 0);
                        return (
                          <div key={exercise.id}>
                            <div className="exercise-line"><b>{exercise.name}</b><span>{sets.length}세트</span><strong>최고 {formatNumber(max)}kg</strong><small>{formatNumber(volume)}kg volume</small></div>
                            <p>{sets.map((set) => `${formatNumber(set.weight)} × ${set.reps}`).join("  ·  ")}</p>
                          </div>
                        );
                      })}
                    </div>
                  </article>
                ))}
              </div>

              <aside className="records-panel">
                <div className="section-title"><h2>운동별 기록</h2><span>ALL TIME</span></div>
                {exerciseRecords.map((record) => (
                  <div className="record-row" key={record.name}>
                    <div><b>{record.name}</b><small>{record.sessions}회 · {record.sets}세트</small></div>
                    <div><span>MAX</span><strong>{formatNumber(record.max)}kg</strong></div>
                    <div><span>BEST SET</span><strong>{record.best}</strong></div>
                    <div><span>VOLUME</span><strong>{formatNumber(record.volume)}kg</strong></div>
                  </div>
                ))}
              </aside>
            </div>
          </section>
        )}

        {tab === "coach" && (
          <section className="page coach-page">
            <span className="page-kicker">WEEKLY REVIEW · AI COACH</span>
            <h1>응원보다 근거.</h1>
            <div className="coach-grid">
              <article className="coach-hero">
                <span>THIS WEEK</span>
                <h2>하체는 증량,<br />상체는 한 주 더 유지.</h2>
                <p>스쿼트는 최근 두 세션에서 계획 반복을 달성했고 세션 볼륨도 상승했습니다. 벤치 프레스는 마지막 세트 반복이 감소해 47.5kg 적응을 한 번 더 확인합니다.</p>
                <div className="coach-actions"><button>다음 주 계획 보기</button><button className="ghost">기억 수정</button></div>
              </article>
              <div className="signal-list">
                <div><span className="signal up">↑</span><p><b>백 스쿼트 +2.5kg</b><small>목표 반복 2회 연속 달성</small></p></div>
                <div><span className="signal flat">→</span><p><b>벤치 프레스 유지</b><small>마지막 세트 반복 안정화 필요</small></p></div>
                <div><span className="signal up">↑</span><p><b>First Rep 4분 단축</b><small>최근 평균 12분 → 8분</small></p></div>
              </div>
            </div>
            <div className="memory-card">
              <div><span>COACH MEMORY</span><h2>AI가 계획에 사용하는 사실</h2></div>
              <ul><li>목표: 근력과 실행 일관성</li><li>주 3회 · 회당 35분</li><li>가용 장비: 바벨, 덤벨, 케이블</li><li>증량 기본폭: 상체 2.5kg / 하체 2.5–5kg</li><li>금지: 통증을 무시한 강행</li></ul>
            </div>
          </section>
        )}
      </main>

      <nav className="mobile-nav" aria-label="모바일 메뉴">
        <button className={tab === "today" ? "active" : ""} onClick={() => setTab("today")}>오늘</button>
        <button className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}>기록</button>
        <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>히스토리</button>
        <button className={tab === "coach" ? "active" : ""} onClick={() => setTab("coach")}>코치</button>
      </nav>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
