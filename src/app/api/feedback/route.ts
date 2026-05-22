import { NextRequest, NextResponse } from "next/server";
import { ensureDailySchedule } from "@/lib/daily-schedule";
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

  const [program, schedule] = await Promise.all([
    applyFeedbackAndBuildProgram(payload.action),
    ensureDailySchedule(),
  ]);
  return NextResponse.json({ ok: true, program, schedule });
}
