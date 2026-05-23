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
 * 大文件使用流式响应，支持 HTTP Range 请求（seek），并设置长期缓存。
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
    const fileSize = stat.size;

    const rangeHeader = request.headers.get("range");
    const contentType = mimeTypes[ext] ?? "application/octet-stream";

    // 支持 HTTP Range 请求（seek）
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : fileSize - 1;
        const chunkSize = end - start + 1;

        const handle = await fs.open(normalizedPath, "r");
        const buffer = Buffer.alloc(chunkSize);
        await handle.read(buffer, 0, chunkSize, start);
        await handle.close();

        return new Response(buffer, {
          status: 206,
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(chunkSize),
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      }
    }

    // 完整文件流
    const stream = new ReadableStream({
      async start(controller) {
        const handle = await fs.open(normalizedPath, "r");
        try {
                  const CHUNK_SIZE = 512 * 1024;
          const buffer = Buffer.alloc(CHUNK_SIZE);
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
        "Content-Type": contentType,
        "Content-Length": String(fileSize),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ ok: false, message: "音频文件读取失败" }, { status: 404 });
  }
}
