import { NextResponse } from "next/server";
import { ensureDailySchedule } from "@/lib/daily-schedule";
import { buildRadioProgram } from "@/lib/radio-engine";

/**
 * 获取当前节目流，供首页和后续播放器刷新使用。
 */
export async function GET() {
  const [program, schedule] = await Promise.all([
    buildRadioProgram(),
    ensureDailySchedule(),
  ]);
  return NextResponse.json({ ok: true, program, schedule });
}
