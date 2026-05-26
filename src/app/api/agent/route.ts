/**
 * 聊天 SSE 代理。客户端 sendChatMessage 发的 POST 都到这里。
 *
 * 三步：
 *   1. runChatAgent：识别意图 → 执行工具（切歌 / 查天气）→ 装配模型 messages
 *      ↳ 这一步可能改 program / schedule（音乐控制类意图）
 *      ↳ 详见 src/lib/chat-agent.ts 头部说明
 *   2. 先吐一帧 SSE：type:"state" 含 program / schedule / weather / intent
 *      ↳ 让前端立刻 setProgram / setSchedule（自动续播链就在这里启动）
 *   3. 然后把模型的 stream 透传过来（每个 token 一帧），最后吐 [DONE]
 *
 * 透传 buffer 处理：
 *   - 模型的 SSE 帧可能跨 TCP chunk 切到一半
 *   - 用 buffer.split("\n\n") 切完整 event，余数留到下次循环
 *
 * Headers 关键点：
 *   - Content-Type: text/event-stream（不能改）
 *   - Cache-Control: no-cache + X-Accel-Buffering: no（关 nginx/CDN 缓冲）
 *
 * 错误：runChatAgent 异常 → 500 JSON；模型非 2xx → 502 JSON。
 */
import { NextRequest, NextResponse } from "next/server";
import { runChatAgent } from "@/lib/chat-agent";
import { buildChatLlmRequest } from "@/lib/providers/chat-llm";
import type { ChatMessage, RadioProgram } from "@/lib/types";

type AgentRequest = {
  message: string;
  program?: RadioProgram;
  history?: ChatMessage[];
};

export async function POST(request: NextRequest) {
  const { message, program, history = [] } = (await request.json()) as AgentRequest;

  if (!message?.trim()) {
    return NextResponse.json({ ok: false, message: "缺少消息" }, { status: 400 });
  }

  if (!program) {
    return NextResponse.json({ ok: false, message: "缺少当前节目上下文" }, { status: 400 });
  }

  try {
    const agentResult = await runChatAgent({
      message,
      program,
      history,
    });

    const llmRequest = buildChatLlmRequest(agentResult.llmMessages);
    const llmRes = await fetch(llmRequest.url, {
      method: "POST",
      headers: llmRequest.headers,
      body: JSON.stringify(llmRequest.body),
    });

    if (!llmRes.ok) {
      const err = await llmRes.text();
      return NextResponse.json(
        { ok: false, message: `${llmRequest.provider} error: ${err}` },
        { status: 502 },
      );
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const sourceReader = llmRes.body?.getReader();

    if (!sourceReader) {
      return NextResponse.json({ ok: false, message: "模型返回了空响应" }, { status: 502 });
    }

    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "state",
              mode: agentResult.state.mode,
              tool: agentResult.state.tool,
              intent: agentResult.state.intent,
              program: agentResult.program,
              schedule: agentResult.schedule,
              weather: agentResult.state.weather ?? null,
            })}\n\n`,
          ),
        );

        try {
          let buffer = "";

          while (true) {
            const { value, done } = await sourceReader.read();
            if (done) break;
            if (!value) continue;

            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() ?? "";

            for (const part of parts) {
              controller.enqueue(encoder.encode(`${part}\n\n`));
            }
          }

          const tail = buffer + decoder.decode();
          if (tail.trim()) {
            controller.enqueue(encoder.encode(tail.endsWith("\n\n") ? tail : `${tail}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (error) {
          controller.error(error);
        } finally {
          sourceReader.releaseLock();
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, message: err instanceof Error ? err.message : "未知错误" },
      { status: 500 },
    );
  }
}
