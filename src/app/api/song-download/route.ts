import { NextRequest, NextResponse } from "next/server";
import { downloadAndIngestSong, SongDownloadError } from "@/lib/song-download";
import { regenerateDailySchedule } from "@/lib/daily-schedule";
import { regenerateOnlineRadioProgram } from "@/lib/online-radio";
import { appendPreferenceEvent, preferenceTrackFromSong } from "@/lib/preference-learning";
import { isOnlineRadioMode } from "@/lib/radio-mode";
import { buildRadioProgram } from "@/lib/radio-engine";
import { deriveTasteProfileFromSongs } from "@/lib/local-library";
import type { MusicSearchHit } from "@/lib/music-search";
import { readSongCatalog, writeTasteProfile } from "@/lib/profile";

/**
 * 搜索结果下载入口。
 *
 * 请求体直接收前端的 MusicSearchHit，路由层只做最薄的参数校验；
 * 真正的来源分流、重命名、落盘、补封面/歌词/tag 都在 song-download.ts。
 *
 * 成功后这里还负责把“下载一首歌”扩散成整套广播状态更新：
 * 1. 刷新 songs.json 对应的口味画像
 * 2. 重建当天 schedule
 * 3. 立刻生成新的当前 program 返回给前端
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
    const result = await downloadAndIngestSong(body);
    const songs = await readSongCatalog();
    await writeTasteProfile(deriveTasteProfileFromSongs(songs));
    const { program, schedule } = isOnlineRadioMode()
      ? await regenerateOnlineRadioProgram()
      : {
          schedule: await regenerateDailySchedule(),
          program: await buildRadioProgram(),
        };
    await appendPreferenceEvent({
      type: "download",
      action: "manual-download",
      scene: program.scene,
      track: preferenceTrackFromSong(program.currentTrack, program.scene),
    }).catch(() => null);
    return NextResponse.json({ ok: true, data: result, schedule, program });
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
