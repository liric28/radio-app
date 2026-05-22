import { NextRequest, NextResponse } from "next/server";
import { rewriteTrackReason } from "@/lib/providers/llm";
import type { Song } from "@/lib/types";

export async function POST(req: NextRequest) {
  const { tracks, scene } = (await req.json()) as {
    tracks: Array<{ id: string; mood: string; reasonSeed: string }>;
    scene: string;
  };

  if (!tracks?.length) {
    return NextResponse.json({ reasons: {} });
  }

  // 用 MiniMax AI 润色（失败退回模板）
  const results = await Promise.all(
    tracks.map(async (t) => {
      const song: Song = {
        id: t.id,
        title: "",
        artist: "",
        album: "",
        duration: 0,
        coverUrl: "",
        audioUrl: "",
        mood: t.mood,
        reasonSeed: t.reasonSeed,
        scene,
      };
      const reason = await rewriteTrackReason(song, scene);
      return { id: t.id, reason };
    }),
  );

  const reasons: Record<string, string> = {};
  results.forEach(({ id, reason }) => {
    reasons[id] = reason;
  });

  return NextResponse.json({ reasons });
}
