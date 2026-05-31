/**
 * ScriptVM — 自定义音源脚本执行沙箱
 *
 * 基于 LX Music userApi 机制：
 * - 用户脚本调用 lx.on('request', handler) 注册拦截
 * - 用户脚本调用 lx.send('inited', { sources }) 声明支持的源
 * - resolve() 调用 handler，返回直链 URL
 *
 * 使用 Node.js vm 模块创建隔离上下文，不暴露 process/require/global
 */

import { createContext, runInContext, type Context } from "node:vm";
import { promises as fs } from "node:fs";
import { constants, createCipheriv, createHash, publicEncrypt, randomBytes } from "node:crypto";
import path from "node:path";
import { inflate, deflate } from "node:zlib";
import { promisify } from "node:util";

const inflateAsync = promisify(inflate);
const deflateAsync = promisify(deflate);
const SCRIPT_INIT_TIMEOUT_MS = 20_000;
export const SCRIPT_DIR = path.join(process.cwd(), "data");
export const SCRIPT_META_FILE = path.join(SCRIPT_DIR, "script-meta.json");
export const SCRIPT_FILE = path.join(process.cwd(), "scripts", "latest.js");
const EVENT_NAMES = Object.freeze({
  request: "request",
  inited: "inited",
  updateAlert: "updateAlert",
});
const EVENT_NAME_VALUES = Object.values(EVENT_NAMES) as string[];
const SOURCE_ALIASES: Record<string, string[]> = {
  kugou: ["kg"],
  qq: ["tx"],
  netease: ["wy"],
  kg: ["kugou"],
  tx: ["qq"],
  wy: ["netease"],
};

type LxRequestOptions = {
  method?: string;
  timeout?: number;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  form?: Record<string, string | number | boolean | null | undefined>;
  formData?: FormData;
};

type LxHttpResponse = {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  bytes: number;
  raw: Buffer;
  body: unknown;
};

type LxRequestCallback = (err: Error | null, resp: LxHttpResponse | null, body: unknown) => void;
type LxRequestFunction = {
  (
    url: string,
    options?: LxRequestOptions | LxRequestCallback,
    callback?: LxRequestCallback,
  ): (() => void) | Promise<LxHttpResponse>;
  fetch: (url: string, options?: LxRequestOptions) => Promise<LxHttpResponse>;
};

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function normalizeRequestOptions(options: LxRequestOptions | LxRequestCallback | undefined): LxRequestOptions {
  return typeof options === "function" ? {} : options ?? {};
}

function buildRequestBody(options: LxRequestOptions): BodyInit | undefined {
  if (options.body !== undefined && options.body !== null) return options.body;
  if (options.formData) return options.formData;
  if (!options.form) return undefined;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options.form)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  return params;
}

async function performRequest(url: string, options: LxRequestOptions = {}, controller?: AbortController) {
  const activeController = controller ?? new AbortController();
  const timeout = typeof options.timeout === "number" && options.timeout > 0
    ? Math.min(options.timeout, 60_000)
    : 60_000;
  const timer = setTimeout(() => activeController.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: options.method ?? "get",
      headers: options.headers,
      body: buildRequestBody(options),
      cache: "no-store",
      signal: activeController.signal,
    });
    const raw = Buffer.from(await response.arrayBuffer());
    const text = raw.toString("utf8");
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : "";
    } catch {
      body = text;
    }

    return {
      statusCode: response.status,
      statusMessage: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      bytes: raw.byteLength,
      raw,
      body,
    } satisfies LxHttpResponse;
  } finally {
    clearTimeout(timer);
  }
}

function createLxRequest(): LxRequestFunction {
  const request = ((
    url: string,
    options?: LxRequestOptions | LxRequestCallback,
    callback?: LxRequestCallback,
  ) => {
    const cb = typeof options === "function" ? options : callback;
    const requestOptions = normalizeRequestOptions(options);

    if (cb) {
      const controller = new AbortController();
      void performRequest(url, requestOptions, controller)
        .then((resp) => cb(null, resp, resp.body))
        .catch((err) => cb(toError(err), null, null));
      return () => controller.abort();
    }

    return performRequest(url, requestOptions);
  }) as LxRequestFunction;

  request.fetch = (url: string, options?: LxRequestOptions) => performRequest(url, options);
  return request;
}

