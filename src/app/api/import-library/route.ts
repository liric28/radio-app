import { NextRequest, NextResponse } from "next/server";
import { addAllowedAudioRoot } from "@/lib/audio-roots";
import {
  scanLocalLibrary,
  defaultLibraryPath,
  deriveTasteProfileFromSongs,
} from "@/lib/local-library";
import { regenerateDailySchedule } from "@/lib/daily-schedule";
import { regenerateOnlineRadioProgram } from "@/lib/online-radio";
import { isOnlineRadioMode } from "@/lib/radio-mode";
import { writeSongCatalog, writeTasteProfile } from "@/lib/profile";
import { buildRadioProgram } from "@/lib/radio-engine";

/**
 * 读取本地音乐目录并刷新电台曲库。
 */
export async function POST(request: NextRequest) {
  const payload = (await request.json()) as {
    mode?: "replace" | "append";
    path?: string;
    limit?: number;
  };

  const libraryPath = payload.path || defaultLibraryPath;
  const limit = payload.limit && payload.limit > 0 ? payload.limit : undefined;

  try {
    const scannedSongs = await scanLocalLibrary(libraryPath, limit);

    if (scannedSongs.length === 0) {
      return NextResponse.json(
        { ok: false, message: "没有从本地目录读到可用音频文件" },
        { status: 400 },
      );
    }

    await writeSongCatalog(scannedSongs);
    await writeTasteProfile(deriveTasteProfileFromSongs(scannedSongs));
    await addAllowedAudioRoot(libraryPath);
    const { program, schedule } = isOnlineRadioMode()
      ? await regenerateOnlineRadioProgram()
      : {
          schedule: await regenerateDailySchedule(),
          program: await buildRadioProgram(),
        };

    return NextResponse.json({
      ok: true,
      importedCount: scannedSongs.length,
      libraryPath,
      schedule,
      program,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : "本地音乐库读取失败",
      },
      { status: 500 },
    );
  }
}
