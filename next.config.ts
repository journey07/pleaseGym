import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /morning 은 /briefing 으로 이름이 바뀌었다. 홈 화면 바로가기나 북마크가
  // 옛 경로를 가리키고 있을 수 있어 영구 리다이렉트를 남긴다.
  async redirects() {
    return [{ source: "/morning", destination: "/briefing", permanent: true }];
  },
};

export default nextConfig;