function normalizeSourceInfo(data: unknown): Record<string, SourceConfig> {
  if (!data || typeof data !== "object") {
    throw new Error("Missing required parameter init info");
  }

  const sources = (data as { sources?: unknown }).sources;
  if (!sources || typeof sources !== "object") {
    throw new Error("Missing required parameter init sources");
  }

  const sourceInfo: Record<string, SourceConfig> = {};
  for (const [source, rawConfig] of Object.entries(sources as Record<string, unknown>)) {
    if (!rawConfig || typeof rawConfig !== "object") continue;
    const config = rawConfig as { actions?: unknown; qualitys?: unknown; type?: unknown };
    if (config.type !== "music") continue;
    sourceInfo[source] = {
      actions: Array.isArray(config.actions) ? config.actions.filter((item): item is string => typeof item === "string") : [],
      qualitys: Array.isArray(config.qualitys) ? config.qualitys.filter((item): item is string => typeof item === "string") : [],
    };
  }
  return sourceInfo;
}

/** lx.on('request', handler) 收到的请求格式 */
export interface LxRequest {
  source: string;
  action: "musicUrl" | "lyric" | "pic";
  info: {
    type?: string; // '128k' | '320k' | 'flac'
    musicInfo?: {
      songmid?: string;
      songId?: number | string;
      hash?: string;
      name?: string;
      singer?: string;
      album?: string;
      duration?: number;
      // 其他平台字段...
    };
  };
}

/** handler 返回格式（musicUrl 时为 string 或 { url: string }） */
export type LxResponse =
  | string
  | { url?: string; lyric?: string; tlyric?: string; rlyric?: string; lxlyric?: string; pic?: string };

/** 脚本元数据 */
export interface ScriptMeta {
  name: string;
  version: string;
  author: string;
  description: string;
  homepage: string;
}

/** 解析 @name @version 等元数据 */
const INFO_NAMES = {
  name: 24,
  description: 36,
  author: 56,
  homepage: 1024,
  version: 36,
} as const;

function parseScriptMeta(code: string): ScriptMeta {
  const result = /^\/\*[\S\s]+?\*\//.exec(code);
  if (!result) throw new Error("无效的自定义源文件：缺少元数据注释（/* ... */）");

  const rxp = /^\s?\*\s?@(\w+)\s(.+)$/gm;
  const infos: Record<string, string> = {};
  let match;

  while ((match = rxp.exec(result[0])) !== null) {
    const key = match[1] as keyof typeof INFO_NAMES;
    if (key in INFO_NAMES) {
      let val = match[2].trim();
      const limit = INFO_NAMES[key];
      if (limit && val.length > limit) val = val.substring(0, limit) + "...";
      infos[key] = val;
    }
  }

  return {
    name: infos.name || "未命名",
    version: infos.version || "1.0",
    author: infos.author || "",
    description: infos.description || "",
    homepage: infos.homepage || "",
  };
}

/** 用户脚本支持的 source 配置 */
type SourceConfig = {
  actions: string[];
  qualitys: string[];
};

export class ScriptVM {
  /** 解析后的 vm 上下文，runInContext 使用 */
  private context: Context | null = null;

  /** 用户脚本注册的 handler (req: LxRequest) => LxResponse | Promise<LxResponse> */
  private handler: ((req: LxRequest) => LxResponse | Promise<LxResponse>) | null = null;

  /** 用户脚本声明支持的 source → { actions, qualitys } */
  private sourceInfo: Record<string, SourceConfig> = {};

  /** 脚本元数据 */
  private meta: ScriptMeta | null = null;

  /** 是否已初始化（收到 lx.send('inited')） */
  private initialized = false;

  /** 当前加载批次，用来忽略旧脚本的异步回调 */
  private loadToken = 0;

