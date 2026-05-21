import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claudio FM",
  description: "把多年歌单蒸馏成一个会接歌、会说话的 AI 电台。",
};

/**
 * 根布局负责注入全局样式和页面元信息。
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
