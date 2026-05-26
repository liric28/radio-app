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

      const unsubscribe = subscribeClaudioEvents((event) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      });

      const keepAlive = setInterval(() => {
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 15_000);

      controller.enqueue(encoder.encode("event: ready\ndata: ok\n\n"));

      return () => {
        clearInterval(keepAlive);
        unsubscribe();
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
