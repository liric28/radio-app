import { NextRequest, NextResponse } from "next/server";
import {
  checkQrLogin,
  createQrLogin,
  getLoginProfile,
  logout,
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
          statusEl.textContent = "Login succeeded. Refreshing...";
          if (window.opener) {
            window.opener.location.reload();
          }
          setTimeout(() => window.close(), 600);
          return;
        }
        statusEl.textContent = data.message || "Waiting for authorization...";
        if (data.code === 800 || data.terminal) return;
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

// ============================================================
// 登录流程
//
//  1. 首次访问 /api/netease-login（无 cookie）
//     → createQrLogin() 向 sidecar 请求二维码 key 和图片
//     → 返回 renderQrPage()（内含轮询 JS，每 2.5s 查 /mode=check）
//
//  2. 扫码确认后手机端授权
//     → 前端轮询 /mode=check 捕获 code=803
//     → checkQrLogin() 写 local.config.json（cookie + source）
//     → 前端弹窗提示"登录成功，可关闭"
//
//  3. 已登录用户访问 /api/netease-login（带 cookie）
//     → verifyLoginStatus() → 返回已登录 HTML（不重新扫码）
//
// 4. 前端 PlayerShell 初始化时调 /mode=status
//     → getLoginProfile() → sidecar → 网易云 /login/status
//     → 返回 { valid, userId, nickname, avatarUrl }
//     → setNeteaseViewer() → renderNeteaseAvatar() 显示头像
//
// 5. /mode=logout → logout() → 调 sidecar /logout + 删除 local.config.json
//
// 架构
//   Next.js (3000) ← NETEASE_API_BASE ← sidecar NeteaseCloudMusicApi (3001)
//   cookie 存在 data/netease/local.config.json（source: qr-login）
//   搜歌不走 sidecar，直接调 interface.music.163.com
// ============================================================

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
      if (!resolved.cookie) {
        return NextResponse.json(
          { valid: false, userId: null, nickname: "", avatarUrl: "", reason: "missing-cookie" },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
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

  if (mode === "logout") {
    await logout({ baseUrl: neteaseBaseUrl() });
    return new NextResponse(
      `<!doctype html><html><head><meta charset="utf-8"><title>Logged out</title></head><body style="font-family: system-ui, sans-serif; margin: 40px;"><h1>Logged out</h1><p>You can close this window.</p><script>if (window.opener) window.opener.location.reload(); setTimeout(() => window.close(), 1000);</script></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
    );
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
          `<!doctype html><html><head><meta charset="utf-8"><title>Netease Music Login</title></head><body style="font-family: system-ui, sans-serif; margin: 40px;"><h1>Netease Music Login</h1><p>Already logged in as ${profile.nickname || `user ${status.userId}`}.</p><p><a href="/api/netease-login?mode=logout">Logout</a></p></body></html>`,
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
