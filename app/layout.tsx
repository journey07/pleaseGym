import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const incomingHeaders = await headers();
  const host = incomingHeaders.get("host") ?? "please-gym.vercel.app";
  const protocol =
    host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https";
  const origin = `${protocol}://${host}`;
  const title = "EVERYONE BUT YOU — Workout Calendar";
  const description =
    "날짜를 고르고 운동·세트·중량·반복을 기록하는 미니멀 AI 운동 캘린더.";

  return {
    title,
    description,
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
      apple: "/apple-touch-icon.png",
    },
    appleWebApp: {
      // 아이폰 홈 화면 추가 시 표시되는 앱 이름
      title: "PleaseGym",
    },
    openGraph: {
      title,
      description,
      images: [
        {
          url: `${origin}/og.png`,
          width: 1536,
          height: 1024,
          alt: "EVERYONE BUT YOU Workout Calendar",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
