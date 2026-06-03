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

const LLM_STREAM_TIMEOUT_MS = 45_000;

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-agent-request-id") ?? `agent-${Date.now()}`;
  const { message, program, history = [] } = (await request.json()) as AgentRequest;

  if (!message?.trim()) {
    return NextResponse.json({ ok: false, message: "缺少消息" }, { status: 400 });
  }

  if (!program) {
    return NextResponse.json({ ok: false, message: "缺少当前节目上下文" }, { status: 400 });
  }

  try {
    console.info("[agent] request.start", {
      requestId,
      message,
      historyLength: history.length,
      currentTrackId: program.currentTrack.id,
      currentTrackTitle: program.currentTrack.title,
      currentTrackArtist: program.currentTrack.artist,
    });
    const agentResult = await runChatAgent({
      message,
      program,
      history,
    });
    console.info("[agent] request.resolved", {
      requestId,
      mode: agentResult.state.mode,
      tool: agentResult.state.tool,
      intent: agentResult.state.intent.action,
      hasDirectReply: Boolean(agentResult.directReply),
      candidateCount: agentResult.assistantMeta?.pendingCandidates?.length ?? 0,
      nextTrackId: agentResult.program.currentTrack.id,
    });

    if (agentResult.directReply) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          console.info("[agent] direct.sse.start", {
            requestId,
            candidateCount: agentResult.assistantMeta?.pendingCandidates?.length ?? 0,
          });
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "state",
                mode: agentResult.state.mode,
                tool: agentResult.state.tool,
                intent: agentResult.state.intent,
                program: agentResult.program,
                schedule: agentResult.schedule,
                favorites: agentResult.favorites,
                weather: agentResult.state.weather ?? null,
              })}\n\n`,
            ),
          );
          // 新增：控件指令帧（暂停 / 继续 / 音量 / 重播）。
          // 前端 player-shell.tsx 解析时调 audioRef.current。
          // 跟 assistant 帧独立，互不影响。
          if (agentResult.controlAction) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "control",
                  action: agentResult.controlAction,
                  value: agentResult.controlValue ?? null,
                })}\n\n`,
              ),
            );
          }
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "assistant",
                choices: [{ delta: { content: agentResult.directReply } }],
                // 新增：点播候选提问的候选列表。前端 chatHistory 的 assistant 消息
                // 写进这条 meta，下一轮 user 选歌时透传回后端匹配。
                // 原链路不会写 assistantMeta 字段，这条帧也不带 meta。
                meta: agentResult.assistantMeta ?? null,
              })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          console.info("[agent] direct.sse.done", { requestId });
          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      });
    }

    const llmRequest = buildChatLlmRequest(agentResult.llmMessages);
    const llmController = new AbortController();
    const llmTimeoutId = setTimeout(() => llmController.abort(), LLM_STREAM_TIMEOUT_MS);
    let llmRes: Response;
    try {
      console.info("[agent] llm.fetch.start", {
        requestId,
        provider: llmRequest.provider,
        timeoutMs: LLM_STREAM_TIMEOUT_MS,
      });
      llmRes = await fetch(llmRequest.url, {
        method: "POST",
        headers: llmRequest.headers,
        body: JSON.stringify(llmRequest.body),
        signal: llmController.signal,
      });
      console.info("[agent] llm.fetch.ok", {
        requestId,
        provider: llmRequest.provider,
        status: llmRes.status,
      });
    } catch (error) {
      clearTimeout(llmTimeoutId);
      if (error instanceof DOMException && error.name === "AbortError") {
        console.error("[agent] llm.fetch.timeout", {
          requestId,
          provider: llmRequest.provider,
          timeoutMs: LLM_STREAM_TIMEOUT_MS,
        });
        return NextResponse.json(
          { ok: false, message: `${llmRequest.provider} 响应超时` },
          { status: 504 },
        );
      }
      console.error("[agent] llm.fetch.error", {
        requestId,
        provider: llmRequest.provider,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    if (!llmRes.ok) {
      clearTimeout(llmTimeoutId);
      const err = await llmRes.text();
      console.error("[agent] llm.fetch.bad-status", {
        requestId,
        provider: llmRequest.provider,
        status: llmRes.status,
        error: err,
      });
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
        console.info("[agent] llm.sse.start", { requestId, provider: llmRequest.provider });
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "state",
              mode: agentResult.state.mode,
              tool: agentResult.state.tool,
              intent: agentResult.state.intent,
              program: agentResult.program,
              schedule: agentResult.schedule,
              favorites: agentResult.favorites,
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
          console.info("[agent] llm.sse.done", { requestId, provider: llmRequest.provider });
        } catch (error) {
          console.error("[agent] llm.sse.error", {
            requestId,
            provider: llmRequest.provider,
            error: error instanceof Error ? error.message : String(error),
          });
          controller.error(error);
        } finally {
          clearTimeout(llmTimeoutId);
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
    console.error("[agent] request.error", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, message: err instanceof Error ? err.message : "未知错误" },
      { status: 500 },
    );
  }
}
