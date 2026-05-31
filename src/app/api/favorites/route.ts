import { NextRequest, NextResponse } from "next/server";
import { readFavorites, updateFavorite } from "@/lib/favorites";

export async function GET() {
  try {
    return NextResponse.json(await readFavorites());
  } catch {
    return NextResponse.json([]);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { title, artist, action } = await req.json() as { title: string; artist: string; action: "add" | "remove" };
    const ids = await updateFavorite({ title, artist }, action);
    return NextResponse.json({ ok: true, ids });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
