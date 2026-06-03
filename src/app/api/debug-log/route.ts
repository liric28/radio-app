import { NextRequest, NextResponse } from "next/server";

type DebugLogBody = {
  scope?: string;
  level?: "info" | "error" | "warn";
  message?: string;
  payload?: unknown;
};

export async function POST(request: NextRequest) {
  let body: DebugLogBody;
  try {
    body = (await request.json()) as DebugLogBody;
  } catch {
    return NextResponse.json({ ok: false, message: "invalid JSON" }, { status: 400 });
  }

  const scope = body.scope || "client";
  const level = body.level || "info";
  const message = body.message || "unknown";
  const payload = body.payload ?? null;
  const logLine = `[debug-log] [${scope}] ${message}`;

  if (level === "error") {
    console.error(logLine, payload);
  } else if (level === "warn") {
    console.warn(logLine, payload);
  } else {
    console.info(logLine, payload);
  }

  return NextResponse.json({ ok: true });
}
