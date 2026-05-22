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
    duration: 0,
    coverUrl: "",
    audioUrl: "",
    mood: t.mood,
    reasonSeed: t.reasonSeed,
    scene,
  }));

  // 批量一次调 MiniMax，失败退回模板
  const reasonMap = await batchRewriteTrackReasons(songs, scene);
  const reasons: Record<string, string> = {};
  tracks.forEach((t) => {
    reasons[t.id] =
      reasonMap.get(t.id) ?? `${scene}里保留${t.mood}质感，${t.reasonSeed}`;
  });

  return NextResponse.json({ reasons });
}
