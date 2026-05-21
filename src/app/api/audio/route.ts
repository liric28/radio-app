import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

const allowedRoots = ["/Users/lipan/Music/Music/Media/Music"];

const mimeTypes: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".aiff": "audio/aiff",
  ".alac": "audio/mp4",
};

/**
 * 将本地音乐文件以浏览器可访问的音频响应暴露给前端播放器。
 */
export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get("path");

  if (!filePath) {
    return NextResponse.json({ ok: false, message: "缺少音频路径" }, { status: 400 });
  }

  const normalizedPath = path.resolve(filePath);
  const isAllowed = allowedRoots.some((root) => normalizedPath.startsWith(root));

  if (!isAllowed) {
    return NextResponse.json({ ok: false, message: "音频路径不在允许范围内" }, { status: 403 });
  }

  try {
    const buffer = await fs.readFile(normalizedPath);
    const ext = path.extname(normalizedPath).toLowerCase();

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": mimeTypes[ext] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return NextResponse.json({ ok: false, message: "音频文件读取失败" }, { status: 404 });
  }
}
