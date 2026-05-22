import { NextResponse } from "next/server";
import { readWeatherSnapshot } from "@/lib/weather";

export async function GET() {
  try {
    const weather = await readWeatherSnapshot();
    return NextResponse.json({ ok: true, weather });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : "天气读取失败",
      },
      { status: 500 },
    );
  }
}
