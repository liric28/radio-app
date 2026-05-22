import { NextRequest, NextResponse } from "next/server";
import { getChatJob } from "@/lib/chat-jobs";

/**
 * 轮询 DJ 最终回复的后台任务状态。
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  const job = await getChatJob(jobId);

  if (!job) {
    return NextResponse.json({ ok: false, message: "聊天任务不存在" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, job });
}
