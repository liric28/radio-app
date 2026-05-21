import { NextRequest, NextResponse } from "next/server";
import { parseSongImportText } from "@/lib/importer";
import {
  normalizeImportedSongs,
  readSongCatalog,
  writeSongCatalog,
} from "@/lib/profile";
import { buildRadioProgram } from "@/lib/radio-engine";

/**
 * 接收用户粘贴的 JSON 或 CSV，并将其写入本地曲库。
 */
export async function POST(request: NextRequest) {
  const payload = (await request.json()) as {
    sourceText?: string;
    mode?: "replace" | "append";
  };

  if (!payload.sourceText) {
    return NextResponse.json(
      { ok: false, message: "缺少导入内容" },
      { status: 400 },
    );
  }

  try {
    const parsed = parseSongImportText(payload.sourceText);
    const normalized = normalizeImportedSongs(parsed);

    if (normalized.length === 0) {
      return NextResponse.json(
        { ok: false, message: "没有识别到可导入的歌曲" },
        { status: 400 },
      );
    }

    const existingSongs = await readSongCatalog();
    const nextSongs =
      payload.mode === "append" ? [...existingSongs, ...normalized] : normalized;

    await writeSongCatalog(nextSongs);

    const program = await buildRadioProgram();
    return NextResponse.json({
      ok: true,
      importedCount: normalized.length,
      totalCount: nextSongs.length,
      program,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : "导入失败",
      },
      { status: 400 },
    );
  }
}
