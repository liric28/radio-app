import { NextRequest, NextResponse } from "next/server";
import { runChatAgent } from "@/lib/chat-agent";
import type { ChatMessage, RadioProgram } from "@/lib/types";

const HERMES_URL = "http://127.0.0.1:8642/v1/chat/completions";

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

    const hermesRes = await fetch(HERMES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "hermes",
        messages: agentResult.hermesMessages,
        max_tokens: 512,
        stream: true,
      }),
    });

    if (!hermesRes.ok) {
      const err = await hermesRes.text();
      return NextResponse.json({ ok: false, message: `Hermes error: ${err}` }, { status: 502 });
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const sourceReader = hermesRes.body?.getReader();

    if (!sourceReader) {
      return NextResponse.json({ ok: false, message: "Hermes 返回了空响应" }, { status: 502 });
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
