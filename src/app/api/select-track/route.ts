import { NextRequest, NextResponse } from "next/server";
import { ensureDailySchedule } from "@/lib/daily-schedule";
import { selectTrackProgram } from "@/lib/radio-engine";

/**
 * 将指定歌曲切为当前播放曲目。
 */
export async function POST(request: NextRequest) {
  const payload = (await request.json()) as { trackId?: string };

  if (!payload.trackId) {
    return NextResponse.json(
      { ok: false, message: "缺少 trackId" },
      { status: 400 },
    );
  }

  const program = await selectTrackProgram(payload.trackId);
  const schedule = await ensureDailySchedule();
  return NextResponse.json({ ok: true, program, schedule });
}