  get isLoaded(): boolean {
    return this.initialized && this.handler !== null;
  }

  get scriptMeta(): ScriptMeta | null {
    return this.meta;
  }

  /** 返回用户脚本支持的 source 列表 */
  get supportedSources(): Record<string, SourceConfig> {
    return this.sourceInfo;
  }

  /**
   * 加载用户脚本
   * 1. 解析元数据
   * 2. 创建 vm 上下文，注入 lx 对象
   * 3. runInContext 执行脚本
   * 4. 脚本调用 lx.on('request', handler) 和 lx.send('inited', ...) 注册
   */
  async load(code: string): Promise<void> {
    this.unload();
    const token = ++this.loadToken;

    // 1. 解析元数据
    this.meta = parseScriptMeta(code);

    // 捕获真实的 Node.js Buffer（不在 sandbox 内，避免被覆盖）
    const RealBuffer = globalThis.Buffer;

    // 2. 创建 lx 全局对象的引用（vm 内部填充 handler / sourceInfo）
    const meta = this.meta;
    const lxRequest = createLxRequest();
    let initTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveInit: (() => void) | null = null;
    let rejectInit: ((error: Error) => void) | null = null;
    const initPromise = new Promise<void>((resolve, reject) => {
      resolveInit = resolve;
      rejectInit = reject;
      initTimer = setTimeout(() => {
        reject(new Error("脚本初始化超时：未收到 lx.send('inited')"));
      }, SCRIPT_INIT_TIMEOUT_MS);
    });

    const completeInit = () => {
      if (initTimer) clearTimeout(initTimer);
      initTimer = null;
      resolveInit?.();
    };

    const failInit = (error: Error) => {
      if (initTimer) clearTimeout(initTimer);
      initTimer = null;
      rejectInit?.(error);
    };

    const sandbox = {
      console: {
        log: () => {},
        error: () => {},
        warn: () => {},
      },

      // lx 全局对象（关键 API）
      lx: {
        EVENT_NAMES,
        version: "2.0.0",
        env: "desktop",

        currentScriptInfo: {
          name: meta.name,
          description: meta.description,
          version: meta.version,
          author: meta.author,
          homepage: meta.homepage,
          rawScript: code,
        },

        // 注册请求拦截器
        on: (eventName: string, handler: (req: LxRequest) => LxResponse): Promise<void> => {
          if (!EVENT_NAME_VALUES.includes(eventName)) {
            return Promise.reject(new Error(`The event is not supported: ${eventName}`));
          }
          if (eventName === EVENT_NAMES.request) {
            this.handler = handler;
            return Promise.resolve();
          }
          return Promise.reject(new Error(`The event is not supported: ${eventName}`));
        },

        // 初始化通知（用户脚本调用 lx.send('inited', { sources })）
        send: (eventName: string, data: unknown): Promise<void> => {
          if (token !== this.loadToken) {
            return Promise.reject(new Error("Script has been unloaded"));
          }
          if (!EVENT_NAME_VALUES.includes(eventName)) {
            return Promise.reject(new Error(`The event is not supported: ${eventName}`));
          }
          if (eventName === EVENT_NAMES.inited) {
            if (this.initialized) return Promise.reject(new Error("Script is inited"));
            try {
              this.sourceInfo = normalizeSourceInfo(data);
            } catch (err) {
              const error = toError(err);
              failInit(error);
              return Promise.reject(error);
            }
            this.initialized = true;
            completeInit();
            return Promise.resolve();
          }
          if (eventName === EVENT_NAMES.updateAlert) return Promise.resolve();
          return Promise.reject(new Error(`Unknown event name: ${eventName}`));
        },

        // HTTP 请求（兼容 needle callback 风格 + Promise fetch 风格）
        request: lxRequest,
        fetch: lxRequest.fetch,

        utils: {
          crypto: {
            md5(str: string): string {
              return createHash("md5").update(str).digest("hex");
            },
            aesEncrypt(buffer: Buffer, mode: string, key: Buffer, iv: Buffer): Buffer {
              const cipher = createCipheriv(mode, key, iv);
              return Buffer.concat([cipher.update(buffer), cipher.final()]);
            },
            rsaEncrypt(buffer: Buffer, key: Buffer): Buffer {
              const padded = buffer.length >= 128
                ? buffer
                : Buffer.concat([Buffer.alloc(128 - buffer.length), buffer]);
              return publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, padded);
            },
            randomBytes(size: number): Buffer {
              return randomBytes(size);
            },
          },
          buffer: {
            from(data: ArrayBuffer | string | Buffer, encoding?: BufferEncoding): Buffer {
              // User scripts pass various types; use any to bypass strict TS overload checking
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              return RealBuffer.from(data as any, encoding as BufferEncoding | undefined);
            },
            bufToString(buf: Buffer | string, format: BufferEncoding = "utf8"): string {
              return RealBuffer.from(buf as never, "binary").toString(format);
            },
          },
          zlib: {
            inflate(buf: Buffer): Promise<Buffer> {
              return inflateAsync(buf);
            },
            deflate(data: string | Buffer): Promise<Buffer> {
              return deflateAsync(data);
            },
          },
        },
      },

      // 用户脚本可能用到的基础对象
      Promise,
      JSON,
      Math,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Error,
      TypeError,
      ArrayBuffer,
      Uint8Array,
      Buffer: RealBuffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      fetch,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      encodeURIComponent,
      decodeURIComponent,
      atob,
      btoa,
      // Z 是用户脚本内部定义的字符串解码函数，不需要从沙箱外部提供
    };

