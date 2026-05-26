import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

const TTS_CACHE_DIR = path.join(process.cwd(), "cache", "tts");

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ filename: string }> },
) {
  const { filename } = await context.params;
  const safeName = path.basename(filename);
  const filePath = path.join(TTS_CACHE_DIR, safeName);

  try {
    const bytes = await fs.readFile(filePath);
    return new Response(bytes, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ ok: false, message: "TTS file not found" }, { status: 404 });
  }
}
