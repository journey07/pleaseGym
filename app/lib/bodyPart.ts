// 운동 부위(bodyPart) 분류 — 서버 route와 클라이언트가 공유하는 순수 모듈.
// Date/DOM/네트워크 미사용 → 브라우저·노드 양쪽 안전(isomorphic).

export type BodyPart =
  | "가슴"
  | "등"
  | "어깨"
  | "팔"
  | "허벅지"
  | "종아리"
  | "복근"
  | "허리"
  | "기타";

export const BODY_PARTS: BodyPart[] = [
  "가슴",
  "등",
  "어깨",
  "팔",
  "허벅지",
  "종아리",
  "복근",
  "허리",
  "기타",
];

// 근육 8부위(기타 제외) — 볼륨 밸런스/방치 분석 대상.
export const MUSCLE_PARTS: BodyPart[] = [
  "가슴",
  "등",
  "어깨",
  "팔",
  "허벅지",
  "종아리",
  "복근",
  "허리",
];

// first-hit 순서 중요: 일반 토큰(프레스/레이즈/익스텐션)이 앞 부위에서
// 오분류되지 않도록 구체적 부위를 먼저, 일반 토큰(어깨)을 마지막에 둔다.
export const BODY_PART_KEYWORDS: { part: BodyPart; keywords: string[] }[] = [
  {
    part: "복근",
    keywords: [
      "복근",
      "코어",
      "크런치",
      "싯업",
      "윗몸",
      "플랭크",
      "레그레이즈",
      "레그 레이즈",
      "행잉",
      "abs",
      "ab ",
      "crunch",
      "plank",
      "situp",
      "leg raise",
      "hanging leg",
    ],
  },
  { part: "종아리", keywords: ["종아리", "카프", "calf"] },
  {
    part: "허리",
    keywords: [
      "허리",
      "굿모닝",
      "척추기립근",
      "기립근",
      "하이퍼익스텐션",
      "하이퍼 익스텐션",
      "백 익스텐션",
      "백익스텐션",
      "lower back",
    ],
  },
  {
    part: "허벅지",
    keywords: [
      "스쿼트",
      "런지",
      "레그프레스",
      "레그 프레스",
      "레그컬",
      "레그 컬",
      "레그익스텐션",
      "레그 익스텐션",
      "대퇴",
      "쿼드",
      "햄스트링",
      "허벅지",
      "타이",
      "어덕션",
      "앱덕션",
      "내전",
      "외전",
      // 둔근·힙힌지 계열. 힙 쓰러스트/글루트 브릿지가 "기타"로 빠지면
      // 달력에서 회색으로 칠해지고 하체 볼륨 집계에서도 통째로 누락된다.
      "힙",
      "hip",
      "둔근",
      "엉덩이",
      "글루트",
      "glute",
      "쓰러스트",
      "스러스트",
      "thrust",
      "브릿지",
      "브리지",
      "bridge",
      "squat",
      "lunge",
      "leg press",
      "leg curl",
      "leg extension",
      "adduction",
      "abduction",
    ],
  },
  {
    // 허벅지 뒤에 둬서 "레그컬/레그 컬"은 허벅지로, 나머지 "컬"은 팔로 간다.
    part: "팔",
    keywords: [
      "이두",
      "삼두",
      "바이셉",
      "트라이셉",
      "컬",
      "킥백",
      "프리처",
      "해머",
      "팔",
      "전완",
      "리스트",
      "bicep",
      "tricep",
      "curl",
      "kickback",
      "pushdown",
      "푸시다운",
      "푸쉬다운",
    ],
  },
  {
    part: "등",
    keywords: [
      "데드",
      "풀업",
      "친업",
      "턱걸이",
      "랫",
      "로우",
      "로잉",
      "등",
      "백로우",
      "deadlift",
      "pull-up",
      "pullup",
      "pulldown",
      "lat pull",
      "latpull",
      "row",
    ],
  },
  {
    part: "가슴",
    keywords: [
      "벤치",
      "체스트",
      "가슴",
      "딥스",
      "펙",
      "플라이",
      "푸시업",
      "푸쉬업",
      "푸시 업",
      "chest",
      "bench",
      "dip",
      "push-up",
      "pushup",
      "fly",
    ],
  },
  {
    part: "어깨",
    keywords: [
      "숄더",
      "오버헤드",
      "ohp",
      "밀리터리",
      "아놀드",
      "델트",
      "레이즈",
      "어깨",
      "shoulder",
      "overhead",
      "raise",
      "press",
    ],
  },
];

export const inferBodyPart = (name: string): BodyPart => {
  const normalized = name.trim().toLocaleLowerCase("ko-KR");
  if (!normalized) return "기타";
  for (const { part, keywords } of BODY_PART_KEYWORDS) {
    if (
      keywords.some((keyword) =>
        normalized.includes(keyword.toLocaleLowerCase("ko-KR")),
      )
    ) {
      return part;
    }
  }
  return "기타";
};

/**
 * 화면·집계에서 쓸 실제 부위.
 * 사용자가 칩으로 직접 고른 값(bodyPartManual)만 그대로 믿고, 그 외에는
 * 저장된 값을 무시하고 이름에서 다시 추론한다. 자동 추론 규칙이 좋아졌을 때
 * 예전에 저장된 잘못된 부위(예: 힙 쓰러스트 → 기타)가 그대로 굳지 않게 한다.
 */
export const resolveBodyPart = (
  name: string,
  stored?: BodyPart,
  manual?: boolean,
): BodyPart => (manual && stored ? stored : inferBodyPart(name));
