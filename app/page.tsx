"use client";

import {
  FormEvent,
  ReactNode,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import Link from "next/link";
import {
  DndContext,
  DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { BodyPart, BODY_PARTS, inferBodyPart } from "./lib/bodyPart";

type SortableRenderProps = {
  setNodeRef: (node: HTMLElement | null) => void;
  style: React.CSSProperties;
  handleProps: Record<string, unknown>;
  isDragging: boolean;
};

function SortableExercise({
  id,
  children,
}: {
  id: string;
  children: (props: SortableRenderProps) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 2 : undefined,
  };
  return (
    <>
      {children({
        setNodeRef,
        style,
        handleProps: { ...attributes, ...listeners },
        isDragging,
      })}
    </>
  );
}

type WorkoutSet = {
  id: string;
  weight: number;
  reps: number;
  done: boolean;
  distanceKm?: number;
  inheritWeight?: boolean;
  inheritReps?: boolean;
};

type Metric = "weight" | "distance" | "bodyweight";

type Exercise = {
  id: string;
  name: string;
  // "bodyweight": reps는 주 지표, weight 필드는 추가중량(+kg, 기본 0)으로 재사용.
  metric?: Metric;
  sets: WorkoutSet[];
  bodyPart?: BodyPart;
  bodyPartManual?: boolean;
};

type BodyGroup = "upper" | "lower" | "cardio" | "neutral";

// 달력 색 구분: 상체(빨강)/하체(파랑)/유산소(보라)/중립(회색).
const bodyGroup = (exercise: Exercise): BodyGroup => {
  if (exercise.metric === "distance") return "cardio";
  const part = exercise.bodyPart ?? inferBodyPart(exercise.name);
  if (part === "허벅지" || part === "종아리") return "lower";
  if (part === "기타") return "neutral";
  return "upper"; // 가슴·등·어깨·팔·복근·허리
};

const exerciseBodyPart = (exercise: Exercise): BodyPart =>
  exercise.bodyPart ?? inferBodyPart(exercise.name);

type Session = {
  id: string;
  date: string;
  title: string;
  durationMinutes: number;
  lane: "push" | "maintain" | "recover";
  exercises: Exercise[];
};

type FavoriteExercise = {
  id: string;
  name: string;
  metric: Metric;
};

type TrainingReport = {
  headline: string;
  overall: string;
  frequencyComment: string;
  liftAnalysis: Array<{
    name: string;
    trend: "up" | "flat" | "down" | "new";
    comment: string;
  }>;
  actionItems: string[];
  warning: string;
};

type TrainingStats = {
  totalSessions: number;
  sessionsLast7Days: number;
  sessionsLast28Days: number;
  trackingDays: number;
  perWeekRecent: number;
};

type TrainingReportCache = {
  date: string;
  report: TrainingReport;
  stats: TrainingStats;
};

const REPORT_CACHE_KEY = "first-rep-training-report";

const trendSymbol: Record<
  TrainingReport["liftAnalysis"][number]["trend"],
  string
> = { up: "↑", flat: "→", down: "↓", new: "＋" };

const trendLabel: Record<
  TrainingReport["liftAnalysis"][number]["trend"],
  string
> = { up: "상승", flat: "정체", down: "하락", new: "신규" };

const uid = () => Math.random().toString(36).slice(2, 9);
const subscribeToHydration = () => () => undefined;
const pad = (value: number) => String(value).padStart(2, "0");
const toDateKey = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const sessionDateKey = (date: string) => toDateKey(new Date(date));
const dateFromKey = (key: string) => new Date(`${key}T12:00:00`);
const formatNumber = (value: number) =>
  new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(value);
const formatSelectedDate = (key: string) =>
  new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(dateFromKey(key));

const fixedHolidays: Record<string, string> = {
  "01-01": "신정",
  "03-01": "삼일절",
  "05-05": "어린이날",
  "06-06": "현충일",
  "08-15": "광복절",
  "10-03": "개천절",
  "10-09": "한글날",
  "12-25": "성탄절",
};

const holidays2026: Record<string, string> = {
  "2026-02-16": "설날 연휴",
  "2026-02-17": "설날",
  "2026-02-18": "설날 연휴",
  "2026-03-02": "대체공휴일",
  "2026-05-01": "노동절",
  "2026-05-24": "부처님오신날",
  "2026-05-25": "대체공휴일",
  "2026-06-03": "지방선거",
  "2026-07-17": "제헌절",
  "2026-08-17": "대체공휴일",
  "2026-09-24": "추석 연휴",
  "2026-09-25": "추석",
  "2026-09-26": "추석 연휴",
  "2026-10-05": "대체공휴일",
};

const getKoreanHoliday = (key: string) => {
  if (holidays2026[key]) return holidays2026[key];
  const [year, month, day] = key.split("-");
  const monthDay = `${month}-${day}`;
  if (Number(year) >= 2026 && monthDay === "05-01") return "노동절";
  if (Number(year) >= 2026 && monthDay === "07-17") return "제헌절";
  return fixedHolidays[monthDay] ?? null;
};

const seedHistory: Session[] = [
  {
    id: "seed-1",
    date: "2026-07-17T06:14:00+09:00",
    title: "Full Body",
    durationMinutes: 38,
    lane: "push",
    exercises: [
      {
        id: "e-1",
        name: "백 스쿼트",
        sets: [
          { id: "s-1", weight: 50, reps: 8, done: true },
          { id: "s-2", weight: 57.5, reps: 6, done: true },
          { id: "s-3", weight: 57.5, reps: 5, done: true },
          { id: "s-4", weight: 55, reps: 8, done: true },
        ],
      },
      {
        id: "e-2",
        name: "벤치 프레스",
        sets: [
          { id: "s-5", weight: 42.5, reps: 8, done: true },
          { id: "s-6", weight: 45, reps: 7, done: true },
          { id: "s-7", weight: 45, reps: 6, done: true },
        ],
      },
      {
        id: "e-3",
        name: "시티드 케이블 로우",
        sets: [
          { id: "s-8", weight: 42.5, reps: 10, done: true },
          { id: "s-9", weight: 42.5, reps: 10, done: true },
          { id: "s-10", weight: 42.5, reps: 9, done: true },
        ],
      },
    ],
  },
  {
    id: "seed-2",
    date: "2026-07-14T06:18:00+09:00",
    title: "Full Body",
    durationMinutes: 34,
    lane: "maintain",
    exercises: [
      {
        id: "e-4",
        name: "백 스쿼트",
        sets: [
          { id: "s-11", weight: 50, reps: 8, done: true },
          { id: "s-12", weight: 55, reps: 6, done: true },
          { id: "s-13", weight: 55, reps: 6, done: true },
        ],
      },
      {
        id: "e-5",
        name: "벤치 프레스",
        sets: [
          { id: "s-14", weight: 40, reps: 8, done: true },
          { id: "s-15", weight: 42.5, reps: 7, done: true },
          { id: "s-16", weight: 42.5, reps: 6, done: true },
        ],
      },
      {
        id: "e-6",
        name: "랫 풀다운",
        sets: [
          { id: "s-17", weight: 45, reps: 10, done: true },
          { id: "s-18", weight: 45, reps: 9, done: true },
          { id: "s-19", weight: 40, reps: 11, done: true },
        ],
      },
    ],
  },
];

const cloneExercises = (exercises: Exercise[]) =>
  exercises.map((exercise) => ({
    ...exercise,
    sets: exercise.sets.filter((set) => set.done).map((set) => ({ ...set })),
  }));

const blankSet = (): WorkoutSet => ({
  id: uid(),
  weight: 0,
  reps: 8,
  done: true,
});
const blankDistance = (): WorkoutSet => ({
  id: uid(),
  weight: 0,
  reps: 1,
  done: true,
  distanceKm: 0,
});
const createDefaultWeightSets = (): WorkoutSet[] =>
  Array.from({ length: 4 }, (_, index) => ({
    ...blankSet(),
    inheritWeight: index > 0,
    inheritReps: index > 0,
  }));
const createExercise = (name: string, metric: Metric): Exercise => ({
  id: uid(),
  name,
  metric,
  sets: metric === "distance" ? [blankDistance()] : createDefaultWeightSets(),
  bodyPart: inferBodyPart(name),
  bodyPartManual: false,
});
const prepareSetForSave = (set: WorkoutSet): WorkoutSet => {
  const persisted = { ...set, done: true };
  delete persisted.inheritWeight;
  delete persisted.inheritReps;
  return persisted;
};
const normalizeExerciseName = (name: string) =>
  name.trim().toLocaleLowerCase("ko-KR");
const defaultFavorites: FavoriteExercise[] = [
  { id: "favorite-squat", name: "백 스쿼트", metric: "weight" },
  { id: "favorite-bench", name: "벤치 프레스", metric: "weight" },
  { id: "favorite-run", name: "달리기", metric: "distance" },
];

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
  const [newMetric, setNewMetric] = useState<Metric>("weight");
  const [favorites, setFavorites] =
    useState<FavoriteExercise[]>(defaultFavorites);
  const [loaded, setLoaded] = useState(false);
  const [favoritesLoaded, setFavoritesLoaded] = useState(false);
  const [neonReady, setNeonReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [toast, setToast] = useState("");
  const [report, setReport] = useState<TrainingReport | null>(null);
  const [reportStats, setReportStats] = useState<TrainingStats | null>(null);
  const [reportDate, setReportDate] = useState("");
  const [reportStatus, setReportStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [reportError, setReportError] = useState("");
  const clientReady = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );

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
    if (loaded)
      window.localStorage.setItem("first-rep-history", JSON.stringify(history));
  }, [history, loaded]);

  useEffect(() => {
    const stored = window.localStorage.getItem("first-rep-favorites");
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as FavoriteExercise[];
        if (Array.isArray(parsed)) setFavorites(parsed);
      } catch {
        // Keep the starter favorites when stored data is malformed.
      }
    }
    setFavoritesLoaded(true);
  }, []);

  useEffect(() => {
    if (favoritesLoaded)
      window.localStorage.setItem(
        "first-rep-favorites",
        JSON.stringify(favorites),
      );
  }, [favorites, favoritesLoaded]);

  useEffect(() => {
    if (!loaded || !favoritesLoaded) return;
    let cancelled = false;

    const connectNeon = async () => {
      try {
        const response = await fetch("/api/state", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as {
          state?: { history?: unknown; favorites?: unknown } | null;
        };
        if (cancelled) return;

        if (data.state) {
          if (Array.isArray(data.state.history))
            setHistory(data.state.history as Session[]);
          if (Array.isArray(data.state.favorites))
            setFavorites(data.state.favorites as FavoriteExercise[]);
          setNeonReady(true);
          return;
        }

        const localHistory = JSON.parse(
          window.localStorage.getItem("first-rep-history") ?? "[]",
        ) as unknown;
        const localFavorites = JSON.parse(
          window.localStorage.getItem("first-rep-favorites") ?? "[]",
        ) as unknown;
        const importResponse = await fetch("/api/state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            history: Array.isArray(localHistory) ? localHistory : history,
            favorites: Array.isArray(localFavorites)
              ? localFavorites
              : favorites,
          }),
        });
        if (!cancelled && importResponse.ok) setNeonReady(true);
      } catch {
        // Local storage remains the offline source when Neon is unavailable.
      }
    };

    void connectNeon();
    return () => {
      cancelled = true;
    };
    // This runs once after both local caches have been hydrated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, favoritesLoaded]);

  useEffect(() => {
    if (!neonReady) return;
    const timer = window.setTimeout(() => {
      void fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history, favorites }),
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [history, favorites, neonReady]);

  const sessionsByDate = useMemo(() => {
    const map = new Map<string, Session>();
    history.forEach((session) =>
      map.set(sessionDateKey(session.date), session),
    );
    return map;
  }, [history]);

  const selectedSession = sessionsByDate.get(selectedDate);

  useEffect(() => {
    setDraft(selectedSession ? cloneExercises(selectedSession.exercises) : []);
    setNewExercise("");
    setNewMetric("weight");
    setDirty(false);
  }, [selectedDate, selectedSession]);

  // The morning coach no longer generates a plan to inject, so any lingering
  // draft from an older build is cleared once (never applied) on load.
  useEffect(() => {
    if (!loaded) return;
    window.localStorage.removeItem("first-rep-coach-draft");
  }, [loaded]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(REPORT_CACHE_KEY);
      if (!raw) return;
      const cached = JSON.parse(raw) as TrainingReportCache;
      if (cached?.report && typeof cached.date === "string") {
        setReport(cached.report);
        setReportStats(cached.stats ?? null);
        setReportDate(cached.date);
      }
    } catch {
      // A malformed cache just means the panel starts empty.
    }
  }, []);

  const runReport = async () => {
    if (reportStatus === "loading") return;
    setReportStatus("loading");
    setReportError("");
    try {
      const response = await fetch("/api/training-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Newest 90 sessions are plenty for trend analysis and keep the payload small.
        body: JSON.stringify({
          history: [...history]
            .sort((a, b) => b.date.localeCompare(a.date))
            .slice(0, 90),
        }),
      });
      const data = (await response.json()) as {
        report?: TrainingReport;
        stats?: TrainingStats;
        error?: string;
        code?: string;
      };
      if (!response.ok || !data.report) {
        const suffix =
          data.code === "openai_not_configured"
            ? " 서버에 OPENAI_API_KEY를 설정하면 활성화됩니다."
            : "";
        throw new Error(`${data.error ?? "분석에 실패했습니다."}${suffix}`);
      }
      setReport(data.report);
      setReportStats(data.stats ?? null);
      setReportDate(todayKey);
      setReportStatus("idle");
      try {
        window.localStorage.setItem(
          REPORT_CACHE_KEY,
          JSON.stringify({
            date: todayKey,
            report: data.report,
            stats: data.stats,
          }),
        );
      } catch {
        // Best-effort cache.
      }
    } catch (requestError) {
      setReportError(
        requestError instanceof Error
          ? requestError.message
          : "분석에 실패했습니다.",
      );
      setReportStatus("error");
    }
  };

  const calendarDays = useMemo(() => {
    const year = visibleMonth.getFullYear();
    const month = visibleMonth.getMonth();
    const offset = new Date(year, month, 1).getDay();
    const count = new Date(year, month + 1, 0).getDate();
    const totalCells = Math.ceil((offset + count) / 7) * 7;
    return Array.from({ length: totalCells }, (_, index) => {
      const day = index - offset + 1;
      if (day < 1 || day > count) return null;
      const date = new Date(year, month, day);
      return { day, key: toDateKey(date) };
    });
  }, [visibleMonth]);

  const monthSessions = useMemo(() => {
    const prefix = `${visibleMonth.getFullYear()}-${pad(visibleMonth.getMonth() + 1)}`;
    return history.filter((session) =>
      sessionDateKey(session.date).startsWith(prefix),
    );
  }, [history, visibleMonth]);

  const monthStats = useMemo(() => {
    const sets = monthSessions.flatMap((session) =>
      session.exercises
        .filter((exercise) => exercise.metric !== "distance")
        .flatMap((exercise) => exercise.sets.filter((set) => set.done)),
    );
    return {
      workouts: monthSessions.length,
      sets: sets.length,
      max: sets.reduce((value, set) => Math.max(value, set.weight), 0),
    };
  }, [monthSessions]);

  const draftStats = useMemo(() => {
    const weightSets = draft
      .filter(
        (exercise) =>
          exercise.metric !== "distance" && exercise.metric !== "bodyweight",
      )
      .flatMap((exercise) => exercise.sets);
    const bodyweightSets = draft
      .filter((exercise) => exercise.metric === "bodyweight")
      .flatMap((exercise) => exercise.sets);
    const distanceSets = draft
      .filter((exercise) => exercise.metric === "distance")
      .flatMap((exercise) => exercise.sets);
    return {
      sets: weightSets.length + bodyweightSets.length,
      volume: weightSets.reduce((sum, set) => sum + set.weight * set.reps, 0),
      max: weightSets.reduce((value, set) => Math.max(value, set.weight), 0),
      hasWeight: weightSets.length > 0,
      reps: bodyweightSets.reduce((sum, set) => sum + set.reps, 0),
      distance: distanceSets.reduce(
        (sum, set) => sum + (set.distanceKm ?? 0),
        0,
      ),
    };
  }, [draft]);

  const coachInsight = useMemo(() => {
    if (monthSessions.length === 0)
      return "첫 기록을 남기면 다음 운동의 중량과 반복을 제안할게요.";
    const exerciseCounts = new Map<string, number>();
    monthSessions.forEach((session) =>
      session.exercises.forEach((exercise) => {
        exerciseCounts.set(
          exercise.name,
          (exerciseCounts.get(exercise.name) ?? 0) + 1,
        );
      }),
    );
    const mostFrequent = [...exerciseCounts.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0];
    return `${visibleMonth.getMonth() + 1}월 ${monthSessions.length}회 완료. ${mostFrequent?.[0] ?? "운동"}을 가장 꾸준히 기록했어요.`;
  }, [monthSessions, visibleMonth]);

  const selectDate = (key: string) => {
    setSelectedDate(key);
  };

  const moveMonth = (amount: number) => {
    setVisibleMonth(
      (current) =>
        new Date(current.getFullYear(), current.getMonth() + amount, 1),
    );
  };

  const goToday = () => {
    const today = new Date();
    setVisibleMonth(new Date(today.getFullYear(), today.getMonth(), 1));
    setSelectedDate(todayKey);
  };

  const addExerciseToDraft = (name: string, metric: Metric) => {
    const trimmedName = name.trim();
    if (!trimmedName) return false;
    const normalizedName = normalizeExerciseName(trimmedName);
    const exists = draft.some(
      (exercise) =>
        normalizeExerciseName(exercise.name) === normalizedName &&
        (exercise.metric ?? "weight") === metric,
    );
    if (exists) {
      setToast("이미 이날의 기록에 추가된 운동이에요.");
      return false;
    }
    setDraft((current) => [...current, createExercise(trimmedName, metric)]);
    setDirty(true);
    return true;
  };

  const addExercise = (event: FormEvent) => {
    event.preventDefault();
    if (addExerciseToDraft(newExercise, newMetric)) {
      setNewExercise("");
      setNewMetric("weight");
    }
  };

  const isFavorite = (exercise: Exercise) =>
    favorites.some(
      (favorite) =>
        normalizeExerciseName(favorite.name) ===
          normalizeExerciseName(exercise.name) &&
        favorite.metric === (exercise.metric ?? "weight"),
    );

  const toggleFavorite = (exercise: Exercise) => {
    const metric = exercise.metric ?? "weight";
    const name = exercise.name.trim();
    if (!name) {
      setToast("운동 이름을 먼저 입력해주세요.");
      return;
    }
    const match = favorites.find(
      (favorite) =>
        normalizeExerciseName(favorite.name) === normalizeExerciseName(name) &&
        favorite.metric === metric,
    );
    if (match) {
      setFavorites((current) =>
        current.filter((favorite) => favorite.id !== match.id),
      );
      setToast(`${name} 즐겨찾기를 해제했어요.`);
      return;
    }
    setFavorites((current) => [...current, { id: uid(), name, metric }]);
    setToast(`${name}을 즐겨찾기에 등록했어요.`);
  };

  const removeFavorite = (favorite: FavoriteExercise) => {
    setFavorites((current) =>
      current.filter((item) => item.id !== favorite.id),
    );
    setToast(`${favorite.name} 즐겨찾기를 해제했어요.`);
  };

  const updateExerciseName = (exerciseId: string, name: string) => {
    setDraft((current) =>
      current.map((exercise) =>
        exercise.id === exerciseId
          ? {
              ...exercise,
              name,
              ...(exercise.bodyPartManual
                ? {}
                : { bodyPart: inferBodyPart(name) }),
            }
          : exercise,
      ),
    );
    setDirty(true);
  };

  const setExerciseBodyPart = (exerciseId: string, part: BodyPart) => {
    setDraft((current) =>
      current.map((exercise) =>
        exercise.id === exerciseId
          ? { ...exercise, bodyPart: part, bodyPartManual: true }
          : exercise,
      ),
    );
    setDirty(true);
  };

  const addSet = (exerciseId: string) => {
    setDraft((current) =>
      current.map((exercise) => {
        if (exercise.id !== exerciseId) return exercise;
        const previous = exercise.sets.at(-1);
        return {
          ...exercise,
          sets: [
            ...exercise.sets,
            {
              ...blankSet(),
              weight: previous?.weight ?? 0,
              reps: previous?.reps ?? 8,
            },
          ],
        };
      }),
    );
    setDirty(true);
  };

  const updateSet = (
    exerciseId: string,
    setId: string,
    patch: Partial<WorkoutSet>,
  ) => {
    setDraft((current) =>
      current.map((exercise) => {
        if (exercise.id !== exerciseId) return exercise;
        const editedIndex = exercise.sets.findIndex((set) => set.id === setId);
        if (editedIndex < 0) return exercise;

        // Propagate to later sets, but stop each field's chain at the first
        // manually-pinned set — sets below a pin follow that pin, not the edit.
        let weightLive = patch.weight !== undefined;
        let repsLive = patch.reps !== undefined;
        const sets = exercise.sets.map((set, setIndex) => {
          if (setIndex === editedIndex) {
            return {
              ...set,
              ...patch,
              ...(editedIndex > 0 && patch.weight !== undefined
                ? { inheritWeight: false }
                : {}),
              ...(editedIndex > 0 && patch.reps !== undefined
                ? { inheritReps: false }
                : {}),
            };
          }
          if (setIndex < editedIndex) return set;
          let next = set;
          if (weightLive) {
            if (set.inheritWeight) next = { ...next, weight: patch.weight! };
            else weightLive = false;
          }
          if (repsLive) {
            if (set.inheritReps) next = { ...next, reps: patch.reps! };
            else repsLive = false;
          }
          return next;
        });

        return { ...exercise, sets };
      }),
    );
    setDirty(true);
  };

  const removeSet = (exerciseId: string, setId: string) => {
    setDraft((current) =>
      current.map((exercise) =>
        exercise.id === exerciseId
          ? {
              ...exercise,
              sets: exercise.sets.filter((set) => set.id !== setId),
            }
          : exercise,
      ),
    );
    setDirty(true);
  };

  const removeExercise = (exerciseId: string) => {
    setDraft((current) =>
      current.filter((exercise) => exercise.id !== exerciseId),
    );
    setDirty(true);
  };

  const dragSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleReorderExercises = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setDraft((current) => {
      const oldIndex = current.findIndex((item) => item.id === active.id);
      const newIndex = current.findIndex((item) => item.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return current;
      return arrayMove(current, oldIndex, newIndex);
    });
    setDirty(true);
  };

  const saveWorkout = () => {
    const cleaned = draft
      .map((exercise) => ({
        ...exercise,
        name: exercise.name.trim(),
        sets: exercise.sets
          .filter((set) =>
            exercise.metric === "distance"
              ? Number.isFinite(set.distanceKm) && (set.distanceKm ?? 0) > 0
              : Number.isFinite(set.weight) &&
                set.weight >= 0 &&
                Number.isFinite(set.reps) &&
                set.reps > 0,
          )
          .map(prepareSetForSave),
      }))
      .filter((exercise) => exercise.name && exercise.sets.length > 0);

    if (cleaned.length === 0) {
      setToast("운동과 세트를 하나 이상 입력해주세요.");
      return;
    }

    const session: Session = {
      id: selectedSession?.id ?? uid(),
      date: `${selectedDate}T12:00:00`,
      title:
        cleaned.length === 1 ? cleaned[0].name : `${cleaned.length} exercises`,
      durationMinutes: selectedSession?.durationMinutes ?? 0,
      lane: selectedSession?.lane ?? "maintain",
      exercises: cleaned,
    };

    setHistory((current) =>
      [
        ...current.filter((item) => sessionDateKey(item.date) !== selectedDate),
        session,
      ].sort((a, b) => b.date.localeCompare(a.date)),
    );
    setDraft(cloneExercises(cleaned));
    setDirty(false);
    setToast(
      selectedSession ? "운동 기록을 수정했어요." : "운동 기록을 저장했어요.",
    );
  };

  const deleteWorkout = () => {
    if (!selectedSession) return;
    if (
      !window.confirm(
        `${formatSelectedDate(selectedDate)} 운동 기록을 삭제할까요?`,
      )
    )
      return;
    setHistory((current) =>
      current.filter(
        (session) => sessionDateKey(session.date) !== selectedDate,
      ),
    );
    setDraft([]);
    setDirty(false);
    setToast("이 날짜의 기록을 삭제했어요.");
  };

  const monthLabel = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
  }).format(visibleMonth);

  if (!clientReady) {
    return (
      <main
        className="hydration-shell"
        aria-label="EVERYONE BUT YOU 불러오는 중"
      >
        <svg
          className="brand-mark"
          viewBox="0 0 32 32"
          aria-hidden="true"
          focusable="false"
        >
          <path
            fill="currentColor"
            fillRule="evenodd"
            d="M16.8 1.7c3.6 5.2 10.6 9 11.1 16.3.5 7-4.7 12-11.6 12-7 0-12.2-4.8-11.7-11.4.4-5.4 6.1-8.6 8.5-14.3 1.2 3.6 1.6 6.9-.2 9.8 3.4-1.8 6.6-6 3.9-12.4Zm-4.9 22.5c-1.8-2.7-1.1-5.6 1.7-7.6 2.5-1.8 4.7-3.1 5.5-5.8 2.5 5.1 2.5 10.6-1 13.7-2.1 1.8-4.8 1.6-6.2-.3Z"
          />
        </svg>
        <b>EVERYONE BUT YOU</b>
      </main>
    );
  }

  return (
    <main className="app">
      <header className="site-header">
        <button className="wordmark" onClick={goToday} aria-label="오늘로 이동">
          <svg
            className="brand-mark"
            viewBox="0 0 32 32"
            aria-hidden="true"
            focusable="false"
          >
            <path
              fill="currentColor"
              fillRule="evenodd"
              d="M16.8 1.7c3.6 5.2 10.6 9 11.1 16.3.5 7-4.7 12-11.6 12-7 0-12.2-4.8-11.7-11.4.4-5.4 6.1-8.6 8.5-14.3 1.2 3.6 1.6 6.9-.2 9.8 3.4-1.8 6.6-6 3.9-12.4Zm-4.9 22.5c-1.8-2.7-1.1-5.6 1.7-7.6 2.5-1.8 4.7-3.1 5.5-5.8 2.5 5.1 2.5 10.6-1 13.7-2.1 1.8-4.8 1.6-6.2-.3Z"
            />
          </svg>
          <b>EVERYONE BUT YOU</b>
        </button>
        <p>운동을 기억하는 가장 단순한 방법.</p>
        <div className="header-actions">
          <Link className="morning-button" href="/morning">
            MORNING
          </Link>
          <button className="today-button" onClick={goToday}>
            오늘
          </button>
        </div>
      </header>

      <section className="summary" aria-label="이번 달 요약">
        <div>
          <span>THIS MONTH</span>
          <strong>
            {monthStats.workouts}
            <small>회</small>
          </strong>
        </div>
        <div>
          <span>TOTAL SETS</span>
          <strong>
            {monthStats.sets}
            <small>세트</small>
          </strong>
        </div>
        <div>
          <span>HEAVIEST</span>
          <strong>
            {formatNumber(monthStats.max)}
            <small>kg</small>
          </strong>
        </div>
        <div className="coach-summary">
          <span>AI COACH</span>
          <p>{coachInsight}</p>
        </div>
      </section>

      <section className="report-panel" aria-label="AI 근력 분석">
        <div className="report-head">
          <div>
            <span>STRENGTH REPORT</span>
            <h2>{report ? report.headline : "근력·근육량 관점의 훈련 진단"}</h2>
            {reportDate && report && <small>{reportDate} 기준 분석</small>}
          </div>
          <button
            className="report-run"
            onClick={runReport}
            disabled={reportStatus === "loading"}
          >
            {reportStatus === "loading"
              ? "분석 중…"
              : report
                ? "다시 분석"
                : "AI 분석 실행"}
          </button>
        </div>

        {reportStatus === "error" && (
          <p className="report-error" role="alert">
            {reportError}
          </p>
        )}

        {!report && reportStatus !== "error" && (
          <p className="report-empty">
            기록 전체를 읽고 훈련 빈도·강도·종목별 추정 1RM 추이를 분석해 지금
            잘 가고 있는지 판정합니다.
          </p>
        )}

        {report && (
          <div className="report-body">
            <p className="report-overall">{report.overall}</p>

            <div className="report-frequency">
              <b>
                주 {reportStats ? formatNumber(reportStats.perWeekRecent) : "-"}
                회
                {reportStats && reportStats.trackingDays < 14 && (
                  <em className="report-frequency-tag">첫 주 페이스</em>
                )}
              </b>
              <p>{report.frequencyComment}</p>
            </div>

            {report.liftAnalysis.length > 0 && (
              <div className="report-lifts">
                {report.liftAnalysis.map((lift, liftIndex) => (
                  <div
                    className={`report-lift trend-${lift.trend}`}
                    key={`${lift.name}-${liftIndex}`}
                  >
                    <i aria-hidden="true">{trendSymbol[lift.trend]}</i>
                    <div>
                      <b>
                        {lift.name}
                        <small>{trendLabel[lift.trend]}</small>
                      </b>
                      <p>{lift.comment}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {report.actionItems.length > 0 && (
              <div className="report-actions">
                <span>NEXT 7 DAYS</span>
                <ol>
                  {report.actionItems.map((item, itemIndex) => (
                    <li key={`${item}-${itemIndex}`}>{item}</li>
                  ))}
                </ol>
              </div>
            )}

            {report.warning && (
              <small className="report-warning">{report.warning}</small>
            )}
          </div>
        )}
      </section>

      <div className="workspace">
        <section className="calendar-panel">
          <div className="calendar-toolbar">
            <div>
              <span>TRAINING CALENDAR</span>
              <h1>{monthLabel}</h1>
            </div>
            <div className="month-controls">
              <button onClick={() => moveMonth(-1)} aria-label="이전 달">
                ←
              </button>
              <button onClick={() => moveMonth(1)} aria-label="다음 달">
                →
              </button>
            </div>
          </div>

          <div className="weekdays" aria-hidden="true">
            {["일", "월", "화", "수", "목", "금", "토"].map((day, index) => (
              <span
                className={index === 0 || index === 6 ? "weekend" : ""}
                key={day}
              >
                {day}
              </span>
            ))}
          </div>
          <div className="calendar-grid">
            {calendarDays.map((date, index) => {
              if (!date)
                return (
                  <div className="calendar-empty" key={`empty-${index}`} />
                );
              const session = sessionsByDate.get(date.key);
              const holidayName = getKoreanHoliday(date.key);
              const dayOfWeek = dateFromKey(date.key).getDay();
              const isRedDate =
                dayOfWeek === 0 || dayOfWeek === 6 || Boolean(holidayName);
              const dayRecords = session
                ? session.exercises.map((exercise) => {
                    const sets = exercise.sets.filter((set) => set.done);
                    const isDistance = exercise.metric === "distance";
                    const isBodyweight = exercise.metric === "bodyweight";
                    return {
                      id: exercise.id,
                      name: exercise.name,
                      value: isDistance
                        ? sets.reduce(
                            (sum, set) => sum + (set.distanceKm ?? 0),
                            0,
                          )
                        : isBodyweight
                          ? sets.reduce(
                              (value, set) => Math.max(value, set.reps),
                              0,
                            )
                          : sets.reduce(
                              (value, set) => Math.max(value, set.weight),
                              0,
                            ),
                      unit: isDistance ? "km" : isBodyweight ? "회" : "kg",
                      group: bodyGroup(exercise),
                    };
                  })
                : [];
              const spokenRecords = dayRecords
                .map(
                  (record) =>
                    `${record.name} ${formatNumber(record.value)}${record.unit}`,
                )
                .join(", ");
              return (
                <button
                  key={date.key}
                  className={`calendar-day ${selectedDate === date.key ? "selected" : ""} ${date.key === todayKey ? "today" : ""} ${session ? "has-workout" : ""} ${isRedDate ? "red-day" : ""}`}
                  onClick={() => selectDate(date.key)}
                  aria-pressed={selectedDate === date.key}
                  aria-label={`${date.day}일${holidayName ? ` ${holidayName}` : ""}${session ? `, ${spokenRecords}` : ", 기록 없음"}`}
                >
                  <span className="date-line">
                    <span className="day-number">{date.day}</span>
                    {holidayName && <small>{holidayName}</small>}
                  </span>
                  {session ? (
                    <span className="day-workout">
                      {dayRecords.map((record) => (
                        <span
                          className={`day-lift ${record.group}`}
                          key={record.id}
                        >
                          <b>{record.name}</b>
                          <strong>
                            {formatNumber(record.value)}
                            <small>{record.unit}</small>
                          </strong>
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="add-hint">＋ 기록</span>
                  )}
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
            <DndContext
              sensors={dragSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleReorderExercises}
            >
              <SortableContext
                items={draft.map((exercise) => exercise.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="draft-list">
                  {draft.map((exercise, exerciseIndex) => {
                    const isDistance = exercise.metric === "distance";
                    const isBodyweight = exercise.metric === "bodyweight";
                    const max = exercise.sets.reduce(
                      (value, set) => Math.max(value, set.weight),
                      0,
                    );
                    const maxReps = exercise.sets.reduce(
                      (value, set) => Math.max(value, set.reps),
                      0,
                    );
                    const distance = exercise.sets.reduce(
                      (sum, set) => sum + (set.distanceKm ?? 0),
                      0,
                    );
                    return (
                      <SortableExercise id={exercise.id} key={exercise.id}>
                        {({ setNodeRef, style, handleProps, isDragging }) => (
                          <article
                            ref={setNodeRef}
                            style={style}
                            className={`exercise-entry ${isDragging ? "dragging" : ""}`}
                          >
                            <div className="exercise-head">
                              <button
                                type="button"
                                className="drag-handle"
                                aria-label={`${exercise.name} 순서 이동`}
                                {...handleProps}
                              >
                                ⠿
                              </button>
                              <span>{pad(exerciseIndex + 1)}</span>
                              <input
                                value={exercise.name}
                                onChange={(event) =>
                                  updateExerciseName(
                                    exercise.id,
                                    event.target.value,
                                  )
                                }
                                aria-label={`${exerciseIndex + 1}번째 운동 이름`}
                              />
                              <small>
                                {isDistance
                                  ? `${formatNumber(distance)}km`
                                  : isBodyweight
                                    ? `MAX ${formatNumber(maxReps)}회`
                                    : `MAX ${formatNumber(max)}kg`}
                              </small>
                              <button
                                className={`favorite-toggle ${isFavorite(exercise) ? "active" : ""}`}
                                onClick={() => toggleFavorite(exercise)}
                                aria-label={`${exercise.name} 즐겨찾기 ${isFavorite(exercise) ? "해제" : "등록"}`}
                                title={
                                  isFavorite(exercise)
                                    ? "즐겨찾기 해제"
                                    : "즐겨찾기 등록"
                                }
                              >
                                {isFavorite(exercise) ? "★" : "☆"}
                              </button>
                              <button
                                onClick={() => removeExercise(exercise.id)}
                                aria-label={`${exercise.name} 삭제`}
                              >
                                ×
                              </button>
                            </div>
                            <div
                              className="bodypart-row"
                              role="group"
                              aria-label={`${exercise.name} 부위`}
                            >
                              {BODY_PARTS.map((part) => (
                                <button
                                  key={part}
                                  type="button"
                                  className={`bodypart-chip ${
                                    exerciseBodyPart(exercise) === part
                                      ? "active"
                                      : ""
                                  }`}
                                  onClick={() =>
                                    setExerciseBodyPart(exercise.id, part)
                                  }
                                  aria-pressed={
                                    exerciseBodyPart(exercise) === part
                                  }
                                >
                                  {part}
                                </button>
                              ))}
                            </div>
                            {isDistance ? (
                              <div className="distance-entry">
                                <span>DISTANCE</span>
                                <input
                                  type="number"
                                  min="0"
                                  step="0.1"
                                  inputMode="decimal"
                                  value={exercise.sets[0]?.distanceKm ?? 0}
                                  onChange={(event) =>
                                    updateSet(
                                      exercise.id,
                                      exercise.sets[0].id,
                                      {
                                        distanceKm: Number(event.target.value),
                                      },
                                    )
                                  }
                                  aria-label={`${exercise.name} 거리`}
                                />
                                <b>km</b>
                              </div>
                            ) : (
                              <>
                                <div className="sets-head">
                                  <span>SET</span>
                                  <span>{isBodyweight ? "＋KG" : "KG"}</span>
                                  <span>REPS</span>
                                  <span />
                                </div>
                                {exercise.sets.map((set, setIndex) => (
                                  <div className="set-entry" key={set.id}>
                                    <b>{setIndex + 1}</b>
                                    <input
                                      type="number"
                                      min="0"
                                      step="0.5"
                                      inputMode="decimal"
                                      value={set.weight}
                                      onChange={(event) =>
                                        updateSet(exercise.id, set.id, {
                                          weight: Number(event.target.value),
                                        })
                                      }
                                      aria-label={`${exercise.name} ${setIndex + 1}세트 ${isBodyweight ? "추가중량" : "중량"}`}
                                    />
                                    <input
                                      type="number"
                                      min="1"
                                      step="1"
                                      inputMode="numeric"
                                      value={set.reps}
                                      onChange={(event) =>
                                        updateSet(exercise.id, set.id, {
                                          reps: Number(event.target.value),
                                        })
                                      }
                                      aria-label={`${exercise.name} ${setIndex + 1}세트 반복`}
                                    />
                                    <button
                                      onClick={() =>
                                        removeSet(exercise.id, set.id)
                                      }
                                      aria-label={`${setIndex + 1}세트 삭제`}
                                    >
                                      ×
                                    </button>
                                  </div>
                                ))}
                                <button
                                  className="add-set-button"
                                  onClick={() => addSet(exercise.id)}
                                >
                                  ＋ 세트
                                </button>
                              </>
                            )}
                          </article>
                        )}
                      </SortableExercise>
                    );
                  })}
                </div>
              </SortableContext>
            </DndContext>
          ) : (
            <div className="empty-editor">
              <span>＋</span>
              <h3>이날의 첫 운동</h3>
              <p>운동 이름을 입력하면 바로 세트를 기록할 수 있어요.</p>
            </div>
          )}

          <section className="favorites" aria-label="즐겨찾기 운동">
            <div className="favorites-head">
              <span>FAVORITES</span>
              <small>운동 카드의 ☆로 등록</small>
            </div>
            {favorites.length > 0 ? (
              <div className="favorite-list">
                {favorites.map((favorite) => (
                  <div className="favorite-chip" key={favorite.id}>
                    <button
                      className="favorite-add"
                      onClick={() =>
                        addExerciseToDraft(favorite.name, favorite.metric)
                      }
                      aria-label={`${favorite.name} 빠르게 추가`}
                    >
                      <span>★</span>
                      <b>{favorite.name}</b>
                      <small>
                        {favorite.metric === "distance"
                          ? "km"
                          : favorite.metric === "bodyweight"
                            ? "회"
                            : "kg"}
                      </small>
                    </button>
                    <button
                      className="favorite-remove"
                      onClick={() => removeFavorite(favorite)}
                      aria-label={`${favorite.name} 즐겨찾기 해제`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p>운동 카드의 ☆를 눌러 자주 하는 운동을 등록하세요.</p>
            )}
          </section>

          <form className="add-exercise" onSubmit={addExercise}>
            <select
              value={newMetric}
              onChange={(event) => setNewMetric(event.target.value as Metric)}
              aria-label="운동 기록 방식"
            >
              <option value="weight">중량</option>
              <option value="bodyweight">맨몸</option>
              <option value="distance">거리</option>
            </select>
            <input
              value={newExercise}
              onChange={(event) => setNewExercise(event.target.value)}
              placeholder={
                newMetric === "distance"
                  ? "예: 달리기"
                  : newMetric === "bodyweight"
                    ? "예: 풀업"
                    : "예: 백 스쿼트"
              }
              aria-label="추가할 운동 이름"
            />
            <button type="submit">추가</button>
          </form>

          <div className="draft-summary">
            <span>{draftStats.sets} sets</span>
            {draftStats.hasWeight && (
              <span>{formatNumber(draftStats.volume)}kg volume</span>
            )}
            {draftStats.hasWeight && (
              <span>max {formatNumber(draftStats.max)}kg</span>
            )}
            {draftStats.reps > 0 && (
              <span>{formatNumber(draftStats.reps)}회</span>
            )}
            {draftStats.distance > 0 && (
              <span>{formatNumber(draftStats.distance)}km</span>
            )}
          </div>

          <div className="editor-actions">
            {selectedSession && (
              <button className="delete-button" onClick={deleteWorkout}>
                삭제
              </button>
            )}
            <button className="save-button" onClick={saveWorkout}>
              {selectedSession ? "기록 수정" : "운동 저장"}
            </button>
          </div>
        </aside>
      </div>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </main>
  );
}
