const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const DEFAULT_NETEASE_BASE = "http://127.0.0.1:3001";
const DEFAULT_NETEASE_COMMAND = "npx";
const DEFAULT_NETEASE_ARGS = ["NeteaseCloudMusicApi@latest"];
const DEFAULT_READY_TIMEOUT_MS = 60_000;

let sidecar = null;
let shuttingDown = false;

function splitArgs(value) {
  if (!value) return [];
  return String(value)
    .split(/\s+/)
    .map((arg) => arg.trim())
    .filter(Boolean);
}

function neteaseBaseUrl() {
  return String(process.env.NETEASE_API_BASE || DEFAULT_NETEASE_BASE).replace(/\/+$/, "");
}

function neteasePort(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.port) return url.port;
    return url.protocol === "https:" ? "443" : "80";
  } catch {
    return "3001";
  }
}

function cleanNpmEnv(env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    const normalized = key.toLowerCase();
    if (
      normalized.startsWith("npm_config_") ||
      normalized.startsWith("npm_package_") ||
      normalized.startsWith("npm_lifecycle_") ||
      normalized === "npm_command" ||
      normalized === "npm_execpath" ||
      normalized === "npm_node_execpath"
    ) {
      delete clean[key];
    }
  }
  delete clean.INIT_CWD;
  return clean;
}

async function isReachable(url, timeoutMs = 1_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchStatus(baseUrl, timeoutMs = 1_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL("/inner/version", `${baseUrl}/`);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json().catch(() => ({}));
    return {
      connected: true,
      version: body?.data?.version || body?.version || "",
    };
  } catch {
    return {
      connected: await isReachable(baseUrl, timeoutMs),
      version: "",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntilReady(baseUrl, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await fetchStatus(baseUrl);
    if (status.connected) return status;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { connected: false, version: "" };
}

function shutdown(code = 0) {
  shuttingDown = true;
  if (!sidecar || sidecar.killed) {
    process.exit(code);
    return;
  }
  sidecar.once("exit", () => process.exit(code));
  sidecar.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300).unref();
}

// ─── 启动横幅 ───────────────────────────────────
function printBanner() {
  const script = path.join(__dirname, "radio-banner.sh");
  try {
    const { execSync } = require("node:child_process");
    execSync(`bash "${script}"`, { stdio: "inherit", timeout: 10000 });
  } catch {
    // 天气/歌单获取失败不影响主流程，静默跳过
  }
}

async function main() {
  printBanner();
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  const baseUrl = neteaseBaseUrl();
  const existing = await fetchStatus(baseUrl);
  if (existing.connected) {
    const versionText = existing.version ? ` v${existing.version}` : "";
    console.log(`[sidecar] Using existing Netease service: ${baseUrl}${versionText}`);
    return;
  }

  const command = process.env.NETEASE_SIDECAR_COMMAND || DEFAULT_NETEASE_COMMAND;
  const args = splitArgs(process.env.NETEASE_SIDECAR_ARGS);
  const finalArgs = args.length ? args : DEFAULT_NETEASE_ARGS;
  const timeoutMs = Number(process.env.NETEASE_READY_TIMEOUT_MS || DEFAULT_READY_TIMEOUT_MS);
  const env = {
    ...cleanNpmEnv(process.env),
    PORT: neteasePort(baseUrl),
  };

  console.log(`[sidecar] Starting Netease sidecar: ${command} ${finalArgs.join(" ")} (PORT=${env.PORT})`);
  sidecar = spawn(command, finalArgs, {
    env,
    stdio: "inherit",
  });

  sidecar.on("exit", (code, signal) => {
    if (!shuttingDown) {
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      console.warn(`[sidecar] exited (${detail})`);
      process.exit(typeof code === "number" ? code : 1);
    }
  });

  sidecar.on("error", (error) => {
    console.error(`[sidecar] failed to start: ${error.message}`);
    process.exit(1);
  });

  const ready = await waitUntilReady(baseUrl, timeoutMs);
  if (!ready.connected) {
    console.warn(`[sidecar] did not become ready within ${timeoutMs}ms: ${baseUrl}`);
    return;
  }

  const versionText = ready.version ? ` v${ready.version}` : "";
  console.log(`[sidecar] ready: ${baseUrl}${versionText}`);
}

main().catch((error) => {
  console.error(`[sidecar] ${error.message}`);
  shutdown(1);
});
