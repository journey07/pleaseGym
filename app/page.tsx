"use client";

import {
  ComponentProps,
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
import {
  canonicalNameMap,
  normalizeExerciseName,
} from "./lib/exerciseName";

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

// 숫자 칸은 편집 중인 문자열을 그대로 들고 있는다. 값(0)만 들고 있으면
// 지운 칸에 "0"이 다시 그려져 지울 수 없고, "0.5"처럼 0으로 시작하는 값도
// 입력 도중에 튄다. 포커스가 빠지면 다시 모델 값을 따라간다.
function NumberInput({
  value,
  onValueChange,
  onBlur,
  ...rest
}: Omit<ComponentProps<"input">, "value" | "onChange"> & {
  value: number;
  onValueChange: (value: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      {...rest}
      type="number"
      value={text ?? (value === 0 ? "" : String(value))}
      onChange={(event) => {
        const raw = event.target.value;
        setText(raw);
        const parsed = raw === "" ? 0 : Number(raw);
        if (Number.isFinite(parsed)) onValueChange(parsed);
      }}
      onBlur={(event) => {
        setText(null);
        onBlur?.(event);
      }}
    />
  );
}

// SVG엔 자동 줄바꿈이 없어서 글자 폭을 직접 잰다. 한글·기호는 전각으로 계산.
const textWidth = (text: string, size: number) =>
  [...text].reduce(
    (sum, char) => sum + size * (/[ㄱ-힝·×]/.test(char) ? 1 : 0.6),
    0,
  );

// 누른 점 옆에 뜨는 말풍선. 위쪽에 자리가 없으면 점 아래로 내려간다.
function TrendBubble({
  x,
  y,
  width,
  text,
  detail,
}: {
  x: number;
  y: number;
  width: number;
  text: string;
  detail: string;
}) {
  const short = detail.length > 24 ? `${detail.slice(0, 23)}…` : detail;
  const box = Math.max(textWidth(text, 9), textWidth(short, 7)) + 14;
  const height = short ? 30 : 20;
  const below = y - height - 10 < 0;
  const top = below ? y + 10 : y - height - 10;
  const left = Math.min(Math.max(x - box / 2, 2), width - box - 2);

  return (
    <g className="trend-bubble" pointerEvents="none">
      <rect x={left} y={top} width={box} height={height} rx={3} />
      <text x={left + box / 2} y={top + 12} textAnchor="middle">
        {text}
      </text>
      {short && (
        <text
          className="trend-bubble-detail"
          x={left + box / 2}
          y={top + 23}
          textAnchor="middle"
        >
          {short}
        </text>
      )}
    </g>
  );
}

// 세션별 대표 지표를 잇는 작은 선 그래프. 값이 하나면 점 하나만 찍는다.
// 점을 누르면 그 세션의 날짜와 값이 말풍선으로 뜬다.
function TrendChart({
  points,
  mode,
}: {
  points: TrendPoint[];
  mode: TrendMode;
}) {
  const [active, setActive] = useState<number | null>(null);
  const values = points.map(mode.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const flat = max === min;
  const span = max - min || 1;
  const inset = 14;
  const axis = 24; // 아래 날짜 축 자리
  const width = 320;
  const height = 132;
  const plot = height - axis - inset * 2;
  const x = (index: number) =>
    points.length === 1
      ? width / 2
      : inset + (index / (points.length - 1)) * (width - inset * 2);
  // 값이 전부 같으면(기록 1회 포함) 가운데 높이에 눕힌다.
  const y = (value: number) =>
    flat
      ? inset + plot / 2
      : height - axis - inset - ((value - min) / span) * plot;
  const line = points
    .map((point, index) => `${x(index)},${y(mode.value(point))}`)
    .join(" ");

  // 날짜는 최대 5개만. 마지막 기록에서 거꾸로 세어 항상 최신 날짜를 남긴다.
  const gap = Math.max(1, Math.ceil(points.length / 5));
  const ticks: number[] = [];
  for (let index = points.length - 1; index >= 0; index -= gap)
    ticks.unshift(index);

  return (
    <svg
      className="trend-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${mode.label} 추이 그래프`}
    >
      <polyline className="trend-line" points={line} />
      {points.map((point, index) => (
        <circle
          key={point.date}
          className={
            index === points.length - 1 ? "trend-dot last" : "trend-dot"
          }
          cx={x(index)}
          cy={y(mode.value(point))}
          r={index === active ? 5 : index === points.length - 1 ? 4 : 2.5}
        />
      ))}
      {/* 손가락으로도 눌리도록 점보다 넉넉한 투명 히트 영역을 겹쳐 둔다. */}
      {points.map((point, index) => (
        <circle
          key={`hit-${point.date}`}
          className="trend-hit"
          cx={x(index)}
          cy={y(mode.value(point))}
          r={13}
          tabIndex={0}
          role="button"
          aria-label={`${shortDateLabel(point.date)} ${mode.label} ${formatNumber(
            mode.value(point),
          )}${mode.unit}`}
          onClick={() => setActive(index === active ? null : index)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            setActive(index === active ? null : index);
          }}
        />
      ))}
      {active !== null && (
        <TrendBubble
          x={x(active)}
          y={y(mode.value(points[active]))}
          width={width}
          text={`${shortDateLabel(points[active].date)}  ${formatNumber(
            mode.value(points[active]),
          )}${mode.unit}`}
          detail={points[active].summary}
        />
      )}
      {ticks.map((index) => (
        <text
          key={points[index].date}
          className={
            index === points.length - 1 ? "trend-axis last" : "trend-axis"
          }
          x={x(index)}
          y={height - 8}
          textAnchor={
            points.length === 1
              ? "middle"
              : index === 0
                ? "start"
                : index === points.length - 1
                  ? "end"
                  : "middle"
          }
        >
          {shortDateLabel(points[index].date)}
        </text>
      ))}
    </svg>
  );
}

// 종목 하나의 추이 패널. 기록이 쌓인 뒤에야 의미가 있어서 빈 상태를 따로 둔다.
function ExerciseDetail({
  name,
  metric,
  assisted,
  points,
  onPickDate,
  onClose,
}: {
  name: string;
  metric: Metric;
  assisted: boolean;
  points: TrendPoint[];
  onPickDate: (dateKey: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const mode = trendMode(metric, assisted);
  const values = points.map(mode.value);
  const best = values.length
    ? mode.lowerIsBetter
      ? Math.min(...values)
      : Math.max(...values)
    : 0;
  const bestPoint = points[values.indexOf(best)];
  const first = points[0];
  const last = points.at(-1);
  const delta = first && last ? mode.value(last) - mode.value(first) : 0;
  const totalSets = points.reduce((sum, point) => sum + point.sets, 0);
  const topWeight = points.reduce(
    (value, point) => Math.max(value, point.topWeight),
    0,
  );
  const recent = [...points].reverse().slice(0, 10);

  return (
    <div
      className="detail-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`${name} 추이`}
      onClick={onClose}
    >
      <div className="detail-card" onClick={(event) => event.stopPropagation()}>
        <div className="detail-head">
          <div>
            <small>{mode.label} 추이</small>
            <h2>{name}</h2>
          </div>
          <button onClick={onClose} aria-label="추이 닫기">
            ×
          </button>
        </div>

        {points.length === 0 ? (
          <p className="detail-empty">
            저장된 기록이 아직 없어요. 오늘 기록을 저장하면 이 종목의 추이가
            쌓입니다.
          </p>
        ) : (
          <>
            <div className="detail-stats">
              <div>
                <small>BEST</small>
                <strong>
                  {formatNumber(best)}
                  <em>{mode.unit}</em>
                </strong>
                <span>
                  {bestPoint ? shortDateLabel(bestPoint.date) : "-"}
                  {/* 추정 1RM은 환산값이라, 실제로 든 최고 중량을 같이 적어준다. */}
                  {mode.label === "추정 1RM" && topWeight > 0
                    ? ` · 실제 ${formatNumber(topWeight)}kg`
                    : ""}
                </span>
              </div>
              <div>
                <small>최근</small>
                <strong>
                  {formatNumber(last ? mode.value(last) : 0)}
                  <em>{mode.unit}</em>
                </strong>
                <span>{last ? shortDateLabel(last.date) : "-"}</span>
              </div>
              <div>
                <small>첫 기록 대비</small>
                <strong className={delta === 0 ? "" : delta > 0 ? "up" : "down"}>
                  {delta > 0 ? "+" : ""}
                  {formatNumber(delta)}
                  <em>{mode.unit}</em>
                </strong>
                <span>{points.length}회 기록</span>
              </div>
              <div>
                <small>총 세트</small>
                <strong>{totalSets}</strong>
                <span>
                  {metric === "distance"
                    ? `${formatNumber(
                        points.reduce((sum, point) => sum + point.distanceKm, 0),
                      )}km 누적`
                    : `${formatNumber(
                        points.reduce((sum, point) => sum + point.volume, 0),
                      )}kg 볼륨`}
                </span>
              </div>
            </div>

            <TrendChart points={points} mode={mode} />
            <p className="trend-note">{mode.note}</p>

            <ul className="detail-log">
              {recent.map((point) => (
                <li key={point.date}>
                  <button onClick={() => onPickDate(point.date)}>
                    <b>{shortDateLabel(point.date)}</b>
                    <span>{point.summary}</span>
                    <strong>
                      {formatNumber(mode.value(point))}
                      {mode.unit}
                    </strong>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
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
  // "bodyweight": assisted일 때 weight는 보조 크기(+kg), 아니면 추가중량(+kg).
  metric?: Metric;
  assisted?: boolean;
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

// 어시스티드(보조) 종목 여부: 명시 플래그 또는 이름 키워드로 자동 감지.
// 보조는 몸에서 빼주는 무게라 "최대"가 아니라 "최소"가 베스트다.
const ASSISTED_NAME = /assisted|어시스티드|어시스트/i;
const isAssistedExercise = (exercise: Exercise): boolean =>
  exercise.assisted === true || ASSISTED_NAME.test(exercise.name);

// 보조 종목의 세트 중 weight>0 최소값(가장 적은 보조 = 베스트). 없으면 null.
const minAssistWeight = (exercise: Exercise): number | null => {
  let min = Infinity;
  for (const set of exercise.sets) {
    if (set.weight > 0 && set.weight < min) min = set.weight;
  }
  return Number.isFinite(min) ? min : null;
};

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
  // 신규 섹션 — 구(舊) 캐시엔 없으므로 optional(렌더 시 null-guard).
  balanceSummary?: string;
  upperBody?: string;
  lowerBody?: string;
  efficiencyVerdict?: string;
  exerciseSelection?: Array<{
    name: string;
    verdict: "keep" | "swap" | "drop";
    reason: string;
  }>;
  neglectNote?: string;
  bodyweightNote?: string;
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
// 직전 기록에서 세트를 그대로 가져올 때, 위 줄과 값이 같은 줄만 상속으로 둔다.
// 균일한 세트(60×8 ×4)는 한 줄만 고쳐도 전부 따라오고, 피라미드(60/57.5/55)는
// 그대로 남는다.
const createExerciseFromLog = (
  previous: Exercise,
  name: string,
  metric: Metric,
): Exercise => ({
  id: uid(),
  name,
  metric,
  assisted: previous.assisted,
  bodyPart: previous.bodyPart ?? inferBodyPart(name),
  bodyPartManual: previous.bodyPartManual ?? false,
  sets: previous.sets.map((set, index, all) => ({
    id: uid(),
    weight: set.weight,
    reps: set.reps,
    done: true,
    ...(metric === "distance" ? { distanceKm: set.distanceKm ?? 0 } : {}),
    inheritWeight: index > 0 && set.weight === all[index - 1].weight,
    inheritReps: index > 0 && set.reps === all[index - 1].reps,
  })),
});

// 선택한 날짜 이전에 같은 종목을 마지막으로 한 기록.
const findLastLog = (
  history: Session[],
  name: string,
  metric: Metric,
  beforeKey: string,
): { exercise: Exercise; date: string } | null => {
  const normalized = normalizeExerciseName(name);
  let latest: { exercise: Exercise; date: string } | null = null;
  history.forEach((session) => {
    const key = sessionDateKey(session.date);
    if (key >= beforeKey || (latest && key <= latest.date)) return;
    const match = session.exercises.find(
      (exercise) =>
        normalizeExerciseName(exercise.name) === normalized &&
        (exercise.metric ?? "weight") === metric &&
        exercise.sets.length > 0,
    );
    if (match) latest = { exercise: match, date: key };
  });
  return latest;
};

const shortDateLabel = (key: string) => {
  const [, month, day] = key.split("-");
  return `${Number(month)}/${Number(day)}`;
};

// Epley 추정 1RM. 1회는 든 무게 그대로.
const estimateOneRepMax = (weight: number, reps: number) =>
  weight > 0 && reps > 0 ? weight * (1 + reps / 30) : 0;

type TrendPoint = {
  date: string;
  sets: number;
  topWeight: number;
  best1RM: number;
  topReps: number;
  totalReps: number;
  volume: number;
  distanceKm: number;
  minAssist: number | null;
  summary: string;
};

// 한 종목의 세션별 기록을 날짜 오름차순으로 정리한다.
const buildExerciseTrend = (
  history: Session[],
  name: string,
  metric: Metric,
): TrendPoint[] => {
  const normalized = normalizeExerciseName(name);
  const points: TrendPoint[] = [];
  history.forEach((session) => {
    session.exercises.forEach((exercise) => {
      if (
        normalizeExerciseName(exercise.name) !== normalized ||
        (exercise.metric ?? "weight") !== metric
      )
        return;
      const sets = exercise.sets.filter((set) => set.done);
      if (sets.length === 0) return;
      const assist = minAssistWeight(exercise);
      points.push({
        date: sessionDateKey(session.date),
        sets: sets.length,
        topWeight: sets.reduce((value, set) => Math.max(value, set.weight), 0),
        best1RM: sets.reduce(
          (value, set) =>
            Math.max(value, estimateOneRepMax(set.weight, set.reps)),
          0,
        ),
        topReps: sets.reduce((value, set) => Math.max(value, set.reps), 0),
        totalReps: sets.reduce((sum, set) => sum + set.reps, 0),
        volume: sets.reduce((sum, set) => sum + set.weight * set.reps, 0),
        distanceKm: sets.reduce((sum, set) => sum + (set.distanceKm ?? 0), 0),
        minAssist: isAssistedExercise(exercise) ? assist : null,
        summary:
          metric === "distance"
            ? `${formatNumber(
                sets.reduce((sum, set) => sum + (set.distanceKm ?? 0), 0),
              )}km`
            : sets
                .map((set) =>
                  set.weight > 0
                    ? `${formatNumber(set.weight)}×${set.reps}`
                    : `${set.reps}회`,
                )
                .join(" · "),
      });
    });
  });
  return points.sort((a, b) => a.date.localeCompare(b.date));
};

// 종목 성격에 맞는 대표 지표 하나를 고른다. 보조 종목은 "적을수록 좋음".
type TrendMode = {
  label: string;
  unit: string;
  lowerIsBetter: boolean;
  note: string;
  value: (point: TrendPoint) => number;
};

const trendMode = (metric: Metric, assisted: boolean): TrendMode => {
  if (metric === "distance")
    return {
      label: "거리",
      unit: "km",
      lowerIsBetter: false,
      note: "그날 기록한 거리 합계.",
      value: (point) => point.distanceKm,
    };
  if (assisted)
    return {
      label: "보조 중량",
      unit: "kg",
      lowerIsBetter: true,
      note: "그날 세트 중 가장 가벼운 보조 중량. 몸에서 빼주는 무게라 낮을수록 좋아요.",
      value: (point) => point.minAssist ?? point.topWeight,
    };
  if (metric === "bodyweight")
    return {
      label: "최고 반복",
      unit: "회",
      lowerIsBetter: false,
      note: "그날 한 세트에서 나온 최고 반복 수.",
      value: (point) => point.topReps,
    };
  return {
    label: "추정 1RM",
    unit: "kg",
    lowerIsBetter: false,
    // 실제로 든 최고 중량이 아니라, 무게×반복을 1회 최대치로 환산한 값(Epley).
    // 60×10과 70×5의 강도를 같은 자로 비교하려고 쓴다.
    note: "추정 1RM = 중량 × (1 + 반복 ÷ 30). 그날 세트 중 가장 높은 값이고, 실제로 든 최고 중량과는 다릅니다.",
    value: (point) => point.best1RM,
  };
};

const prepareSetForSave = (set: WorkoutSet): WorkoutSet => {
  const persisted = { ...set, done: true };
  delete persisted.inheritWeight;
  delete persisted.inheritReps;
  return persisted;
};
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
  const [detailTarget, setDetailTarget] = useState<{
    name: string;
    metric: Metric;
    assisted: boolean;
  } | null>(null);
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

  const canonicalExerciseNames = useMemo(
    () =>
      canonicalNameMap([
        ...[...history]
          .sort((a, b) => a.date.localeCompare(b.date))
          .flatMap((session) =>
            session.exercises.map((exercise) => exercise.name),
          ),
        ...favorites.map((favorite) => favorite.name),
      ]),
    [history, favorites],
  );

  const monthStats = useMemo(() => {
    const sets = monthSessions.flatMap((session) =>
      session.exercises
        .filter((exercise) => exercise.metric !== "distance")
        .flatMap((exercise) => exercise.sets.filter((set) => set.done)),
    );
    // HEAVIEST엔 실제로 "든" 무게만. 보조(어시스티드)는 몸에서 빼주는 값이라 제외.
    const liftedSets = monthSessions.flatMap((session) =>
      session.exercises
        .filter(
          (exercise) =>
            exercise.metric !== "distance" && !isAssistedExercise(exercise),
        )
        .flatMap((exercise) => exercise.sets.filter((set) => set.done)),
    );
    return {
      workouts: monthSessions.length,
      sets: sets.length,
      max: liftedSets.reduce((value, set) => Math.max(value, set.weight), 0),
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
      // max(든 무게)엔 보조 제외.
      max: draft
        .filter(
          (exercise) =>
            exercise.metric !== "distance" &&
            exercise.metric !== "bodyweight" &&
            !isAssistedExercise(exercise),
        )
        .flatMap((exercise) => exercise.sets)
        .reduce((value, set) => Math.max(value, set.weight), 0),
      hasWeight: weightSets.length > 0,
      reps: bodyweightSets.reduce((sum, set) => sum + set.reps, 0),
      distance: distanceSets.reduce(
        (sum, set) => sum + (set.distanceKm ?? 0),
        0,
      ),
    };
  }, [draft]);

  const detailPoints = useMemo(
    () =>
      detailTarget
        ? buildExerciseTrend(history, detailTarget.name, detailTarget.metric)
        : [],
    [history, detailTarget],
  );

  const coachInsight = useMemo(() => {
    if (monthSessions.length === 0)
      return "첫 기록을 남기면 다음 운동의 중량과 반복을 제안할게요.";
    const exerciseCounts = new Map<string, number>();
    monthSessions.forEach((session) =>
      session.exercises.forEach((exercise) => {
        const normalizedName = normalizeExerciseName(exercise.name);
        if (!normalizedName) return;
        exerciseCounts.set(
          normalizedName,
          (exerciseCounts.get(normalizedName) ?? 0) + 1,
        );
      }),
    );
    const mostFrequent = [...exerciseCounts.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0];
    const mostFrequentName = mostFrequent
      ? canonicalExerciseNames.get(mostFrequent[0])
      : null;
    return `${visibleMonth.getMonth() + 1}월 ${monthSessions.length}회 완료. ${mostFrequentName ?? "운동"}을 가장 꾸준히 기록했어요.`;
  }, [canonicalExerciseNames, monthSessions, visibleMonth]);

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
    // 표기가 달라도(띄어쓰기 등) 기존 종목이면 정본 이름으로 저장한다.
    const canonicalName =
      canonicalExerciseNames.get(normalizedName) ?? trimmedName;
    // 해본 적 있는 종목이면 직전 기록의 세트를 그대로 깔아준다. 대부분은
    // 숫자를 새로 치지 않고 무게만 조금 손보면 끝난다.
    const previous = findLastLog(history, canonicalName, metric, selectedDate);
    setDraft((current) => [
      ...current,
      previous
        ? createExerciseFromLog(previous.exercise, canonicalName, metric)
        : createExercise(canonicalName, metric),
    ]);
    setDirty(true);
    if (previous)
      setToast(`${shortDateLabel(previous.date)} 기록을 불러왔어요.`);
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

  const toggleExerciseAssisted = (exerciseId: string) => {
    setDraft((current) =>
      current.map((exercise) =>
        exercise.id === exerciseId
          ? { ...exercise, assisted: !exercise.assisted }
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
              // 기본 4세트와 똑같이 윗줄을 따라가게 둔다. 이 플래그가 없으면
              // 추가한 줄만 고정돼서 위에서 고친 무게·횟수가 내려오지 않는다.
              inheritWeight: previous !== undefined,
              inheritReps: previous !== undefined,
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

  // ± 버튼도 updateSet을 타므로 아래 줄로 이어지는 상속 규칙이 그대로 적용된다.
  const stepReps = (
    exerciseId: string,
    setId: string,
    current: number,
    delta: number,
  ) => {
    const next = Math.max(0, Math.round((current || 0) + delta));
    if (next === current) return;
    updateSet(exerciseId, setId, { reps: next });
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
            BRIEFING
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

            {report.balanceSummary && (
              <div className="report-section">
                <span>부위 밸런스</span>
                <p>{report.balanceSummary}</p>
              </div>
            )}
            {report.upperBody && (
              <div className="report-section">
                <span>상체 진단</span>
                <p>{report.upperBody}</p>
              </div>
            )}
            {report.lowerBody && (
              <div className="report-section">
                <span>하체 진단</span>
                <p>{report.lowerBody}</p>
              </div>
            )}
            {report.neglectNote && (
              <div className="report-section report-section-warn">
                <span>방치 부위</span>
                <p>{report.neglectNote}</p>
              </div>
            )}
            {(report.efficiencyVerdict ||
              (report.exerciseSelection?.length ?? 0) > 0) && (
              <div className="report-picks">
                <span>운동 선택</span>
                {report.efficiencyVerdict && (
                  <p>{report.efficiencyVerdict}</p>
                )}
                {report.exerciseSelection?.map((pick, pickIndex) => (
                  <div
                    className="report-pick"
                    key={`${pick.name}-${pickIndex}`}
                  >
                    <span className={`pick-${pick.verdict}`}>
                      {pick.verdict === "keep"
                        ? "유지"
                        : pick.verdict === "swap"
                          ? "교체"
                          : "제외"}
                    </span>
                    <div>
                      <b>{pick.name}</b>
                      <p>{pick.reason}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {report.bodyweightNote && (
              <div className="report-section">
                <span>체중·볼륨 추세</span>
                <p>{report.bodyweightNote}</p>
              </div>
            )}

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
                    // 보조 종목은 최소 보조값(베스트)을 미리보기에 표시 → 로그 칩과 일치.
                    const assistMin = isAssistedExercise(exercise)
                      ? minAssistWeight(exercise)
                      : null;
                    return {
                      id: exercise.id,
                      name: exercise.name,
                      value: isDistance
                        ? sets.reduce(
                            (sum, set) => sum + (set.distanceKm ?? 0),
                            0,
                          )
                        : assistMin !== null
                          ? assistMin
                          : isBodyweight
                            ? sets.reduce(
                                (value, set) => Math.max(value, set.reps),
                                0,
                              )
                            : sets.reduce(
                                (value, set) => Math.max(value, set.weight),
                                0,
                              ),
                      unit: isDistance
                        ? "km"
                        : assistMin !== null
                          ? "kg"
                          : isBodyweight
                            ? "회"
                            : "kg",
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
                    const assistedMin = isAssistedExercise(exercise)
                      ? minAssistWeight(exercise)
                      : null;
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
                                  : assistedMin !== null
                                    ? `보조 ${formatNumber(assistedMin)}kg`
                                    : isBodyweight
                                      ? `MAX ${formatNumber(maxReps)}회`
                                      : `MAX ${formatNumber(max)}kg`}
                              </small>
                              <button
                                className="trend-toggle"
                                onClick={() =>
                                  setDetailTarget({
                                    name: exercise.name,
                                    metric: exercise.metric ?? "weight",
                                    assisted: isAssistedExercise(exercise),
                                  })
                                }
                                aria-label={`${exercise.name} 기록 추이 보기`}
                                title="기록 추이"
                              >
                                <svg viewBox="0 0 14 14" aria-hidden="true">
                                  <polyline points="1,10 5,6 8,8.5 13,2" />
                                </svg>
                              </button>
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
                              aria-label={`${exercise.name} 운동 설정`}
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
                              {isBodyweight && (
                                <button
                                  type="button"
                                  className={`bodypart-chip ${
                                    exercise.assisted ? "active" : ""
                                  }`}
                                  onClick={() =>
                                    toggleExerciseAssisted(exercise.id)
                                  }
                                  aria-label={`${exercise.name} 보조`}
                                  aria-pressed={exercise.assisted === true}
                                >
                                  보조
                                </button>
                              )}
                            </div>
                            {isDistance ? (
                              <div className="distance-entry">
                                <span>DISTANCE</span>
                                <NumberInput
                                  min="0"
                                  step="0.1"
                                  inputMode="decimal"
                                  placeholder="0"
                                  value={exercise.sets[0]?.distanceKm ?? 0}
                                  onValueChange={(distanceKm) =>
                                    updateSet(
                                      exercise.id,
                                      exercise.sets[0].id,
                                      { distanceKm },
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
                                  <span>
                                    {isBodyweight
                                      ? exercise.assisted
                                        ? "보조KG"
                                        : "＋KG"
                                      : "KG"}
                                  </span>
                                  <span>REPS</span>
                                  <span />
                                </div>
                                {exercise.sets.map((set, setIndex) => (
                                  <div className="set-entry" key={set.id}>
                                    <b>{setIndex + 1}</b>
                                    <NumberInput
                                      min="0"
                                      step="0.5"
                                      inputMode="decimal"
                                      placeholder="0"
                                      value={set.weight}
                                      onValueChange={(weight) =>
                                        updateSet(exercise.id, set.id, {
                                          weight,
                                        })
                                      }
                                      aria-label={`${exercise.name} ${setIndex + 1}세트 ${
                                        isBodyweight
                                          ? exercise.assisted
                                            ? "보조중량"
                                            : "추가중량"
                                          : "중량"
                                      }`}
                                    />
                                    <div className="reps-field">
                                      <button
                                        type="button"
                                        className="reps-step"
                                        onClick={() =>
                                          stepReps(
                                            exercise.id,
                                            set.id,
                                            set.reps,
                                            -1,
                                          )
                                        }
                                        aria-label={`${setIndex + 1}세트 반복 1 줄이기`}
                                      >
                                        −
                                      </button>
                                      <NumberInput
                                        min="1"
                                        step="1"
                                        inputMode="numeric"
                                        placeholder="0"
                                        value={set.reps}
                                        onValueChange={(reps) =>
                                          updateSet(exercise.id, set.id, {
                                            reps,
                                          })
                                        }
                                        aria-label={`${exercise.name} ${setIndex + 1}세트 반복`}
                                      />
                                      <button
                                        type="button"
                                        className="reps-step"
                                        onClick={() =>
                                          stepReps(
                                            exercise.id,
                                            set.id,
                                            set.reps,
                                            1,
                                          )
                                        }
                                        aria-label={`${setIndex + 1}세트 반복 1 늘리기`}
                                      >
                                        ＋
                                      </button>
                                    </div>
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

      {detailTarget && (
        <ExerciseDetail
          name={detailTarget.name}
          metric={detailTarget.metric}
          assisted={detailTarget.assisted}
          points={detailPoints}
          onPickDate={(dateKey) => {
            const date = dateFromKey(dateKey);
            setVisibleMonth(new Date(date.getFullYear(), date.getMonth(), 1));
            setSelectedDate(dateKey);
            setDetailTarget(null);
          }}
          onClose={() => setDetailTarget(null)}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </main>
  );
}
