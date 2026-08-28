"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  computeMissionStats,
  computeVision,
  koreanDateLabel,
  type MissionStats,
  type VisionRow,
} from "@/app/lib/missionStats";

type Decision = "go" | "no_go";

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
  metric?: "weight" | "bodyweight" | "distance";
  sets: StoredSet[];
};

type StoredSession = {
  date?: string;
  exercises?: StoredExercise[];
};

type MorningVideo = {
  id: string;
  title: string;
  url: string;
};

const MORNING_VIDEOS_KEY = "first-rep-morning-videos";

const normalizeVideoUrl = (raw: string) => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

const videoHost = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const videoLabel = (video: MorningVideo) =>
  video.title.trim() || videoHost(video.url);

const pickRandomVideo = (videos: MorningVideo[]) =>
  videos[Math.floor(Math.random() * videos.length)];

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

const readWorkoutHistory = async () => {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (response.ok) {
      const data = (await response.json()) as {
        state?: { history?: unknown } | null;
      };
      if (data.state) {
        const history = Array.isArray(data.state.history)
          ? (data.state.history as StoredSession[])
          : [];
        window.localStorage.setItem(
          "first-rep-history",
          JSON.stringify(history),
        );
        return history;
      }
    }
  } catch {
    // Fall through to the offline cache.
  }

  return readArray<StoredSession>("first-rep-history");
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

const readMissionStats = (): MissionStats =>
  computeMissionStats({
    sessions: readArray<StoredSession>("first-rep-history"),
    todayKey: todayKey(),
  });

const readStoredSessions = () => readArray<StoredSession>("first-rep-history");

