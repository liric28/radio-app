import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".wav", ".flac", ".aiff", ".alac", ".ogg", ".opus"]);

function inferAudioContentType(remoteUrl: string, responseType: string | null) {
  if (responseType?.toLowerCase().startsWith("audio/")) return responseType;
  try {
    const extension = path.extname(new URL(remoteUrl).pathname).toLowerCase();
    if (extension === ".mp3") return "audio/mpeg";
    if (extension === ".m4a" || extension === ".alac") return "audio/mp4";
    if (extension === ".aac") return "audio/aac";
    if (extension === ".wav") return "audio/wav";
    if (extension === ".flac") return "audio/flac";
    if (extension === ".aiff") return "audio/aiff";
    if (extension === ".ogg") return "audio/ogg";
    if (extension === ".opus") return "audio/ogg";
  } catch {}
  return null;
}

function looksLikeAudio(remoteUrl: string, responseType: string | null) {
  if (responseType?.toLowerCase().startsWith("audio/")) return true;
  try {
    return AUDIO_EXTENSIONS.has(path.extname(new URL(remoteUrl).pathname).toLowerCase());
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const remoteUrl = request.nextUrl.searchParams.get("url") || "";
  if (!remoteUrl) {
    return NextResponse.json({ ok: false, message: "缺少远端音频地址" }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return NextResponse.json({ ok: false, message: "远端音频地址非法" }, { status: 400 });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return NextResponse.json({ ok: false, message: "只支持 http/https 远端音频" }, { status: 400 });
  }

  const range = request.headers.get("range");
  const upstream = await fetch(parsed.toString(), {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 ClaudioFM/1.0",
      ...(range ? { Range: range } : {}),
    },
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);

  if (!upstream || (!upstream.ok && upstream.status !== 206)) {
    return NextResponse.json({ ok: false, message: "远端音频拉取失败" }, { status: 502 });
  }

  const upstreamType = upstream.headers.get("content-type");
  if (!looksLikeAudio(parsed.toString(), upstreamType)) {
    return NextResponse.json({ ok: false, message: "远端返回的不是音频内容" }, { status: 415 });
  }

  const contentType = inferAudioContentType(parsed.toString(), upstreamType) || "audio/mpeg";
  const headers = new Headers({
    "Content-Type": contentType,
    "Accept-Ranges": upstream.headers.get("accept-ranges") || "bytes",
    "Cache-Control": "no-store",
  });
  const contentLength = upstream.headers.get("content-length");
  const contentRange = upstream.headers.get("content-range");
  if (contentLength) headers.set("Content-Length", contentLength);
  if (contentRange) headers.set("Content-Range", contentRange);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
