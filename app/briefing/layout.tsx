import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "EVERYONE BUT YOU — Briefing",
  description: "오늘 갈지 정하고, 오늘의 분할과 목표 중량을 받아가는 곳.",
};

export default function BriefingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