export default function MorningBridge() {
  const [dateLabel, setDateLabel] = useState("");
  const [decision, setDecision] = useState<Decision | null>(null);
  const [todayDecision, setTodayDecision] = useState<Decision | null>(null);
  const [missionStats, setMissionStats] = useState<MissionStats>(() =>
    computeMissionStats({ sessions: [], todayKey: "1970-01-01" }),
  );
  const [visionSessions, setVisionSessions] = useState<StoredSession[]>([]);
  const [skipOpen, setSkipOpen] = useState(false);
  const [skipProgress, setSkipProgress] = useState(0);
  const [skipHolding, setSkipHolding] = useState(false);
  const [videos, setVideos] = useState<MorningVideo[]>([]);
  const [videosLoaded, setVideosLoaded] = useState(false);
  const [videosNeonReady, setVideosNeonReady] = useState(false);
  const [videoEditOpen, setVideoEditOpen] = useState(false);
  const [newVideoUrl, setNewVideoUrl] = useState("");
  const [newVideoTitle, setNewVideoTitle] = useState("");
  const [videoNotice, setVideoNotice] = useState("");
  const [bodyweightInput, setBodyweightInput] = useState("");
  const [latestWeight, setLatestWeight] = useState<number | null>(null);
  const vision: VisionRow[] = useMemo(
    () => computeVision(visionSessions, latestWeight),
    [visionSessions, latestWeight],
  );
  const [weightSaving, setWeightSaving] = useState(false);
  const [schedule, setSchedule] = useState<{
    enabled: boolean;
    hour: number;
    minute: number;
  }>({ enabled: true, hour: 7, minute: 29 });
  const [scheduleLoaded, setScheduleLoaded] = useState(false);
  const [scheduleSavedAt, setScheduleSavedAt] = useState<number | null>(null);
  const holdInterval = useRef<number | null>(null);
  const holdTimeout = useRef<number | null>(null);
  // Set once the user acts on today's decision so a slower in-flight server
  // hydration can't clobber the fresh local choice with a stale server value.
  const userActedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setDateLabel(
      new Intl.DateTimeFormat("ko-KR", {
        month: "long",
        day: "numeric",
        weekday: "long",
      }).format(new Date()),
    );
    setMissionStats(readMissionStats());
      setVisionSessions(readStoredSessions());
    void readWorkoutHistory().then(() => {
      if (!cancelled) setMissionStats(readMissionStats());
      setVisionSessions(readStoredSessions());
    });

    // Restore today's committed decision so re-tapping the same one won't re-run the coach.
    const decisions = readArray<{ date?: string; decision?: Decision }>(
      "first-rep-morning-decisions",
    );
    const todays = decisions.find((item) => item.date === todayKey());
    if (todays?.decision === "go" || todays?.decision === "no_go") {
      setTodayDecision(todays.decision);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  // Cross-device sync: the server (Neon morning_events) is the source of truth for
  // today's decision. localStorage above only covers this device, so a decision made
  // on another device wouldn't show here without this server hydration.
  useEffect(() => {
    let cancelled = false;

    const hydrateDecisionFromServer = async () => {
      try {
        const response = await fetch("/api/morning-decision", {
          cache: "no-store",
        });
        if (!response.ok) return;
        const data = (await response.json()) as {
          decision?: Decision | null;
        };
        if (cancelled) return;
        // If the user already committed a decision on this device while the GET
        // was in flight, don't let the (possibly stale) server value overwrite it.
        if (userActedRef.current) return;
        if (data.decision !== "go" && data.decision !== "no_go") return;

        setTodayDecision(data.decision);
        storeDecision(data.decision); // mirror into local so streak/idempotency stay consistent
        setMissionStats(readMissionStats());
      setVisionSessions(readStoredSessions());
        setDecision(data.decision);
      } catch {
        // Offline → the localStorage restore above remains the source.
      }
    };

    void hydrateDecisionFromServer();
    return () => {
      cancelled = true;
    };
  }, []);

  // 체중 최신값 하이드레이션 (기기 간 동기화).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/bodyweight", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
          log?: { date: string; kg: number }[];
        };
        if (cancelled || !Array.isArray(data.log) || data.log.length === 0)
          return;
        const last = data.log[data.log.length - 1];
        if (last && Number.isFinite(last.kg)) setLatestWeight(last.kg);
      } catch {
        // 오프라인 → 무시.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 아침 루틴 스케줄 하이드레이션.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/morning-schedule", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          schedule?: { enabled: boolean; hour: number; minute: number };
        };
        if (cancelled || !data.schedule) return;
        setSchedule(data.schedule);
      } catch {
        // 오프라인 → 기본값 유지.
      } finally {
        if (!cancelled) setScheduleLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setVideos(
      readArray<MorningVideo>(MORNING_VIDEOS_KEY).filter(
        (video) => typeof video?.url === "string" && video.url.length > 0,
      ),
    );
    setVideosLoaded(true);
  }, []);

  useEffect(() => {
    if (videosLoaded)
      window.localStorage.setItem(MORNING_VIDEOS_KEY, JSON.stringify(videos));
  }, [videos, videosLoaded]);

  useEffect(() => {
    if (!videosLoaded) return;
    let cancelled = false;

    const connectVideosToNeon = async () => {
      try {
        const response = await fetch("/api/morning-videos", {
          cache: "no-store",
        });
        if (!response.ok) return;
        const data = (await response.json()) as { videos?: unknown };
        if (cancelled) return;

        if (Array.isArray(data.videos) && data.videos.length > 0) {
          const serverVideos = data.videos as MorningVideo[];
          setVideos(serverVideos);
          window.localStorage.setItem(
            MORNING_VIDEOS_KEY,
            JSON.stringify(serverVideos),
          );
          setVideosNeonReady(true);
          return;
        }

        const localVideos = JSON.parse(
          window.localStorage.getItem(MORNING_VIDEOS_KEY) ?? "[]",
        ) as unknown;
        if (Array.isArray(localVideos) && localVideos.length > 0) {
          const importResponse = await fetch("/api/morning-videos", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videos: localVideos }),
          });
          if (!cancelled && importResponse.ok) setVideosNeonReady(true);
          return;
        }

        setVideosNeonReady(true);
      } catch {
        // Local storage remains the offline source when Neon is unavailable.
      }
    };

    void connectVideosToNeon();
    return () => {
      cancelled = true;
    };
    // This runs once after the local video cache has been hydrated.
  }, [videosLoaded]);

  useEffect(() => {
    if (!videosNeonReady) return;
    const timer = window.setTimeout(() => {
      void fetch("/api/morning-videos", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videos }),
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [videos, videosNeonReady]);

  useEffect(() => {
    if (!videoNotice) return;
    const timer = window.setTimeout(() => setVideoNotice(""), 2600);
    return () => window.clearTimeout(timer);
  }, [videoNotice]);

  const launchVideo = (pick: MorningVideo, successNotice: string) => {
    // A "noopener" feature string makes window.open return null even on success,
    // which would break blocked-popup detection — sever the opener manually instead.
    const opened = window.open(pick.url, "_blank");
    if (opened) opened.opener = null;
    setVideoNotice(
      opened
        ? successNotice
        : "팝업이 차단되어 영상을 열지 못했어요. 목록에서 직접 눌러 열어주세요.",
    );
  };

  const openRandomVideo = () => {
    if (videos.length === 0) {
      setVideoEditOpen(true);
      setVideoNotice("먼저 아침 영상을 등록해주세요.");
      return;
    }
    const pick = pickRandomVideo(videos);
    launchVideo(pick, `${videoLabel(pick)} 영상을 열었어요.`);
  };

  const addVideo = (event: FormEvent) => {
    event.preventDefault();
    const url = normalizeVideoUrl(newVideoUrl);
    if (!url) {
      setVideoNotice("올바른 영상 주소를 입력해주세요.");
      return;
    }
    if (videos.some((video) => video.url === url)) {
      setVideoNotice("이미 목록에 있는 영상이에요.");
      return;
    }
    setVideos((current) => [
      ...current,
      { id: uid(), title: newVideoTitle.trim(), url },
    ]);
    setNewVideoUrl("");
    setNewVideoTitle("");
  };

  const removeVideo = (videoId: string) => {
    setVideos((current) => current.filter((video) => video.id !== videoId));
  };

  const persistSchedule = async (next: {
    enabled: boolean;
    hour: number;
    minute: number;
  }) => {
    setSchedule(next);
    try {
      const res = await fetch("/api/morning-schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (res.ok) setScheduleSavedAt(Date.now());
    } catch {
      // 오프라인 → 로컬 상태만 반영, 다음 로드 시 서버값.
    }
  };

  const toggleSchedule = () =>
    persistSchedule({ ...schedule, enabled: !schedule.enabled });

  const changeScheduleTime = (value: string) => {
    const [h, m] = value.split(":").map((n) => Number(n));
    if (!Number.isInteger(h) || !Number.isInteger(m)) return;
    persistSchedule({ ...schedule, hour: h, minute: m });
  };

  const saveBodyweight = async () => {
    const kg = Number(bodyweightInput);
    if (!Number.isFinite(kg) || kg <= 0 || kg > 500) return;
    setWeightSaving(true);
    try {
      const res = await fetch("/api/bodyweight", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: todayKey(), kg }),
      });
      if (res.ok) {
        setLatestWeight(kg);
        setBodyweightInput("");
      }
    } catch {
      // 오프라인 → 무시.
    } finally {
      setWeightSaving(false);
    }
  };

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
    userActedRef.current = true;

    setDecision(nextDecision);
    setSkipOpen(false);
    clearSkipHold();

    // Log XP only on the first decision of the day or a real switch — not a same-decision re-tap.
    if (nextDecision !== todayDecision) {
      storeDecision(nextDecision);
      setTodayDecision(nextDecision);
      setMissionStats(readMissionStats());
      setVisionSessions(readStoredSessions());
      // Must stay before the first await so the popup keeps its user-gesture pass.
      if (nextDecision === "go" && videos.length > 0) {
        const pick = pickRandomVideo(videos);
        launchVideo(pick, `오늘의 영상: ${videoLabel(pick)}`);
      }
    }

    try {
      const response = await fetch("/api/morning-decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: nextDecision }),
      });
      if (!response.ok) throw new Error("결정을 저장하지 못했습니다.");
    } catch {
      // The local decision remains available if Neon is temporarily unavailable.
    }
  };

  const startSkipHold = () => {
    if (skipHolding) return;
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

  return (
    <main className="morning-page">
      <section className="morning-card">
        <header className="morning-head">
          <Link href="/" aria-label="운동 달력으로 돌아가기">
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
          </Link>
          <p>{dateLabel || "오늘"}</p>
        </header>

        <div className="mission-hud" aria-label="운동 루틴 현황">
          <div className="mission-week">
            <span className="week-dots" aria-hidden="true">
              {Array.from({ length: missionStats.weeklyGoal }, (_, index) => (
                <i
                  key={index}
                  className={
                    index < missionStats.thisWeekCount ? "on" : undefined
                  }
                />
              ))}
            </span>
            <b>
              {missionStats.remainingThisWeek === 0
                ? "이번 주 다 채웠다"
                : `이번 주 ${missionStats.remainingThisWeek}회 남았다`}
            </b>
          </div>

          <p className="mission-streak">
            {missionStats.streakBroken ||
            missionStats.streakStartDate === null ? (
              <span className="streak-broken">루틴이 끊겼다. 오늘 다시 시작</span>
            ) : (
              <>
                <b>{missionStats.streakDays}일째</b>
                <span>루틴 지키는 중</span>
                <small>
                  {koreanDateLabel(missionStats.streakStartDate)}부터
                </small>
              </>
            )}
          </p>

          <div className="vision-card">
            <span>3년 뒤의 나</span>
            <ul>
              {vision.map((row) => (
                <li key={row.key}>
                  <b>{row.label}</b>
                  <em>
                    {row.current === null ? "-" : row.current}
                    {row.key === "pullup" && row.current !== null ? "kg 보조" : "kg"}
                    <i aria-hidden="true">→</i>
                    {row.key === "pullup" ? "맨몸 10개" : `${row.target}kg`}
                  </em>
                  <small>{row.note}</small>
                </li>
              ))}
            </ul>
            <p>
              숫자만 오른 게 아니라 보면 아는 몸이다.
              <br />
              주 3회는 더 이상 결심이 아니다.
            </p>
          </div>
        </div>

        <div className="bodyweight-strip">
          <span>
            BODYWEIGHT
            {latestWeight !== null && <b>{latestWeight}kg</b>}
          </span>
          <div>
            <input
              type="number"
              min="0"
              step="0.1"
              inputMode="decimal"
              value={bodyweightInput}
              onChange={(event) => setBodyweightInput(event.target.value)}
              placeholder={latestWeight !== null ? `${latestWeight}` : "kg"}
              aria-label="오늘 체중 입력"
            />
            <button
              type="button"
              onClick={saveBodyweight}
              disabled={weightSaving || bodyweightInput.trim() === ""}
            >
              {weightSaving ? "..." : "기록"}
            </button>
          </div>
        </div>

        <div className={`routine-setting ${schedule.enabled ? "" : "off"}`}>
          <div className="routine-setting-main">
            <div className="routine-setting-copy">
              <span>ALARM</span>
              <b>
                {schedule.enabled
                  ? `매일 ${schedule.hour < 12 ? "오전" : "오후"} ${pad(
                      schedule.hour,
                    )}:${pad(schedule.minute)} 영상 재생`
                  : "꺼짐 — 아침 영상이 뜨지 않아요"}
              </b>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={schedule.enabled}
              aria-label="아침 알람 켜기/끄기"
              className={`routine-switch ${schedule.enabled ? "on" : ""}`}
              onClick={toggleSchedule}
              disabled={!scheduleLoaded}
            >
              <i aria-hidden="true" />
            </button>
          </div>
          {schedule.enabled && (
            <div className="routine-time">
              <label htmlFor="routine-time-input">알람 시간</label>
              <input
                id="routine-time-input"
                type="time"
                value={`${pad(schedule.hour)}:${pad(schedule.minute)}`}
                onChange={(event) => changeScheduleTime(event.target.value)}
                disabled={!scheduleLoaded}
              />
            </div>
          )}
          <small className="routine-hint">
            {scheduleLoaded
              ? "변경은 몇 분 안에 맥 알람에 반영돼요."
              : "설정 불러오는 중…"}
            {scheduleSavedAt && <em> · 저장됨</em>}
          </small>
        </div>

        <div className="morning-copy">
          <span>
            {pad(schedule.hour)}:{pad(schedule.minute)} · TODAY&apos;S QUEST
          </span>
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
              : "오늘의 결정이 기록됐습니다."}
          </p>
        </div>

        {decision === null && !skipOpen && (
          <section className="quest-card" aria-label="오늘의 운동 퀘스트">
            <div className="quest-card-top">
              <span>MAIN QUEST · 01</span>
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
          </div>
        )}

        <section className="video-section" aria-label="아침 영상 목록">
          <div className="video-head">
            <span>VIDEO</span>
            <button
              className="video-edit-toggle"
              onClick={() => setVideoEditOpen((open) => !open)}
            >
              {videoEditOpen ? "편집 완료" : "목록 편집"}
            </button>
          </div>
          <p className="video-hint">
            {videos.length > 0
              ? `퀘스트를 수락하면 ${videos.length}개 중 하나가 랜덤으로 열려요.`
              : "아침에 볼 영상을 등록해두면 퀘스트 수락과 함께 랜덤으로 하나가 열려요."}
          </p>

          {videos.length > 0 && (
            <button className="video-play" onClick={openRandomVideo}>
              <span>▶ 랜덤 영상 지금 열기</span>
            </button>
          )}

          {videoEditOpen && (
            <>
              {videos.length > 0 && (
                <div className="video-list">
                  {videos.map((video) => (
                    <div className="video-row" key={video.id}>
                      <a
                        href={video.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {videoLabel(video)}
                      </a>
                      <small>{videoHost(video.url)}</small>
                      <button
                        onClick={() => removeVideo(video.id)}
                        aria-label={`${videoLabel(video)} 영상 삭제`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <form className="video-add" onSubmit={addVideo}>
                <input
                  value={newVideoUrl}
                  onChange={(event) => setNewVideoUrl(event.target.value)}
                  placeholder="영상 주소 (예: youtube.com/watch?v=...)"
                  aria-label="추가할 영상 주소"
                />
                <input
                  value={newVideoTitle}
                  onChange={(event) => setNewVideoTitle(event.target.value)}
                  placeholder="제목 (선택)"
                  aria-label="추가할 영상 제목"
                />
                <button type="submit">추가</button>
              </form>
            </>
          )}

          {videoNotice && (
            <small className="video-notice" role="status">
              {videoNotice}
            </small>
          )}
        </section>
      </section>
    </main>
  );
}
