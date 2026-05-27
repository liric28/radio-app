import {
  getClaudioStationState,
  subscribeClaudioEvents,
} from "@/lib/claudio/station-runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  const encoder = new TextEncoder();
  const state = getClaudioStationState();

  const stream = new ReadableStream({
    start(controller) {
      // 这里不用 controller.state，改用本地 closed 标记追踪生命周期，
      // 兼容 TS DOM 类型，也能避免关闭后继续 enqueue。
      let closed = false;

      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            type: "snapshot",
            programId: state.programId,
            sessionTitle: state.sessionTitle,
            tracks: state.tracks,
            segments: state.segments,
            history: state.history.slice(-20),
          })}\n\n`,
        ),
      );

      let controllerRef: ReadableStreamDefaultController | null = controller;
      const safeEnqueue = (payload: string) => {
        if (closed || !controllerRef) return;
        try {
          controllerRef.enqueue(encoder.encode(payload));
        } catch {
          // 客户端断开和 controller.close() 之间有竞态；这里静默吞掉，
          // 不能因为一个过期 SSE 连接影响后续 broadcast / start job。
          closed = true;
          controllerRef = null;
        }
      };

      const unsubscribe = subscribeClaudioEvents((event) => {
        safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
      });

      // 某些代理会在长时间无数据时断 SSE，这里固定打 keepalive 保活连接。
      const keepAlive = setInterval(() => {
        if (closed || !controllerRef) {
          clearInterval(keepAlive);
          return;
        }
        safeEnqueue(": keepalive\n\n");
      }, 15_000);

      safeEnqueue("event: ready\ndata: ok\n\n");

      return () => {
        closed = true;
        clearInterval(keepAlive);
        unsubscribe();
        controllerRef = null;
      };
    },
    cancel() {
      // cleanup 由 start 返回的回调承担
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
