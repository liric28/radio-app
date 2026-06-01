import { NextResponse } from "next/server";
import { readPreferenceInsights } from "@/lib/preference-learning";

export async function GET() {
  try {
    const data = await readPreferenceInsights();
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
