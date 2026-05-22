import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { readAllowedAudioRoots } from "@/lib/audio-roots";

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
 * 大文件使用流式响应，避免 Next.js 超时。
 */
export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get("path");

  if (!filePath) {
    return NextResponse.json({ ok: false, message: "缺少音频路径" }, { status: 400 });
  }

  const normalizedPath = path.resolve(filePath);
  const allowedRoots = await readAllowedAudioRoots();
  const isAllowed = allowedRoots.some((root) => normalizedPath.startsWith(root));

  if (!isAllowed) {
    return NextResponse.json({ ok: false, message: "音频路径不在允许范围内" }, { status: 403 });
  }

  try {
    const ext = path.extname(normalizedPath).toLowerCase();
    const stat = await fs.stat(normalizedPath);

    const stream = new ReadableStream({
      async start(controller) {
        const handle = await fs.open(normalizedPath, "r");
        try {
          const buffer = Buffer.alloc(64 * 1024);
          let bytesRead: number;
          while ((bytesRead = (await handle.read(buffer)).bytesRead) > 0) {
            controller.enqueue(buffer.subarray(0, bytesRead));
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        } finally {
          await handle.close();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": mimeTypes[ext] ?? "application/octet-stream",
        "Content-Length": String(stat.size),
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return NextResponse.json({ ok: false, message: "音频文件读取失败" }, { status: 404 });
  }
}
