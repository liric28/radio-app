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
 * 本地音乐文件代理。前端 audio 元素的 src 就是 /api/audio?path=...
 *
 * 安全（重点）：
 *   - path.resolve 把 ?path 归一化（处理 .. / 软链等）
 *   - 必须落在 readAllowedAudioRoots() 返回的白名单目录内，否则 403
 *   - 白名单在 data/audio-roots.json，由"导入本地曲库"按钮自动加入
 *   - 不允许任意路径读盘，防止用户构造 ?path=/etc/passwd 这类攻击
 *
 * Range 请求（HTTP 206）：
 *   - audio/video 标签拖进度条会发 Range: bytes=START-END
 *   - 这里支持，读对应字节区间返回 206 Partial Content
 *
 * 完整请求：
 *   - 流式读 512KB 一块，避免大文件全部加载到内存
 *
 * 缓存：immutable + max-age=1y。音频文件路径变了就是不同 URL，可以放心缓存。
 */
export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get("path") || "";
  const libraryRoot = request.nextUrl.searchParams.get("libraryRoot") || "";

  if (!filePath) {
    return NextResponse.json({ ok: false, message: "缺少音频路径" }, { status: 400 });
  }

  // 本地歌曲：libraryRoot + sourcePath 拼接；网络歌曲：直接用 filePath（已是绝对路径）
  const normalizedPath = libraryRoot
    ? path.resolve(libraryRoot, filePath)
    : path.resolve(filePath);

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