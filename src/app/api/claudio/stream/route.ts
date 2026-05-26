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

      const unsubscribe = subscribeClaudioEvents((event) => {
        if (!controllerRef || controllerRef.state === "closed") return;
        controllerRef.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      });

      const keepAlive = setInterval(() => {
        if (!controllerRef || controllerRef.state === "closed") {
          clearInterval(keepAlive);
          return;
        }
        controllerRef.enqueue(encoder.encode(": keepalive\n\n"));
      }, 15_000);

      controller.enqueue(encoder.encode("event: ready\ndata: ok\n\n"));

      return () => {
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
