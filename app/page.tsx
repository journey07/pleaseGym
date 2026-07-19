"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type WorkoutSet = {
  id: string;
  weight: number;
  reps: number;
  done: boolean;
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
  lane: "push" | "maintain" | "recover";
  exercises: Exercise[];
};

const uid = () => Math.random().toString(36).slice(2, 9);
const pad = (value: number) => String(value).padStart(2, "0");
const toDateKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const sessionDateKey = (date: string) => toDateKey(new Date(date));
const dateFromKey = (key: string) => new Date(`${key}T12:00:00`);
const formatNumber = (value: number) => new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(value);
const formatSelectedDate = (key: string) => new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  day: "numeric",
  weekday: "long",
}).format(dateFromKey(key));

const seedHistory: Session[] = [
  {
    id: "seed-1",
    date: "2026-07-17T06:14:00+09:00",
    title: "Full Body",
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
    title: "Full Body",
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

const completedSets = (session: Session) => session.exercises.flatMap((exercise) => exercise.sets.filter((set) => set.done));
const sessionVolume = (session: Session) => completedSets(session).reduce((sum, set) => sum + set.weight * set.reps, 0);
const sessionMax = (session: Session) => completedSets(session).reduce((max, set) => Math.max(max, set.weight), 0);
const cloneExercises = (exercises: Exercise[]) => exercises.map((exercise) => ({
  ...exercise,
  sets: exercise.sets.filter((set) => set.done).map((set) => ({ ...set })),
}));

const blankSet = (): WorkoutSet => ({ id: uid(), weight: 0, reps: 8, done: true });

export default function Home() {
  const todayKey = useMemo(() => toDateKey(new Date()), []);
  const [selectedDate, setSelectedDate] = useState(todayKey);
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1);
  });
  const [history, setHistory] = useState<Session[]>(seedHistory);
  const [draft, setDraft] = useState<Exercise[]>([]);
  const [newExercise, setNewExercise] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    const stored = window.localStorage.getItem("first-rep-history");
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as Session[];
        if (Array.isArray(parsed)) setHistory(parsed);
      } catch {
        // Keep the demo history when stored data is malformed.
      }
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (loaded) window.localStorage.setItem("first-rep-history", JSON.stringify(history));
  }, [history, loaded]);

  const sessionsByDate = useMemo(() => {
    const map = new Map<string, Session>();
    history.forEach((session) => map.set(sessionDateKey(session.date), session));
    return map;
  }, [history]);

  const selectedSession = sessionsByDate.get(selectedDate);

  useEffect(() => {
    setDraft(selectedSession ? cloneExercises(selectedSession.exercises) : []);
    setNewExercise("");
    setDirty(false);
  }, [selectedDate, selectedSession]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const calendarDays = useMemo(() => {
    const year = visibleMonth.getFullYear();
    const month = visibleMonth.getMonth();
    const offset = (new Date(year, month, 1).getDay() + 6) % 7;
    const count = new Date(year, month + 1, 0).getDate();
    return Array.from({ length: 42 }, (_, index) => {
      const day = index - offset + 1;
      if (day < 1 || day > count) return null;
      const date = new Date(year, month, day);
      return { day, key: toDateKey(date) };
    });
  }, [visibleMonth]);

  const monthSessions = useMemo(() => {
    const prefix = `${visibleMonth.getFullYear()}-${pad(visibleMonth.getMonth() + 1)}`;
    return history.filter((session) => sessionDateKey(session.date).startsWith(prefix));
  }, [history, visibleMonth]);

  const monthStats = useMemo(() => {
    const sets = monthSessions.flatMap(completedSets);
    return {
      workouts: monthSessions.length,
      sets: sets.length,
      max: sets.reduce((value, set) => Math.max(value, set.weight), 0),
    };
  }, [monthSessions]);

  const draftStats = useMemo(() => {
    const sets = draft.flatMap((exercise) => exercise.sets);
    return {
      sets: sets.length,
      volume: sets.reduce((sum, set) => sum + set.weight * set.reps, 0),
      max: sets.reduce((value, set) => Math.max(value, set.weight), 0),
    };
  }, [draft]);

  const coachInsight = useMemo(() => {
    if (monthSessions.length === 0) return "첫 기록을 남기면 다음 운동의 중량과 반복을 제안할게요.";
    const exerciseCounts = new Map<string, number>();
    monthSessions.forEach((session) => session.exercises.forEach((exercise) => {
      exerciseCounts.set(exercise.name, (exerciseCounts.get(exercise.name) ?? 0) + 1);
    }));
    const mostFrequent = [...exerciseCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    return `${visibleMonth.getMonth() + 1}월 ${monthSessions.length}회 완료. ${mostFrequent?.[0] ?? "운동"}을 가장 꾸준히 기록했어요.`;
  }, [monthSessions, visibleMonth]);

  const selectDate = (key: string) => {
    setSelectedDate(key);
  };

  const moveMonth = (amount: number) => {
    setVisibleMonth((current) => new Date(current.getFullYear(), current.getMonth() + amount, 1));
  };

  const goToday = () => {
    const today = new Date();
    setVisibleMonth(new Date(today.getFullYear(), today.getMonth(), 1));
    setSelectedDate(todayKey);
  };

  const addExercise = (event: FormEvent) => {
    event.preventDefault();
    const name = newExercise.trim();
    if (!name) return;
    setDraft((current) => [...current, { id: uid(), name, sets: [blankSet()] }]);
    setNewExercise("");
    setDirty(true);
  };

  const updateExerciseName = (exerciseId: string, name: string) => {
    setDraft((current) => current.map((exercise) => exercise.id === exerciseId ? { ...exercise, name } : exercise));
    setDirty(true);
  };

  const addSet = (exerciseId: string) => {
    setDraft((current) => current.map((exercise) => {
      if (exercise.id !== exerciseId) return exercise;
      const previous = exercise.sets.at(-1);
      return {
        ...exercise,
        sets: [...exercise.sets, { ...blankSet(), weight: previous?.weight ?? 0, reps: previous?.reps ?? 8 }],
      };
    }));
    setDirty(true);
  };

  const updateSet = (exerciseId: string, setId: string, patch: Partial<WorkoutSet>) => {
    setDraft((current) => current.map((exercise) => exercise.id === exerciseId
      ? { ...exercise, sets: exercise.sets.map((set) => set.id === setId ? { ...set, ...patch } : set) }
      : exercise));
    setDirty(true);
  };

  const removeSet = (exerciseId: string, setId: string) => {
    setDraft((current) => current.map((exercise) => exercise.id === exerciseId
      ? { ...exercise, sets: exercise.sets.filter((set) => set.id !== setId) }
      : exercise));
    setDirty(true);
  };

  const removeExercise = (exerciseId: string) => {
    setDraft((current) => current.filter((exercise) => exercise.id !== exerciseId));
    setDirty(true);
  };

  const saveWorkout = () => {
    const cleaned = draft
      .map((exercise) => ({
        ...exercise,
        name: exercise.name.trim(),
        sets: exercise.sets.filter((set) => Number.isFinite(set.weight) && set.weight >= 0 && Number.isFinite(set.reps) && set.reps > 0)
          .map((set) => ({ ...set, done: true })),
      }))
      .filter((exercise) => exercise.name && exercise.sets.length > 0);

    if (cleaned.length === 0) {
      setToast("운동과 세트를 하나 이상 입력해주세요.");
      return;
    }

    const session: Session = {
      id: selectedSession?.id ?? uid(),
      date: `${selectedDate}T12:00:00`,
      title: cleaned.length === 1 ? cleaned[0].name : `${cleaned.length} exercises`,
      durationMinutes: selectedSession?.durationMinutes ?? 0,
      lane: selectedSession?.lane ?? "maintain",
      exercises: cleaned,
    };

    setHistory((current) => [
      ...current.filter((item) => sessionDateKey(item.date) !== selectedDate),
      session,
    ].sort((a, b) => b.date.localeCompare(a.date)));
    setDraft(cloneExercises(cleaned));
    setDirty(false);
    setToast(selectedSession ? "운동 기록을 수정했어요." : "운동 기록을 저장했어요.");
  };

  const deleteWorkout = () => {
    if (!selectedSession) return;
    if (!window.confirm(`${formatSelectedDate(selectedDate)} 운동 기록을 삭제할까요?`)) return;
    setHistory((current) => current.filter((session) => sessionDateKey(session.date) !== selectedDate));
    setDraft([]);
    setDirty(false);
    setToast("이 날짜의 기록을 삭제했어요.");
  };

  const monthLabel = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long" }).format(visibleMonth);

  return (
    <main className="app">
      <header className="site-header">
        <button className="wordmark" onClick={goToday} aria-label="오늘로 이동">
          <span>1</span>
          <b>FIRST REP</b>
        </button>
        <p>운동을 기억하는 가장 단순한 방법.</p>
        <button className="today-button" onClick={goToday}>오늘</button>
      </header>

      <section className="summary" aria-label="이번 달 요약">
        <div>
          <span>THIS MONTH</span>
          <strong>{monthStats.workouts}<small>회</small></strong>
        </div>
        <div>
          <span>TOTAL SETS</span>
          <strong>{monthStats.sets}<small>세트</small></strong>
        </div>
        <div>
          <span>HEAVIEST</span>
          <strong>{formatNumber(monthStats.max)}<small>kg</small></strong>
        </div>
        <div className="coach-summary">
          <span>AI COACH</span>
          <p>{coachInsight}</p>
        </div>
      </section>

      <div className="workspace">
        <section className="calendar-panel">
          <div className="calendar-toolbar">
            <div>
              <span>TRAINING CALENDAR</span>
              <h1>{monthLabel}</h1>
            </div>
            <div className="month-controls">
              <button onClick={() => moveMonth(-1)} aria-label="이전 달">←</button>
              <button onClick={() => moveMonth(1)} aria-label="다음 달">→</button>
            </div>
          </div>

          <div className="weekdays" aria-hidden="true">
            {['월', '화', '수', '목', '금', '토', '일'].map((day) => <span key={day}>{day}</span>)}
          </div>
          <div className="calendar-grid">
            {calendarDays.map((date, index) => {
              if (!date) return <div className="calendar-empty" key={`empty-${index}`} />;
              const session = sessionsByDate.get(date.key);
              const sets = session ? completedSets(session).length : 0;
              return (
                <button
                  key={date.key}
                  className={`calendar-day ${selectedDate === date.key ? "selected" : ""} ${date.key === todayKey ? "today" : ""} ${session ? "has-workout" : ""}`}
                  onClick={() => selectDate(date.key)}
                  aria-pressed={selectedDate === date.key}
                  aria-label={`${date.day}일${session ? `, 운동 ${sets}세트` : ", 기록 없음"}`}
                >
                  <span className="day-number">{date.day}</span>
                  {session ? (
                    <span className="day-workout">
                      <i />
                      <b>{sets} sets</b>
                      <small>max {formatNumber(sessionMax(session))}kg</small>
                    </span>
                  ) : <span className="add-hint">＋ 기록</span>}
                </button>
              );
            })}
          </div>
        </section>

        <aside className="editor-panel">
          <div className="editor-head">
            <div>
              <span>{selectedSession ? "WORKOUT LOG" : "NEW WORKOUT"}</span>
              <h2>{formatSelectedDate(selectedDate)}</h2>
            </div>
            {dirty && <i>수정 중</i>}
          </div>

          {draft.length > 0 ? (
            <div className="draft-list">
              {draft.map((exercise, exerciseIndex) => {
                const max = exercise.sets.reduce((value, set) => Math.max(value, set.weight), 0);
                return (
                  <article className="exercise-entry" key={exercise.id}>
                    <div className="exercise-head">
                      <span>{pad(exerciseIndex + 1)}</span>
                      <input
                        value={exercise.name}
                        onChange={(event) => updateExerciseName(exercise.id, event.target.value)}
                        aria-label={`${exerciseIndex + 1}번째 운동 이름`}
                      />
                      <small>MAX {formatNumber(max)}kg</small>
                      <button onClick={() => removeExercise(exercise.id)} aria-label={`${exercise.name} 삭제`}>×</button>
                    </div>
                    <div className="sets-head"><span>SET</span><span>KG</span><span>REPS</span><span /></div>
                    {exercise.sets.map((set, setIndex) => (
                      <div className="set-entry" key={set.id}>
                        <b>{setIndex + 1}</b>
                        <input
                          type="number"
                          min="0"
                          step="0.5"
                          inputMode="decimal"
                          value={set.weight}
                          onChange={(event) => updateSet(exercise.id, set.id, { weight: Number(event.target.value) })}
                          aria-label={`${exercise.name} ${setIndex + 1}세트 중량`}
                        />
                        <input
                          type="number"
                          min="1"
                          step="1"
                          inputMode="numeric"
                          value={set.reps}
                          onChange={(event) => updateSet(exercise.id, set.id, { reps: Number(event.target.value) })}
                          aria-label={`${exercise.name} ${setIndex + 1}세트 반복`}
                        />
                        <button onClick={() => removeSet(exercise.id, set.id)} aria-label={`${setIndex + 1}세트 삭제`}>×</button>
                      </div>
                    ))}
                    <button className="add-set-button" onClick={() => addSet(exercise.id)}>＋ 세트</button>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="empty-editor">
              <span>＋</span>
              <h3>이날의 첫 운동</h3>
              <p>운동 이름을 입력하면 바로 세트를 기록할 수 있어요.</p>
            </div>
          )}

          <form className="add-exercise" onSubmit={addExercise}>
            <input
              value={newExercise}
              onChange={(event) => setNewExercise(event.target.value)}
              placeholder="예: 백 스쿼트"
              aria-label="추가할 운동 이름"
            />
            <button type="submit">추가</button>
          </form>

          <div className="draft-summary">
            <span>{draftStats.sets} sets</span>
            <span>{formatNumber(draftStats.volume)}kg volume</span>
            <span>max {formatNumber(draftStats.max)}kg</span>
          </div>

          <div className="editor-actions">
            {selectedSession && <button className="delete-button" onClick={deleteWorkout}>삭제</button>}
            <button className="save-button" onClick={saveWorkout}>{selectedSession ? "기록 수정" : "운동 저장"}</button>
          </div>
        </aside>
      </div>

      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
