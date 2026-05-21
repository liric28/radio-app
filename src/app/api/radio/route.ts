import { NextResponse } from "next/server";
import { buildRadioProgram } from "@/lib/radio-engine";

/**
 * 获取当前节目流，供首页和后续播放器刷新使用。
 */
export async function GET() {
  const program = await buildRadioProgram();
  return NextResponse.json({ ok: true, program });
}
