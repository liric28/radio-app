import { NextRequest, NextResponse } from "next/server";
import type { MusicSearchHit } from "@/lib/music-search";
import { resolvePlaybackUrlForHit, SongDownloadError } from "@/lib/song-download";

/**
 * 搜索结果试听入口。
 *
 * 前端把完整的 MusicSearchHit 传进来，后端按来源换成真实可播放直链，
 * 这样浏览器端不需要知道各平台的签名、临时服务地址和字段差异。
 *
 * 这是一个“只解析直链、不入库”的轻接口：
 * - 不写 songs.json
 * - 不重建 schedule / program
 * - 只把 url 返回给前端，供搜索弹层里的临时试听使用
 */
export async function POST(request: NextRequest) {
  let body: MusicSearchHit;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  if (!body?.source || !body?.title || !body?.artist || !body?.raw) {
    return NextResponse.json(
      { ok: false, error: "missing source/title/artist/raw" },
      { status: 400 },
    );
  }

  try {
    const url = await resolvePlaybackUrlForHit(body);
    if (!url) {
      return NextResponse.json({ ok: false, error: "当前没有可播放直链" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, url });
  } catch (error) {
    if (error instanceof SongDownloadError) {
      return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status: 409 });
    }
    return NextResponse.json(
      { ok: false, error: (error as Error).message },
      { status: 500 },
    );
  }
}
