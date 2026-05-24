import { NextRequest, NextResponse } from "next/server";
import { searchSongsBySource, type MusicSearchSource } from "@/lib/music-search";

export const dynamic = "force-dynamic";

function isMusicSearchSource(value: string): value is MusicSearchSource {
  return value === "kugou" || value === "qq" || value === "netease";
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const keyword = searchParams.get("keyword")?.trim() ?? "";
  const rawSource = searchParams.get("source")?.trim() ?? "kugou";
  const source: MusicSearchSource = isMusicSearchSource(rawSource) ? rawSource : "kugou";
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const limit = Math.min(30, Math.max(1, Number(searchParams.get("limit") ?? 20)));

  if (!keyword) {
    return NextResponse.json({ success: false, error: "keyword is required" }, { status: 400 });
  }

  try {
    const hits = await searchSongsBySource(keyword, source, page, limit);
    return NextResponse.json(
      { success: true, data: hits, source },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { success: true, data: [], error: (error as Error).message, source },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
