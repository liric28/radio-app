import { NextResponse } from "next/server";
import { ensureDailySchedule } from "@/lib/daily-schedule";
import { ensureOnlineRadioProgram } from "@/lib/online-radio";
import { isOnlineRadioMode } from "@/lib/radio-mode";
import { buildRadioProgram } from "@/lib/radio-engine";

/**
 * 获取当前节目流，供首页和后续播放器刷新使用。
 */
export async function GET() {
  if (isOnlineRadioMode()) {
    const { program, schedule } = await ensureOnlineRadioProgram();
    return NextResponse.json({ ok: true, program, schedule });
  }

  const [program, schedule] = await Promise.all([
    buildRadioProgram(),
    ensureDailySchedule(),
  ]);
  return NextResponse.json({ ok: true, program, schedule });
}
