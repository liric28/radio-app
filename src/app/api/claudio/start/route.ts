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

  const state = getClaudioStationState();
  const key = `program_start:${Date.now()}`;
  const accepted = enqueueClaudioJob({
    type: "program_start",
    key,
    input: body.input?.trim() || "Open the station.",
    source: body.source?.trim() || "user",
    djLanguage: body.djLanguage === "zh" ? "zh" : "en",
  });

  void drainClaudioJobs();

  return NextResponse.json({
    ok: true,
    accepted,
    key,
    programId: state.programId,
  });
}