    this.context = createContext(sandbox);

    // Node.js vm 的 sandbox.globalThis 是 undefined
    // 必须先在 context 内执行 globalThis 获取真正的 vm globalThis 引用
    // 再把 lx 的所有属性平铺到 realGt 上，模拟浏览器 window.lx 和 window.lx.version 的双重访问
    const realGt = runInContext("globalThis", this.context) as typeof sandbox;
    for (const key of ["lx", "\x6c\x78"] as const) {
      Object.defineProperty(realGt, key, {
        value: sandbox.lx,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    for (const key of ["window", "self"] as const) {
      Object.defineProperty(realGt, key, {
        value: realGt,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    // lx 的属性也直接平铺到 globalThis 上（lx.version / lx.env / lx.request ...）
    // 模拟浏览器环境 window.lx = window['lx'] = lxObject
    for (const key of Object.keys(sandbox.lx) as (keyof typeof sandbox.lx)[]) {
      if (key === "currentScriptInfo") continue; // currentScriptInfo 是对象，不平铺
      Object.defineProperty(realGt, key, {
        value: sandbox.lx[key],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    // 平铺 currentScriptInfo 的子属性（version / env 等脚本直接引用的字段）
    for (const key of Object.keys(sandbox.lx.currentScriptInfo)) {
      Object.defineProperty(realGt, key, {
        value: sandbox.lx.currentScriptInfo[key as keyof typeof sandbox.lx.currentScriptInfo],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }

    // 3. 执行用户脚本
    // 4. 脚本调用 lx.on('request', handler) 注册拦截器，填充 vm.handler
    // 4. 脚本调用 lx.send('inited', { sources }) 声明支持哪些源，填充 vm.sourceInfo
    try {
      runInContext(code, this.context);
    } catch (err) {
      // 捕获并报告脚本初始加载阶段的错误（IIFE 执行时期）
      const msg = (err as Error).message;
      // 去掉 Node.js vm 的路径前缀，只留脚本内错误位置
      const match = msg.match(/^[^\n]+/);
      const error = new Error(`脚本初始化错误：${match ? match[0] : msg}`);
      failInit(error);
      this.unload();
      throw error;
    }

    try {
      await initPromise;
      if (!this.handler) {
        throw new Error("脚本没有注册 request 事件");
      }
    } catch (err) {
      this.unload();
      throw toError(err);
    }
  }

  /**
   * 诊断模式：在 vm 上下文内执行代码并捕获更详细的错误信息
   * 用于排查脚本加载失败时的具体原因
   */
  private diagnose(code: string, label: string): string {
    try {
      runInContext(code, this.context!);
      return "ok";
    } catch (err) {
      const e = err as Error;
      return `${label}: ${e.name} — ${e.message}\n${(e.stack || "").split("\n").slice(0, 3).join("\n")}`;
    }
  }

  private selectSourceForRequest(req: LxRequest): string | null {
    const candidates = [
      req.source,
      ...(SOURCE_ALIASES[req.source] ?? []),
      ...Object.entries(SOURCE_ALIASES)
        .filter(([, aliases]) => aliases.includes(req.source))
        .map(([key]) => key),
    ];

    if (Object.keys(this.sourceInfo).length === 0) {
      return candidates[0] ?? req.source;
    }

    for (const candidate of candidates) {
      const config = this.sourceInfo[candidate];
      if (!config) continue;
      if (!config.actions.includes(req.action)) return null;
      return candidate;
    }
    return null;
  }

  canResolve(source: string, action: LxRequest["action"]): boolean {
    if (!this.isLoaded) return false;
    return this.selectSourceForRequest({ source, action, info: {} }) !== null;
  }

  /**
   * 解析直链（供 resolvePlaybackUrlForHit 调用）
   *
   * @param req.source  'kugou' | 'qq' | 'netease'
   * @param req.action  'musicUrl' | 'lyric' | 'pic'
   * @param req.info    曲目信息
   * @returns 直链 URL 或 null
   */
  async resolve(req: LxRequest): Promise<string | null> {
    if (!this.handler) return null;

    const source = this.selectSourceForRequest(req);
    if (!source) return null;

    try {
      const response = await this.handler({ ...req, source });

      if (req.action === "musicUrl") {
        if (typeof response === "string") {
          if (response.length > 2048 || !/^https?:/.test(response)) return null;
          return response;
        }
        if (typeof response === "object" && response !== null && "url" in response) {
          const url = (response as { url: string }).url;
          if (!url || url.length > 2048 || !/^https?:/.test(url)) return null;
          return url;
        }
        return null;
      }

      if (req.action === "lyric") {
        if (typeof response === "string") {
          return response || null;
        }
        if (typeof response === "object" && response !== null) {
          const r = response as Record<string, string>;
          // lyric 至少要有一个字段有内容
          const lyric = r.lyric || r.lxlyric;
          if (!lyric) return null;
          return JSON.stringify({
            lyric: lyric || "",
            tlyric: r.tlyric || "",
            rlyric: r.rlyric || "",
            lxlyric: r.lxlyric || "",
          });
        }
        return null;
      }

      if (req.action === "pic") {
        if (typeof response === "string") {
          if (!/^https?:/.test(response)) return null;
          return response;
        }
        if (typeof response === "object" && response !== null && "pic" in response) {
          const pic = (response as { pic: string }).pic;
          if (!pic || !/^https?:/.test(pic)) return null;
          return pic;
        }
        return null;
      }

      return null;
    } catch {
      return null;
    }
  }

  /** 卸载脚本，清理所有状态 */
  unload(): void {
    this.loadToken += 1;
    this.context = null;
    this.handler = null;
    this.sourceInfo = {};
    this.meta = null;
    this.initialized = false;
  }
}

/** 单例，全局共享一个 ScriptVM 实例 */
export const scriptVM = new ScriptVM();

let autoLoadPromise: Promise<void> | null = null;

export async function ensureScriptVMLoaded(): Promise<void> {
  if (scriptVM.isLoaded) return;

  autoLoadPromise ??= fs.readFile(SCRIPT_FILE, "utf8")
    .then((code) => scriptVM.load(code))
    .catch((error) => {
      const e = error as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        console.warn("[script-vm] auto-load user script failed:", e.message);
      }
    });

  await autoLoadPromise;
}

export function resetScriptVMLoadCache(): void {
  autoLoadPromise = null;
}
