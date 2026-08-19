import assert from "node:assert/strict";
import test from "node:test";

import {
  addLoad,
  assistedLoad,
  bestOneRepMax,
  bodyweightForDate,
  detectAssisted,
  emptyLoad,
  estimateOneRepMax,
  mergeLoad,
  sessionLoadFrom,
  sessionLoadOf,
} from "../app/lib/trainingLoad.ts";

const set = (weight, reps) => ({ weight, reps });
const near = (actual, expected, tolerance = 0.5) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ~${expected}, got ${actual}`,
  );
const repeat = (count, weight, reps) =>
  Array.from({ length: count }, () => set(weight, reps));

test("e1RM은 최고 중량 세트가 아니라 전 세트 환산값의 최댓값", () => {
  // 100×3 → 110, 80×12 → 112. 더 무거운 건 100kg이지만 환산 최대는 80kg 세트다.
  near(bestOneRepMax([set(100, 3), set(80, 12)]), 112);
  near(estimateOneRepMax(100, 1), 100);
  assert.equal(estimateOneRepMax(0, 10), 0);
  assert.equal(estimateOneRepMax(60, 0), 0);
});

test("세션 부하는 잡볼륨을 무거운 세션보다 높게 치지 않는다", () => {
  const heavyTriples = sessionLoadOf(repeat(3, 100, 3));
  const standard = sessionLoadOf(repeat(5, 100, 5));
  const volume = sessionLoadOf(repeat(5, 60, 12));
  const junk = sessionLoadOf(repeat(5, 20, 20));

  near(heavyTriples, 130);
  near(standard, 183.3);
  near(volume, 180);
  near(junk, 86.7);

  // 톤수만 보면 잡볼륨(2000kg)이 무거운 3×3(900kg)을 이겨버린다. 세션 부하는 안 그래야 한다.
  assert.ok(junk < heavyTriples);
  assert.ok(standard > volume);
});

test("세트를 늘리면 값이 오른다", () => {
  assert.ok(
    sessionLoadOf(repeat(5, 60, 10)) > sessionLoadOf(repeat(3, 60, 10)),
  );
});

test("중량을 올리면 값이 오른다", () => {
  assert.ok(
    sessionLoadOf(repeat(5, 105, 5)) > sessionLoadOf(repeat(5, 100, 5)),
  );
});

test("백오프 세트를 붙여도 값이 깎이지 않는다", () => {
  const base = sessionLoadOf(repeat(5, 100, 5));
  const withBackoff = sessionLoadOf([...repeat(5, 100, 5), set(60, 10)]);
  assert.ok(
    withBackoff > base,
    `백오프 추가 후 ${withBackoff} <= 기존 ${base}`,
  );
});

test("무게·반복이 0이면 무시하고, 유효 세트가 없으면 0", () => {
  assert.equal(sessionLoadOf([]), 0);
  assert.equal(sessionLoadOf([set(0, 10), set(60, 0)]), 0);
  near(sessionLoadOf([set(0, 10), set(100, 5)]), sessionLoadOf([set(100, 5)]));
});

test("같은 날 두 번 기록한 걸 합치면 한 번에 기록한 것과 같다", () => {
  const morning = emptyLoad();
  repeat(3, 100, 5).forEach((s) => addLoad(morning, s.weight, s.reps));
  const evening = emptyLoad();
  repeat(2, 80, 8).forEach((s) => addLoad(evening, s.weight, s.reps));

  const merged = sessionLoadFrom(mergeLoad(morning, evening));
  const together = sessionLoadOf([...repeat(3, 100, 5), ...repeat(2, 80, 8)]);
  near(merged, together, 1e-9);
});

test("어시스티드는 보조가 가벼울수록 유효 부하가 커진다", () => {
  // 체중 80kg 기준. 보조 30kg → 50kg을 드는 셈, 보조 10kg → 70kg.
  assert.equal(assistedLoad(80, 30), 50);
  assert.equal(assistedLoad(80, 10), 70);
  assert.equal(assistedLoad(80, 0), 80);
  // 보조가 체중을 넘겨도 0 이하로는 안 내려간다.
  assert.equal(assistedLoad(80, 200), 1);

  const heavyAssist = sessionLoadOf(repeat(4, assistedLoad(80, 30), 8));
  const lightAssist = sessionLoadOf(repeat(4, assistedLoad(80, 10), 8));
  assert.ok(
    lightAssist > heavyAssist,
    `보조를 줄였는데 값이 안 올랐다: ${lightAssist} <= ${heavyAssist}`,
  );
});

test("어시스티드도 세트를 늘리면 값이 오른다", () => {
  const load = assistedLoad(80, 20);
  assert.ok(
    sessionLoadOf(repeat(5, load, 8)) > sessionLoadOf(repeat(3, load, 8)),
  );
});

test("그 날짜 시점의 체중을 고른다", () => {
  const log = [
    { date: "2026-01-01", kg: 80 },
    { date: "2026-03-01", kg: 76 },
  ];
  assert.equal(bodyweightForDate(log, "2026-02-01"), 80);
  assert.equal(bodyweightForDate(log, "2026-03-01"), 76);
  assert.equal(bodyweightForDate(log, "2026-06-01"), 76);
  // 첫 기록보다 이른 날짜는 첫 기록으로 대신한다.
  assert.equal(bodyweightForDate(log, "2025-12-01"), 80);
  assert.equal(bodyweightForDate([], "2026-02-01"), null);
});

test("어시스티드 감지는 플래그가 없어도 이름으로 잡는다", () => {
  assert.equal(detectAssisted("어시스티드 풀업"), true);
  assert.equal(detectAssisted("Assisted Pull-up"), true);
  assert.equal(detectAssisted("풀업", true), true);
  assert.equal(detectAssisted("풀업"), false);
  assert.equal(detectAssisted("백 스쿼트"), false);
});
