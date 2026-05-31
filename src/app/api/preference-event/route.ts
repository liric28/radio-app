import { NextRequest, NextResponse } from "next/server";
import { appendPreferenceEvent } from "@/lib/preference-learning";

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json();
    await appendPreferenceEvent(payload);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
