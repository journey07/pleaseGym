"use client";

import { useState } from "react";
import { BODY_REGIONS, BODY_SILHOUETTE, type BodyView } from "./lib/bodyMap";
import type { BodyPart } from "./lib/bodyPart";
import type { BodyPartStat } from "./lib/bodyPartStats";

// 부하 단계는 볼륨(kg)이 아니라 "주간 세트 수"로 나눈다. 볼륨은 부위끼리 단위가
// 달라서(스쿼트 5,000kg vs 크런치 80회) 같은 그림 위에 놓고 비교할 수가 없다.
// 세트 수는 부위 공통 단위이고, 근비대 문헌이 부위당 주 10~20세트를 생산적인
// 범위로 보기 때문에 상대값이 아니라 절대 기준으로 칠할 수 있다.
const LEVELS: { min: number; label: string; tone: string }[] = [
  { min: 1, label: "1–4", tone: "#ffe3d8" },
  { min: 5, label: "5–9", tone: "#ffbca4" },
  { min: 10, label: "10–14", tone: "#ff8c66" },
  { min: 15, label: "15–19", tone: "#f2551f" },
  { min: 20, label: "20+", tone: "#b83a12" },
];

const EMPTY_TONE = "#dadad2";

const toneFor = (weeklySets: number): string => {
  let tone = EMPTY_TONE;
  for (const level of LEVELS) if (weeklySets >= level.min) tone = level.tone;
  return tone;
};

// 방치 부위: 28일간 한 번도 없거나 10일 이상 공백. 색이 아니라 점선 테두리로
// 표시해서 "부하가 낮다"와 "손을 놨다"를 색 하나에 섞지 않는다.
const isNeglected = (stat: BodyPartStat | undefined): boolean =>
  !stat || stat.daysSinceLast === null || stat.daysSinceLast >= 10;

const VIEW_LABEL: Record<BodyView, string> = { front: "앞", back: "뒤" };

export default function BodyLoadMap({ stats }: { stats: BodyPartStat[] }) {
  const [selected, setSelected] = useState<BodyPart | null>(null);
  const byPart = new Map(stats.map((stat) => [stat.part, stat]));
  const totalSets = stats.reduce((sum, stat) => sum + stat.weeklySets, 0);
  const active = selected ? byPart.get(selected) : undefined;

  const figure = (view: BodyView) => (
    <div className="body-figure">
      <svg
        viewBox="0 0 120 280"
        role="img"
        aria-label={`${VIEW_LABEL[view]}면 부위별 주간 세트`}
      >
        {BODY_SILHOUETTE.map((d, index) => (
          <path key={`base-${index}`} d={d} className="body-base" />
        ))}
        {BODY_REGIONS[view].map((region) => {
          const stat = byPart.get(region.part);
          const sets = stat?.weeklySets ?? 0;
          const on = selected === region.part;
          return (
            <g
              key={region.part}
              className={`body-region${on ? " on" : ""}${
                isNeglected(stat) ? " neglected" : ""
              }`}
              fill={toneFor(sets)}
              tabIndex={0}
              role="button"
              aria-pressed={on}
              aria-label={`${region.part} 주간 ${sets}세트`}
              onClick={() => setSelected(on ? null : region.part)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                setSelected(on ? null : region.part);
              }}
            >
              {region.paths.map((d, index) => (
                <path key={index} d={d} />
              ))}
            </g>
          );
        })}
      </svg>
      <small>{VIEW_LABEL[view]}</small>
    </div>
  );

  return (
    <div className="body-map">
      <div className="body-map-head">
        <span>부위별 부하 · 최근 7일</span>
        <b>
          {totalSets}
          <em>세트</em>
        </b>
      </div>

      <div className="body-map-grid">
        <div className="body-map-figures">
          <div className="body-figures">
            {figure("front")}
            {figure("back")}
          </div>

          <div className="body-legend" aria-hidden="true">
            <i style={{ background: EMPTY_TONE }} />
            <span>0</span>
            {LEVELS.map((level) => (
              <span key={level.min} className="body-legend-step">
                <i style={{ background: level.tone }} />
                {level.label}
              </span>
            ))}
            <span className="body-legend-unit">세트/주</span>
          </div>
        </div>

        <div className="body-map-side">
          <p className="body-map-note">
            {active
              ? `${active.part} · 주 ${active.weeklySets}세트 · ${
                  active.freq7
                }일 · ${
                  active.daysSinceLast === null
                    ? "최근 28일 기록 없음"
                    : active.daysSinceLast === 0
                      ? "오늘 훈련"
                      : `${active.daysSinceLast}일 전 훈련`
                }`
              : "부위를 누르면 자세히 볼 수 있어요. 점선은 10일 넘게 안 건드린 부위입니다."}
          </p>

          {/* 색만으로 읽히지 않도록 같은 데이터를 숫자로도 둔다. */}
          <ul className="body-part-list">
            {[...stats]
              .sort((a, b) => b.weeklySets - a.weeklySets)
              .map((stat) => (
                <li key={stat.part}>
                  <button
                    className={selected === stat.part ? "on" : ""}
                    onClick={() =>
                      setSelected(selected === stat.part ? null : stat.part)
                    }
                  >
                    <i style={{ background: toneFor(stat.weeklySets) }} />
                    <b>{stat.part}</b>
                    <span>
                      {stat.daysSinceLast === null
                        ? "기록 없음"
                        : `${stat.daysSinceLast}일 전`}
                    </span>
                    <strong>
                      {stat.weeklySets}
                      <em>세트</em>
                    </strong>
                  </button>
                </li>
              ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
