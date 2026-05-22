import { NextResponse } from "next/server";
import { ensureDailySchedule } from "@/lib/daily-schedule";
import { advanceProgramRandomly } from "@/lib/radio-engine";

/**
 * 连续播放结束后请求下一首，默认走随机播放策略。
 */
export async function POST() {
  const program = await advanceProgramRandomly();
  const schedule = await ensureDailySchedule();
  return NextResponse.json({ ok: true, program, schedule });
}
