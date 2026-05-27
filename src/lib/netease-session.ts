import fs from "node:fs";
import path from "node:path";

const DEFAULT_NETEASE_BASE = "http://127.0.0.1:3001";
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

export const DATA_DIR = path.join(process.cwd(), "data", "netease");
export const LOCAL_CONFIG_PATH = path.join(DATA_DIR, "local.config.json");
export const QR_LOGIN_PATH = path.join(DATA_DIR, "qr-login.html");

export function neteaseBaseUrl() {
  return (process.env.NETEASE_API_BASE || DEFAULT_NETEASE_BASE).replace(/\/+$/, "");
}

function readJson(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function maskSecret(value: string) {
  if (!value) return "";
  const text = String(value);
  if (text.length <= 12) return `${text.slice(0, 2)}...${text.slice(-2)}`;
  return `${text.slice(0, 6)}...${text.slice(-6)}`;
}

function maskCookieField(_: string, prefix: string, value: string) {
  return `${prefix}${maskSecret(value)}`;
}

export function redactSensitiveText(value: string) {
  if (!value) return value;
  return String(value)
    .replace(/\b(MUSIC_U=)([^;&\s]+)/gi, maskCookieField)
    .replace(/\b(__csrf=)([^;&\s]+)/gi, maskCookieField)
    .replace(/\b(cookie=)([^&\s]+)/gi, maskCookieField);
}

export function hasNeteaseCookie(cookie: string) {
  return typeof cookie === "string" && /MUSIC_U=|__csrf=/.test(cookie);
}

export function readLocalConfig() {
  try {
    return readJson(LOCAL_CONFIG_PATH) || {};
  } catch (error) {
    console.warn(`[netease-login] Ignoring unreadable local config: ${redactSensitiveText((error as Error).message)}`);
    return {};
  }
}

export function writeLocalConfig(nextConfig: Record<string, unknown>) {
  ensureDataDir();
  const previous = readLocalConfig();
  const merged = {
    ...previous,
    ...nextConfig,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(LOCAL_CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(LOCAL_CONFIG_PATH, 0o600);
  } catch {
    // 非 POSIX 文件系统上 chmod 失败可忽略。
  }
  return merged;
}

export function resolveCookie() {
  const envCookie = process.env.NETEASE_COOKIE;
  if (hasNeteaseCookie(envCookie || "")) {
    return { cookie: envCookie || "", source: "env", path: null };
  }

  const localConfig = readLocalConfig();
  if (hasNeteaseCookie(localConfig.cookie || "")) {
    return { cookie: String(localConfig.cookie), source: "local", path: LOCAL_CONFIG_PATH };
  }

  return { cookie: "", source: "anonymous", path: null };
}

export async function requestNeteaseJson(
  pathname: string,
  params: Record<string, string | number | boolean | undefined | null> = {},
  options: {
    baseUrl?: string;
    cookie?: string;
    timeoutMs?: number;
    method?: string;
  } = {},
) {
  const baseUrl = (options.baseUrl || neteaseBaseUrl()).replace(/\/+$/, "");
  const cookie = options.cookie || "";
  const timeoutMs = Number(options.timeoutMs || process.env.NETEASE_REQUEST_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MS);
  const url = new URL(pathname, `${baseUrl}/`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  url.searchParams.set("timestamp", String(Date.now()));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const method = options.method || "GET";
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  if (method !== "GET" && method !== "HEAD") headers["Content-Type"] = "application/json";

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : "{}",
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }

    if (!response.ok) {
      const data = body as { message?: string; msg?: string } | null;
      const message = redactSensitiveText(data?.message || data?.msg || `HTTP ${response.status}`);
      throw new Error(message);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyLoginStatus({
  baseUrl = neteaseBaseUrl(),
  cookie,
}: {
  baseUrl?: string;
  cookie?: string;
} = {}) {
  if (!hasNeteaseCookie(cookie || "")) {
    return { valid: false, userId: null, reason: "missing-cookie" };
  }

  try {
    const status = await requestNeteaseJson("/login/status", {}, { baseUrl, cookie });
    const data = (status as { data?: Record<string, unknown> })?.data;
    const account = data?.account as { id?: number; userName?: string } | undefined;
    const profile = (status as {
      data?: { profile?: { userId?: number; nickname?: string; avatarUrl?: string } };
      profile?: { userId?: number; nickname?: string; avatarUrl?: string };
    })?.data?.profile || (status as {
      profile?: { userId?: number; nickname?: string; avatarUrl?: string };
    })?.profile;

    if (profile?.userId) {
      return { valid: true, userId: profile.userId, reason: "ok" };
    }
    if (account?.id) {
      return { valid: false, userId: account.id, reason: "ok-anonymous" };
    }
    return { valid: false, userId: null, reason: "profile-missing" };
  } catch (error) {
    return { valid: false, userId: null, reason: redactSensitiveText((error as Error).message) };
  }
}

export async function getLoginProfile({
  baseUrl = neteaseBaseUrl(),
  cookie,
}: {
  baseUrl?: string;
  cookie?: string;
} = {}) {
  if (!hasNeteaseCookie(cookie || "")) {
    return { valid: false, userId: null, nickname: "", avatarUrl: "", reason: "missing-cookie" };
  }

  try {
    const status = await requestNeteaseJson("/login/status", {}, { baseUrl, cookie });
    const data = (status as { data?: Record<string, unknown> })?.data;
    const account = data?.account as {
      id?: number;
      userName?: string;
      avatarUrl?: string;
      nickname?: string;
    } | undefined;
    const profile = (status as {
      data?: { profile?: { userId?: number; nickname?: string; avatarUrl?: string } };
      profile?: { userId?: number; nickname?: string; avatarUrl?: string };
    })?.data?.profile || (status as {
      profile?: { userId?: number; nickname?: string; avatarUrl?: string };
    })?.profile;

    // 真实账号
    if (profile?.userId) {
      return {
        valid: true,
        userId: profile.userId,
        nickname: profile.nickname || "",
        avatarUrl: profile.avatarUrl || "",
        reason: "ok",
      };
    }
    if (account?.id) {
      return {
        valid: false,
        userId: account.id,
        nickname: account.nickname || account.userName || "",
        avatarUrl: account.avatarUrl || "",
        reason: "ok-anonymous",
      };
    }

    return {
      valid: false,
      userId: null,
      nickname: "",
      avatarUrl: "",
      reason: "profile-missing",
    };
  } catch (error) {
    return {
      valid: false,
      userId: null,
      nickname: "",
      avatarUrl: "",
      reason: redactSensitiveText((error as Error).message),
    };
  }
}

function writeQrLoginPage(qrImg: string, qrUrl: string) {
  ensureDataDir();
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Netease Music Login</title></head>
<body style="font-family: system-ui, sans-serif; margin: 40px;">
  <h1>Netease Music Login</h1>
  <p>Scan this QR code with the Netease Cloud Music mobile app.</p>
  <img src="${qrImg}" alt="Netease Cloud Music login QR code" style="width: 260px; height: 260px;">
  ${qrUrl ? `<p><a href="${qrUrl}">Open QR link</a></p>` : ""}
</body>
</html>
`;
  fs.writeFileSync(QR_LOGIN_PATH, html, "utf8");
  return html;
}

export async function createQrLogin({ baseUrl = neteaseBaseUrl() }: { baseUrl?: string } = {}) {
  const keyData = await requestNeteaseJson("/login/qr/key", {}, { baseUrl });
  const key = (keyData as { data?: { unikey?: string } })?.data?.unikey;
  if (!key) throw new Error("Failed to get QR login key from NeteaseCloudMusicApi.");

  // Match the upstream demo flow so the QR URL includes the web chainId branch.
  const qrData = await requestNeteaseJson("/login/qr/create", { key, platform: "web", qrimg: true }, { baseUrl });
  const qrUrl = (qrData as { data?: { qrurl?: string; qrimg?: string } })?.data?.qrurl || "";
  const qrImg = (qrData as { data?: { qrurl?: string; qrimg?: string } })?.data?.qrimg || "";
  const qrPage = qrImg ? writeQrLoginPage(qrImg, qrUrl) : "";
  return { key, qrUrl, qrImg, qrPage };
}

export async function checkQrLogin({
  baseUrl = neteaseBaseUrl(),
  key,
}: {
  baseUrl?: string;
  key: string;
}) {
  const state = await requestNeteaseJson("/login/qr/check", { key }, { baseUrl });
  const code = Number((state as { code?: number }).code);
  const cookie = (state as { cookie?: string }).cookie || "";

  if (code === 803 && cookie) {
    const profile = await getLoginProfile({ baseUrl, cookie });
    const saved = writeLocalConfig({ cookie, source: "qr-login" });
    return {
      ok: profile.valid && profile.reason === "ok",
      code,
      cookieSaved: true,
      cookieSource: saved.source || "qr-login",
      valid: profile.valid,
      userId: profile.userId,
      nickname: profile.nickname,
      avatarUrl: profile.avatarUrl,
      reason: profile.reason,
      message:
        profile.reason === "ok"
          ? "Login succeeded."
          : profile.reason === "ok-anonymous"
            ? "QR authorized, but only an anonymous session was returned."
            : "QR authorized, but profile verification failed.",
    };
  }

  return {
    ok: false,
    code,
    message:
      code === 801
        ? "Waiting for scan..."
        : code === 802
          ? "Scan confirmed; waiting for final authorization..."
          : code === 800
            ? "QR code expired."
            : "Waiting for authorization...",
  };
}
