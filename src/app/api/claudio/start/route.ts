import { NextRequest, NextResponse } from "next/server";
import { drainClaudioJobs } from "@/lib/claudio/jobs";
import { enqueueClaudioJob, getClaudioStationState } from "@/lib/claudio/station-runtime";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    input?: string;
    source?: string;
    djLanguage?: "en" | "zh";
  };

  const key = `program_start:${Date.now()}`;
  const accepted = enqueueClaudioJob({
    type: "program_start",
    key,
    input: body.input?.trim() || "Open the station.",
    source: body.source?.trim() || "user",
    djLanguage: body.djLanguage === "zh" ? "zh" : "en",
  });

  const completed = await drainClaudioJobs({ stopAfterKey: key });
  const state = getClaudioStationState();
  const failed = state.history.find(
    (event) => event.type === "job-status" && event.key === key && event.status === "failed",
  );

  if (failed?.type === "job-status") {
    return NextResponse.json({
      ok: false,
      accepted,
      key,
      error: failed.error || "program_start failed",
    }, { status: 500 });
  }

  void drainClaudioJobs();

  return NextResponse.json({
    ok: completed,
    accepted,
    key,
    programId: state.programId,
  });
}
