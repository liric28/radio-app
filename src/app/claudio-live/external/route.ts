import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const CLAUDIO_LIVE_PAGE_PATH = "/Users/lipan/Downloads/Claudio-FM-main/pwa/index.html";

export async function GET() {
  try {
    const html = await fs.readFile(CLAUDIO_LIVE_PAGE_PATH, "utf8");
    return new NextResponse(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return new NextResponse(String((error as Error).message), {
      status: 500,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
}
