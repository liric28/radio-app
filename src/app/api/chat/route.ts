import { NextRequest, NextResponse } from "next/server";
import { completeChatJob, createChatJob, failChatJob } from "@/lib/chat-jobs";
import { ensureDailySchedule } from "@/lib/daily-schedule";
import { readMemory } from "@/lib/memory";
import { buildRuleBasedDjReply, composeDjReply } from "@/lib/providers/llm";
import { applyChatIntentWithProgram, resolveChatIntent } from "@/lib/radio-engine";
import type { ChatIntent, ChatMessage, RadioProgram } from "@/lib/types";

type ChatRequest = {
  message?: string;
  program?: RadioProgram;
  history?: ChatMessage[];
};

/**
 * 接收用户对 DJ 的文本消息，并结合当前节目上下文生成回复。
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

  const intent: ChatIntent = resolveChatIntent(message, payload.program);
  const controlledProgram =
    (await applyChatIntentWithProgram(intent, payload.program)) ?? payload.program;
  const memory = await readMemory();
  const previewReply = buildRuleBasedDjReply({
    message,
    program: controlledProgram,
    memory,
    intent,
    history: payload.history,
  });
  const job = await createChatJob();

  void composeDjReply({
    message,
    program: controlledProgram,
    memory,
    intent,
    history: payload.history,
  })
    .then((reply) => completeChatJob(job.id, reply))
    .catch((error) =>
      failChatJob(job.id, error instanceof Error ? error.message : "DJ 生成失败"),
    );

  return NextResponse.json({
    ok: true,
    intent,
    program: controlledProgram,
    schedule: await ensureDailySchedule(),
    pending: true,
    jobId: job.id,
    reply: {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      content: previewReply,
    } satisfies ChatMessage,
  });
}
