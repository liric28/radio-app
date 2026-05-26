import { NextRequest, NextResponse } from "next/server";
import { drainClaudioJobs } from "@/lib/claudio/jobs";
import {
  enqueueClaudioJob,
  getClaudioStationState,
} from "@/lib/claudio/station-runtime";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    count?: number;
    djLanguage?: "en" | "zh";
  };
  const state = getClaudioStationState();

  if (!state.programId) {
    return NextResponse.json({ ok: false, message: "Claudio station not started" }, { status: 409 });
  }

  const key = `music_refill:${state.programId}:${Date.now()}`;
  const accepted = enqueueClaudioJob({
    type: "music_refill",
    key,
    programId: state.programId,
    sessionTitle: state.sessionTitle,
    queue: state.tracks,
    queueLength: state.tracks.length,
    count: Math.max(1, Math.min(4, Number(body.count) || 3)),
    djLanguage: body.djLanguage === "zh" ? "zh" : "en",
  });

  void drainClaudioJobs();

  return NextResponse.json({ ok: true, accepted, key, programId: state.programId });
}
