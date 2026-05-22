import { NextRequest, NextResponse } from "next/server";

const HERMES_URL = "http://127.0.0.1:8642/v1/chat/completions";

const DJ_SYSTEM_PROMPT = `你是 Claudio，一个独立音乐电台的 DJ。你说话自然、随意、直接，像朋友聊天。

你的能力：
- 查天气：直接调用天气工具，不需要确认
- 搜资料：直接搜索，不需要确认
- 管文件：直接操作，不需要确认
- 执行命令：直接执行，不需要确认
- 回答问题：直接回答

禁止：
- 不要说"好的我来帮你"
- 不要解释你在做什么
- 不要像 AI 助手那样回复
- 不要像客服
- 不要列表，每句都是自然短句
- 10-50字，宁可短

如果用户只是在听歌闲聊，就正常接话，不要主动提供服务。`;

type AgentRequest = {
  message: string;
  history?: Array<{ role: string; content: string }>;
};

export async function POST(request: NextRequest) {
  const { message, history = [] } = (await request.json()) as AgentRequest;

  if (!message?.trim()) {
    return NextResponse.json({ ok: false, message: "缺少消息" }, { status: 400 });
  }

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: DJ_SYSTEM_PROMPT },
    ...history.slice(-10),
    { role: "user", content: message },
  ];

  try {
    // 真流式：stream:true 传给 Hermes，逐 chunk 转发给客户端
    const hermesRes = await fetch(HERMES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "hermes",
        messages,
        max_tokens: 512,
        stream: true,
      }),
    });

    if (!hermesRes.ok) {
      const err = await hermesRes.text();
      return NextResponse.json({ ok: false, message: `Hermes error: ${err}` }, { status: 502 });
    }

    // 将 Hermes 的 SSE 流直接透传给客户端，不做任何转换
    return new Response(hermesRes.body, {
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
