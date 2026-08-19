import assert from "node:assert/strict";
import test from "node:test";

import {
  addLoad,
  bestOneRepMax,
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
