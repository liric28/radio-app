import { NextResponse } from "next/server";
import { regenerateDailySchedule } from "@/lib/daily-schedule";
import { regenerateOnlineRadioProgram } from "@/lib/online-radio";
import { isOnlineRadioMode } from "@/lib/radio-mode";
import { buildRadioProgram } from "@/lib/radio-engine";

/**
 * 一天歌单的"快速重生成"入口（输入框旁边的 ⌁ 按钮调用）。
 *
 * 流程：
 *   1. regenerateDailySchedule() 重新洗牌 4 段歌单并落盘 data/daily-schedule.json
 *      ↳ 不调 LLM，每首歌的 reason 先用 reasonSeed 占位（快）
 *      ↳ 每段歌曲数由 recommendBlockTrackCount() 给随机区间，所以总数会变
 *   2. buildRadioProgram() 从刚写好的 schedule 取当前段第一首作为 currentTrack
 *   3. 返回 { ok, program, schedule } 给客户端
 *
 * 客户端拿到后 setProgram + setSchedule 立刻刷 UI（< 2s）。
 * 当前段的 DJ 风格推荐语由 player-shell.tsx 里的 rewrite-reasons useEffect
 * 在 currentTrack.id 变化后后台异步润色，不阻塞这个接口。
 */
export async function POST() {
  try {
    if (isOnlineRadioMode()) {
      const { program, schedule } = await regenerateOnlineRadioProgram();
      return NextResponse.json({ ok: true, program, schedule });
    }

    const schedule = await regenerateDailySchedule();
    const program = await buildRadioProgram();
    return NextResponse.json({ ok: true, program, schedule });
  } catch (err) {
    console.error("[regenerate-schedule]", err);
    return NextResponse.json(
      { ok: false, error: "Failed to regenerate schedule" },
      { status: 500 }
    );
  }
}
