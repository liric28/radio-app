import { promises as fs } from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";

const FAVORITES_FILE = path.join(process.cwd(), "data", "favorites.json");

export async function GET() {
  try {
    const raw = await fs.readFile(FAVORITES_FILE, "utf8");
    const ids: string[] = JSON.parse(raw);
    return NextResponse.json(ids);
  } catch {
    return NextResponse.json([]);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { trackId, action } = await req.json() as { trackId: string; action: "add" | "remove" };

    let ids: string[] = [];
    try {
      const raw = await fs.readFile(FAVORITES_FILE, "utf8");
      ids = JSON.parse(raw);
    } catch {
      ids = [];
    }

    if (action === "add") {
      if (!ids.includes(trackId)) ids.push(trackId);
    } else {
      ids = ids.filter((id) => id !== trackId);
    }

    await fs.mkdir(path.dirname(FAVORITES_FILE), { recursive: true });
    await fs.writeFile(FAVORITES_FILE, JSON.stringify(ids, null, 2));
    return NextResponse.json({ ok: true, ids });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}