import { NextRequest, NextResponse } from "next/server";
import { ensureDailySchedule } from "@/lib/daily-schedule";
import { applyOnlineFeedbackAndBuildProgram } from "@/lib/online-radio";
import { isOnlineRadioMode } from "@/lib/radio-mode";
import { applyFeedbackAndBuildProgram } from "@/lib/radio-engine";

/**
 * 写入一次用户反馈，并立即返回更新后的节目结果。
 */
export async function POST(request: NextRequest) {
  const payload = (await request.json()) as { action?: string };

  if (!payload.action) {
    return NextResponse.json(
      { ok: false, message: "缺少反馈动作" },
      { status: 400 },
    );
  }

  if (isOnlineRadioMode()) {
    const { program, schedule } = await applyOnlineFeedbackAndBuildProgram(
      payload.action as "skip" | "fresh" | "calmer" | "familiar",
    );
    return NextResponse.json({ ok: true, program, schedule });
  }

  const [program, schedule] = await Promise.all([
    applyFeedbackAndBuildProgram(payload.action),
    ensureDailySchedule(),
  ]);
  return NextResponse.json({ ok: true, program, schedule });
}
