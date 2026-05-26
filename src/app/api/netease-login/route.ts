import { NextRequest, NextResponse } from "next/server";
import {
  checkQrLogin,
  createQrLogin,
  getLoginProfile,
  neteaseBaseUrl,
  redactSensitiveText,
  resolveCookie,
  verifyLoginStatus,
} from "@/lib/netease-session";

export const dynamic = "force-dynamic";

function renderQrPage({
  key,
  qrImg,
  qrUrl,
}: {
  key: string;
  qrImg: string;
  qrUrl: string;
}) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Netease Music Login</title>
</head>
<body style="font-family: system-ui, sans-serif; margin: 40px;">
  <h1>Netease Music Login</h1>
  <p>Scan this QR code with the Netease Cloud Music mobile app.</p>
  <img src="${qrImg}" alt="Netease Cloud Music login QR code" style="width: 260px; height: 260px;">
  ${qrUrl ? `<p><a href="${qrUrl}" target="_blank" rel="noreferrer">Open QR link</a></p>` : ""}
  <p id="status">Waiting for scan...</p>
  <script>
    const key = ${JSON.stringify(key)};
    const statusEl = document.getElementById("status");
    async function check() {
      try {
        const response = await fetch("/api/netease-login?mode=check&key=" + encodeURIComponent(key), {
          cache: "no-store",
        });
        const data = await response.json();
        if (data.ok) {
          statusEl.textContent = "Login succeeded. You can close this window.";
          setTimeout(() => window.close(), 800);
          return;
        }
        statusEl.textContent = data.message || "Waiting for authorization...";
        if (data.code === 800) return;
      } catch (error) {
        statusEl.textContent = (error && error.message) || "Login check failed.";
      }
      setTimeout(check, 2500);
    }
    check();
  </script>
</body>
</html>`;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode");

  if (mode === "check") {
    const key = searchParams.get("key")?.trim() || "";
    if (!key) {
      return NextResponse.json({ ok: false, error: "missing key" }, { status: 400 });
    }

    try {
      const result = await checkQrLogin({ baseUrl: neteaseBaseUrl(), key });
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return NextResponse.json(
        { ok: false, error: redactSensitiveText((error as Error).message) },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  if (mode === "status") {
    try {
      const resolved = resolveCookie();
      const profile = await getLoginProfile({
        baseUrl: neteaseBaseUrl(),
        cookie: resolved.cookie,
      });
      return NextResponse.json(profile, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      return NextResponse.json(
        { valid: false, error: redactSensitiveText((error as Error).message) },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  try {
    const resolved = resolveCookie();
    if (resolved.cookie) {
      const status = await verifyLoginStatus({
        baseUrl: neteaseBaseUrl(),
        cookie: resolved.cookie,
      });
      if (status.valid) {
        const profile = await getLoginProfile({
          baseUrl: neteaseBaseUrl(),
          cookie: resolved.cookie,
        });
        return new NextResponse(
          `<!doctype html><html><head><meta charset="utf-8"><title>Netease Music Login</title></head><body style="font-family: system-ui, sans-serif; margin: 40px;"><h1>Netease Music Login</h1><p>Already logged in as ${profile.nickname || `user ${status.userId}`}.</p></body></html>`,
          { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
        );
      }
    }

    const qr = await createQrLogin({ baseUrl: neteaseBaseUrl() });
    return new NextResponse(renderQrPage(qr), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (error) {
    return new NextResponse(
      `<!doctype html><html><head><meta charset="utf-8"><title>Netease Music Login</title></head><body style="font-family: system-ui, sans-serif; margin: 40px;"><h1>Netease Music Login</h1><p>${redactSensitiveText((error as Error).message)}</p></body></html>`,
      {
        status: 500,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      },
    );
  }
}
