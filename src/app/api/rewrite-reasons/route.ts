import { NextRequest, NextResponse } from "next/server";
import { batchRewriteTrackReasons } from "@/lib/providers/llm";
import type { Song } from "@/lib/types";

export async function POST(req: NextRequest) {
  const { tracks, scene } = (await req.json()) as {
    tracks: Array<{ id: string; mood: string; reasonSeed: string }>;
    scene: string;
  };

  if (!tracks?.length) {
    return NextResponse.json({ reasons: {} });
  }

  const songs: Song[] = tracks.map((t) => ({
    id: t.id,
    title: "",
    artist: "",
    year: new Date().getFullYear(),
    mood: t.mood,
    energy: 5,
    language: "中文",
    tags: [],
    reasonSeed: t.reasonSeed,
  }));

  // 批量一次调 MiniMax，失败退回模板
  const reasonMap = await batchRewriteTrackReasons(songs, scene);
  const reasons: Record<string, string> = {};
  tracks.forEach((t) => {
    reasons[t.id] = reasonMap.get(t.id) ?? t.reasonSeed;
  });

  return NextResponse.json({ reasons });
}
