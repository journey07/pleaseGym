// 훈련 강도·볼륨 지표. 화면 그래프(app/page.tsx)와 AI 리포트(app/api/training-report)가
// 같은 숫자를 쓰도록 계산식을 여기 한 곳에만 둔다.
// (예전에 두 곳이 e1rm을 서로 다르게 계산해서 그래프 값과 코치 멘트 근거가 어긋났었다.)

// Epley 추정 1RM. 1회는 환산할 게 없으니 든 무게 그대로 쓴다
// (식을 그대로 적용하면 1회에 3.3%가 붙어서 실제 1RM 시도가 부풀려진다).
export const estimateOneRepMax = (weight: number, reps: number) => {
  if (weight <= 0 || reps <= 0) return 0;
  return reps === 1 ? weight : weight * (1 + reps / 30);
};

// 그날 그 종목 세트들 중 가장 높은 환산 1RM.
// 최고 "중량" 세트가 곧 최고 e1RM인 건 아니다(100×3 → 110 < 80×12 → 112).
export const bestOneRepMax = (sets: { weight: number; reps: number }[]) =>
  sets.reduce(
    (best, set) => Math.max(best, estimateOneRepMax(set.weight, set.reps)),
    0,
  );

// 세션 부하: 그날 그 종목의 전 세트를 한 덩어리로 보고 Epley를 확장한 값.
//   W = Σ(중량² × 반복) / Σ(중량 × 반복)   ← 볼륨 가중 평균 중량(무거운 세트일수록 크게)
//   R = Σ반복                              ← 그날 총 반복
//   부하 = W × (1 + R / 30)                 ← 단위 kg
// 최고 세트 하나만 보는 e1RM과 달리 세트를 늘려도(R↑) 중량을 올려도(W↑) 값이 오른다.
// 평균을 볼륨 가중으로 잡은 건 백오프·드롭 세트를 붙였을 때 점수가 깎이지 않게 하려는 것
// (단순 평균이면 가벼운 세트를 추가할수록 값이 내려가서 "더 했는데 후퇴"로 보인다).
export type LoadAccumulator = {
  weightedSum: number; // Σ(중량² × 반복)
  volume: number; // Σ(중량 × 반복)
  reps: number; // Σ반복
};

export const emptyLoad = (): LoadAccumulator => ({
  weightedSum: 0,
  volume: 0,
  reps: 0,
});

export const addLoad = (
  acc: LoadAccumulator,
  weight: number,
  reps: number,
): void => {
  if (weight <= 0 || reps <= 0) return;
  acc.weightedSum += weight * weight * reps;
  acc.volume += weight * reps;
  acc.reps += reps;
};

// 같은 날 같은 종목이 두 번 기록됐을 때 두 덩어리를 하나로 합친다.
export const mergeLoad = (
  a: LoadAccumulator,
  b: LoadAccumulator,
): LoadAccumulator => ({
  weightedSum: a.weightedSum + b.weightedSum,
  volume: a.volume + b.volume,
  reps: a.reps + b.reps,
});

export const sessionLoadFrom = (acc: LoadAccumulator): number => {
  if (acc.volume <= 0) return 0;
  const averageWeight = acc.weightedSum / acc.volume;
  // 총 1회짜리 세션(싱글 한 세트)은 e1RM과 마찬가지로 든 무게 그대로 둔다.
  return acc.reps === 1 ? averageWeight : averageWeight * (1 + acc.reps / 30);
};

export const sessionLoadOf = (
  sets: { weight: number; reps: number }[],
): number => {
  const acc = emptyLoad();
  sets.forEach((set) => addLoad(acc, set.weight, set.reps));
  return sessionLoadFrom(acc);
};
