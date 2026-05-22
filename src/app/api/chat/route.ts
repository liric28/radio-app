import { NextRequest, NextResponse } from "next/server";
import { completeChatJob, createChatJob, failChatJob } from "@/lib/chat-jobs";
import { runChatAgent } from "@/lib/chat-agent";
import type { ChatMessage, RadioProgram } from "@/lib/types";

type ChatRequest = {
  message?: string;
  program?: RadioProgram;
  history?: ChatMessage[];
};

/**
 * 接收页内聊天消息，统一交给 chat agent 决策并返回最新页面状态。
 */
export async function POST(request: NextRequest) {
  const payload = (await request.json()) as ChatRequest;
  const message = payload.message?.trim();

  if (!message) {
    return NextResponse.json(
      { ok: false, message: "缺少用户消息" },
      { status: 400 },
    );
  }

  if (!payload.program) {
    return NextResponse.json(
      { ok: false, message: "缺少当前节目上下文" },
      { status: 400 },
    );
  }

  const agentResult = await runChatAgent({
    message,
    program: payload.program,
    history: payload.history,
  });
  const job = await createChatJob();

  void agentResult
    .finalizeReply()
    .then((reply) => completeChatJob(job.id, reply))
    .catch((error) =>
      failChatJob(job.id, error instanceof Error ? error.message : "DJ 生成失败"),
    );

  return NextResponse.json({
    ok: true,
    intent: agentResult.state.intent,
    mode: agentResult.state.mode,
    tool: agentResult.state.tool,
    program: agentResult.program,
    schedule: agentResult.schedule,
    weather: agentResult.state.weather ?? null,
    pending: true,
    jobId: job.id,
    reply: {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      content: agentResult.previewReply,
    } satisfies ChatMessage,
  });
}
