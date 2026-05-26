import { NextRequest, NextResponse } from "next/server";
import { broadcastClaudioEvent } from "@/lib/claudio/station-runtime";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: "next" | "pause" | "resume" | "volume";
    delta?: number;
  };

  if (!body.action) {
    return NextResponse.json({ ok: false, message: "missing action" }, { status: 400 });
  }

  broadcastClaudioEvent({
    type: "control",
    action: body.action,
    delta: typeof body.delta === "number" ? body.delta : undefined,
  });

  return NextResponse.json({ ok: true });
}
