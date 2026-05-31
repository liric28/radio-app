import { promises as fs } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import {
  ensureScriptVMLoaded,
  resetScriptVMLoadCache,
  scriptVM,
  SCRIPT_DIR,
  SCRIPT_FILE,
  SCRIPT_META_FILE,
} from "@/lib/script-vm";

export const dynamic = "force-dynamic";

// GET: 返回当前脚本状态和可用源列表，或获取 lyric/pic
export async function GET(request: NextRequest) {
  await ensureScriptVMLoaded();
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action") ?? "status";

  switch (action) {
    case "musicUrl": {
      if (!scriptVM.isLoaded) {
        return NextResponse.json({ success: false, error: "no script loaded" }, { status: 400 });
      }
      const source = searchParams.get("source");
      const hash = searchParams.get("hash") ?? undefined;
      const songmid = searchParams.get("songmid") ?? undefined;
      const songId = searchParams.get("songId") ?? undefined;
      const name = searchParams.get("name") ?? undefined;
      const singer = searchParams.get("singer") ?? undefined;
      const album = searchParams.get("album") ?? undefined;
      const type = searchParams.get("type") ?? "128k";
      if (!source) return NextResponse.json({ success: false, error: "source required" }, { status: 400 });
      const musicInfo = { hash, songmid, songId, name, singer, album };
      const result = await scriptVM.resolve({ source, action: "musicUrl", info: { type, musicInfo } });
      if (!result) return NextResponse.json({ success: false, error: "url not found" }, { status: 404 });
      return NextResponse.json({ success: true, url: result });
    }
    case "source_list": {
      if (!scriptVM.isLoaded) {
        return NextResponse.json({ success: true, loaded: false, sources: [] });
      }
      return NextResponse.json({
        success: true,
        loaded: true,
        meta: scriptVM.scriptMeta,
        sources: scriptVM.supportedSources,
      });
    }
    case "lyric": {
      if (!scriptVM.isLoaded) {
        return NextResponse.json({ success: false, error: "no script loaded" }, { status: 400 });
      }
      const source = searchParams.get("source");
      const hash = searchParams.get("hash") ?? undefined;
      const songmid = searchParams.get("songmid") ?? undefined;
      const songId = searchParams.get("songId") ?? undefined;
      const name = searchParams.get("name") ?? undefined;
      const singer = searchParams.get("singer") ?? undefined;
      const album = searchParams.get("album") ?? undefined;
      const type = searchParams.get("type") ?? "320k";
      if (!source) return NextResponse.json({ success: false, error: "source required" }, { status: 400 });
      const musicInfo = { hash, songmid, songId, name, singer, album };
      const result = await scriptVM.resolve({ source, action: "lyric", info: { type, musicInfo } });
      if (!result) return NextResponse.json({ success: false, error: "lyric not found" }, { status: 404 });
      return NextResponse.json({ success: true, ...JSON.parse(result) });
    }
    case "pic": {
      if (!scriptVM.isLoaded) {
        return NextResponse.json({ success: false, error: "no script loaded" }, { status: 400 });
      }
      const source = searchParams.get("source");
      const hash = searchParams.get("hash") ?? undefined;
      const songmid = searchParams.get("songmid") ?? undefined;
      const songId = searchParams.get("songId") ?? undefined;
      const album = searchParams.get("album") ?? undefined;
      const name = searchParams.get("name") ?? undefined;
      const singer = searchParams.get("singer") ?? undefined;
      if (!source) return NextResponse.json({ success: false, error: "source required" }, { status: 400 });
      const musicInfo = { hash, songmid, songId, album, name, singer };
      const result = await scriptVM.resolve({ source, action: "pic", info: { musicInfo } });
      if (!result) return NextResponse.json({ success: false, error: "pic not found" }, { status: 404 });
      return NextResponse.json({ success: true, url: result });
    }
    case "status":
    default: {
      return NextResponse.json({
        success: true,
        loaded: scriptVM.isLoaded,
        meta: scriptVM.scriptMeta ?? null,
      });
    }
  }
}

// POST: script_load / script_unload
export async function POST(request: NextRequest) {
  await ensureScriptVMLoaded();

  let body: { action: string; code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "invalid JSON" }, { status: 400 });
  }

  switch (body.action) {
    case "script_load": {
      if (!body.code || typeof body.code !== "string") {
        return NextResponse.json({ success: false, error: "code is required" }, { status: 400 });
      }
      try {
        await scriptVM.load(body.code);
      } catch (err) {
        return NextResponse.json(
          { success: false, error: `脚本加载失败：${(err as Error).message}` },
          { status: 400 },
        );
      }

      // 持久化到磁盘
      await fs.mkdir(SCRIPT_DIR, { recursive: true });
      await Promise.all([
        fs.writeFile(SCRIPT_FILE, body.code, "utf8"),
        fs.writeFile(SCRIPT_META_FILE, JSON.stringify(scriptVM.scriptMeta, null, 2), "utf8"),
      ]);
      resetScriptVMLoadCache();

      return NextResponse.json({
        success: true,
        meta: scriptVM.scriptMeta,
        sources: scriptVM.supportedSources,
      });
    }

    case "script_unload": {
      scriptVM.unload();
      resetScriptVMLoadCache();
      await fs.rm(SCRIPT_META_FILE, { force: true });
      return NextResponse.json({ success: true });
    }

    default:
      return NextResponse.json({ success: false, error: `unknown action: ${body.action}` }, { status: 400 });
  }
}
