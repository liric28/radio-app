import { createHash } from "node:crypto";

/**
 * 酷狗音乐公开 API 封装（搜索 + 取免费试听直链）。
 *
 * 两个公开端点，**都不需要 Cookie/签名/Referer**：
 *
 *   1. 搜索：GET https://songsearch.kugou.com/song_search_v2
 *      参数 keyword/page/pagesize/platform=WebFilter/filter=2/privilege_filter=0/area_code=1
 *      返回 data.lists[]，每条含 FileName="歌手 - 歌名"、FileHash、Audioid、PayType、Duration、Image 等
 *
 *   2. 取直链：GET https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash={FileHash}
 *      **必须用手机端 User-Agent**（iPhone UA）才会返回 url 字段
 *      返回 .url 直接是 sharefs.kugou.com 上的 mp3 直链（HTTPS，无 Referer 校验）
 *      **只有 pay_type=0 的曲目 url 才有值；付费曲（pay_type>0）url 为空**
 *
 * 整套链路适用于 PayType=0 的免费试听曲目。付费曲只能在搜索结果里看到，拿不到直链。
 */

export type KugouSearchHit = {
  audioId: number;
  hash: string;
  title: string;
  artist: string;
  albumName?: string;
  /** 秒，可能为 0（部分曲目缺失） */
  duration: number;
  /** 0 = 免费可下载；>0 = 付费/VIP 拿不到直链 */
  payType: number;
  /** 是否可下载（payType === 0 的快捷判断），前端按这个决定 + 按钮是否亮 */
  payable: boolean;
  /** 封面图模板，含 {size} 占位符，使用前替换成实际尺寸如 240 */
  imageTemplate: string | null;
};

const SEARCH_ENDPOINT = "https://songsearch.kugou.com/song_search_v2";
const SEARCH_FALLBACK_ENDPOINT = "https://mobilecdn.kugou.com/api/v3/search/song";
const SEARCH_GATEWAY_ENDPOINT = "https://gateway.kugou.com/complexsearch/v3/search/song";
const PLAY_INFO_ENDPOINT = "https://m.kugou.com/app/i/getSongInfo.php";
const LYRIC_SEARCH_ENDPOINT = "http://lyrics.kugou.com/search";
const LYRIC_DOWNLOAD_ENDPOINT = "http://lyrics.kugou.com/download";
const ANDROID_SIGN_KEY = "OIlwieks28dk2k092lksi2UIkp";

/**
 * iPhone UA 是 playInfo 必备——服务端拿不到这个 UA 不会返回 url 字段。
 * 桌面 UA 实测返回的 JSON 字段都没有 url，只有元数据。
 */
const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15";

type KugouSearchResponse = {
  error_code?: number;
  data?: {
    lists?: Array<{
      FileName?: string;
      SongName?: string;
      SingerName?: string;
      FileHash?: string;
      Audioid?: number;
      Duration?: number;
      PayType?: number;
      Image?: string;
    }>;
    total?: number;
  };
};

type KugouGatewaySearchResponse = {
  error_code?: number;
  data?: {
    lists?: Array<{
      FileName?: string;
      SongName?: string;
      SingerName?: string;
      Singers?: Array<{ name?: string }>;
      AlbumName?: string;
      FileHash?: string;
      Audioid?: number;
      Duration?: number;
      PayType?: number;
      Image?: string;
      Grp?: Array<{
        FileName?: string;
        SongName?: string;
        SingerName?: string;
        Singers?: Array<{ name?: string }>;
        AlbumName?: string;
        FileHash?: string;
        Audioid?: number;
        Duration?: number;
        PayType?: number;
        Image?: string;
      }>;
    }>;
    total?: number;
  };
};

type KugouFallbackSearchResponse = {
  status?: number;
  error_code?: number;
  data?: {
    info?: Array<{
      filename?: string;
      songname?: string;
      singername?: string;
      album_name?: string;
      hash?: string;
      audio_id?: number;
      duration?: number;
      pay_type?: number;
      image?: string;
    }>;
    total?: number;
  };
};

type KugouPlayInfoResponse = {
  status?: number;
  errcode?: number;
  url?: string;
  backup_url?: string[];
  pay_type?: number;
  bitRate?: number;
  timeLength?: number;
  songName?: string;
  singerName?: string;
};

type KugouLyricSearchResponse = {
  status?: number;
  candidates?: Array<{
    id?: number;
    accesskey?: string;
    krctype?: number;
    contenttype?: number;
  }>;
};

type KugouLyricDownloadResponse = {
  fmt?: "krc" | "lrc";
  content?: string;
};

/**
 * 拆 "歌手 - 歌名" 形式的 FileName。FileName 是搜索 API 给的拼接字符串，
 * 用 " - " 作分隔；个别曲目 FileName 没有分隔符（直接是歌名），fallback 用 SongName/SingerName 字段。
 */
function splitFileName(fileName: string): { artist: string; title: string } {
  const sepIndex = fileName.indexOf(" - ");
  if (sepIndex === -1) {
    return { artist: "", title: fileName.trim() };
  }
  return {
    artist: fileName.slice(0, sepIndex).trim(),
    title: fileName.slice(sepIndex + 3).trim(),
  };
}

function md5(text: string) {
  return createHash("md5").update(text).digest("hex");
}

function buildAndroidSignature(params: string) {
  const sorted = params.split("&").sort().join("");
  return md5(`${ANDROID_SIGN_KEY}${sorted}${ANDROID_SIGN_KEY}`);
}

function joinSingers(singers?: Array<{ name?: string }>) {
  if (!Array.isArray(singers)) return "";
  return singers
    .map((item) => item.name?.trim() ?? "")
    .filter(Boolean)
    .join("、");
}

function normalizeGatewayItem(
  item: NonNullable<NonNullable<KugouGatewaySearchResponse["data"]>["lists"]>[number],
): KugouSearchHit {
  const fileName = item.FileName ?? "";
  const split = splitFileName(fileName);
  const payType = item.PayType ?? 0;
  return {
    audioId: item.Audioid ?? 0,
    hash: item.FileHash ?? "",
    title: split.title || item.SongName?.trim() || fileName,
    artist: split.artist || item.SingerName?.trim() || joinSingers(item.Singers),
    albumName: item.AlbumName?.trim() ?? "",
    duration: item.Duration ?? 0,
    payType,
    payable: payType === 0,
    imageTemplate: item.Image ?? null,
  };
}

/**
 * 关键词搜索酷狗曲库。
 *
 * @param keyword 搜索词（曲名/歌手/拼音都行）
 * @param page 1-based 分页
 * @param limit 每页条数，酷狗上限 30 左右
 * @returns 规范化后的命中数组，按相关度（API 默认顺序）。失败返回空数组。
 */
export async function searchSongs(
  keyword: string,
  page = 1,
  limit = 20,
): Promise<KugouSearchHit[]> {
  const gatewayHits = await searchSongsGateway(keyword, page, limit);
  if (gatewayHits.length > 0) return gatewayHits;
  const fallbackHits = await searchSongsFallback(keyword, page, limit);
  if (fallbackHits.length > 0) return fallbackHits;
  return searchSongsPrimary(keyword, page, limit);
}

async function searchSongsGateway(
  keyword: string,
  page: number,
  limit: number,
): Promise<KugouSearchHit[]> {
  const params =
    `userid=0&area_code=1&appid=1005&dopicfull=1&page=${page}&token=0` +
    `&privilegefilter=0&requestid=0&pagesize=${limit}&user_labels=&clienttime=0` +
    `&sec_aggre=1&iscorrection=1&uuid=0&mid=0&keyword=${keyword}&dfid=-` +
    `&clientver=11409&platform=AndroidFilter&tag=`;

  const url = `${SEARCH_GATEWAY_ENDPOINT}?${params}&signature=${buildAndroidSignature(params)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46",
        Referer: "https://kugou.com",
        Accept: "application/json, text/plain, */*",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];

  let body: KugouGatewaySearchResponse;
  try {
    body = (await response.json()) as KugouGatewaySearchResponse;
  } catch {
    return [];
  }

  if ((body.error_code ?? 0) !== 0) return [];

  const ids = new Set<number>();
  const merged = (body.data?.lists ?? []).flatMap((item) => [item, ...(item.Grp ?? [])]);
  const hits: KugouSearchHit[] = [];

  for (const item of merged) {
    const audioId = item.Audioid ?? 0;
    if (!audioId || ids.has(audioId)) continue;
    ids.add(audioId);
    hits.push(normalizeGatewayItem(item));
  }

  return hits;
}

async function searchSongsPrimary(
  keyword: string,
  page: number,
  limit: number,
): Promise<KugouSearchHit[]> {
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("page", String(page));
  url.searchParams.set("pagesize", String(limit));
  url.searchParams.set("userid", "0");
  url.searchParams.set("clientver", "");
  url.searchParams.set("platform", "WebFilter");
  url.searchParams.set("filter", "2");
  url.searchParams.set("iscorrection", "1");
  url.searchParams.set("privilege_filter", "0");
  url.searchParams.set("area_code", "1");

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json, text/plain, */*",
        Referer: "https://www.kugou.com/",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];

  const raw = await response.text();
  const body = parsePrimarySearchBody(raw);
  if (!body || body.error_code !== 0) return [];

  const items = body.data?.lists ?? [];
  return items.map((item) => {
    const fileName = item.FileName ?? "";
    const split = splitFileName(fileName);
    const payType = item.PayType ?? 0;
    return {
      audioId: item.Audioid ?? 0,
      hash: item.FileHash ?? "",
      title: split.title || item.SongName?.trim() || fileName,
      artist: split.artist || item.SingerName?.trim() || "",
      albumName: "",
      duration: item.Duration ?? 0,
      payType,
      payable: payType === 0,
      imageTemplate: item.Image ?? null,
    };
  });
}

function parsePrimarySearchBody(raw: string): KugouSearchResponse | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed) as KugouSearchResponse;
  } catch {
    const jsonpMatch = trimmed.match(/^[^(]+\(([\s\S]+)\)\s*;?$/);
    if (!jsonpMatch) return null;
    try {
      return JSON.parse(jsonpMatch[1]) as KugouSearchResponse;
    } catch {
      return null;
    }
  }
}

async function searchSongsFallback(
  keyword: string,
  page: number,
  limit: number,
): Promise<KugouSearchHit[]> {
  const url = new URL(SEARCH_FALLBACK_ENDPOINT);
  url.searchParams.set("format", "json");
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("page", String(page));
  url.searchParams.set("pagesize", String(limit));
  url.searchParams.set("showtype", "1");

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json, text/plain, */*",
        Referer: "https://www.kugou.com/",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];

  let body: KugouFallbackSearchResponse;
  try {
    body = (await response.json()) as KugouFallbackSearchResponse;
  } catch {
    return [];
  }

  if (body.status !== 1 && body.error_code !== 0) return [];

  const items = body.data?.info ?? [];
  return items.map((item) => {
    const fileName = item.filename ?? "";
    const split = splitFileName(fileName);
    const payType = item.pay_type ?? 0;
    return {
      audioId: item.audio_id ?? 0,
      hash: item.hash ?? "",
      title: split.title || item.songname?.trim() || fileName,
      artist: split.artist || item.singername?.trim() || "",
      albumName: item.album_name?.trim() ?? "",
      duration: item.duration ?? 0,
      payType,
      payable: payType === 0,
      imageTemplate: item.image ?? null,
    };
  });
}

/** 取曲目直链 + 实际元数据（手机端 playInfo）。 */
export type KugouPlaybackInfo = {
  url: string;
  /** 备用直链（CDN 不同节点） */
  backupUrls: string[];
  /** kbps，可能比搜索 API 给的更准 */
  bitRate: number;
  /** 秒 */
  duration: number;
  /** 服务端确认的歌名（可能跟搜索结果略有差异，比如带 " | 歌手"） */
  songName: string;
  singerName: string;
};

/**
 * 通过 hash 取免费试听直链。
 *
 * @param hash 搜索结果里的 FileHash（32 位大写十六进制）
 * @returns 可下载的直链信息；null 表示该曲付费/无授权（pay_type !== 0），拿不到直链
 *
 * 网络/服务端错误也会返回 null（不抛），调用方按"拿不到"统一处理。
 */
export async function getPlaybackUrl(hash: string): Promise<KugouPlaybackInfo | null> {
  if (!hash) return null;

  const url = new URL(PLAY_INFO_ENDPOINT);
  url.searchParams.set("cmd", "playInfo");
  url.searchParams.set("hash", hash);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": MOBILE_USER_AGENT },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let body: KugouPlayInfoResponse;
  try {
    body = (await response.json()) as KugouPlayInfoResponse;
  } catch {
    return null;
  }

  if (!body.url || (body.pay_type ?? 0) !== 0) return null;

  return {
    url: body.url,
    backupUrls: Array.isArray(body.backup_url) ? body.backup_url : [],
    bitRate: body.bitRate ?? 128,
    duration: body.timeLength ?? 0,
    songName: body.songName?.trim() ?? "",
    singerName: body.singerName?.trim() ?? "",
  };
}

export async function getLyricText(hit: Pick<KugouSearchHit, "title" | "hash" | "duration">) {
  if (!hit.hash || !hit.title) return null;

  const searchUrl = new URL(LYRIC_SEARCH_ENDPOINT);
  searchUrl.searchParams.set("ver", "1");
  searchUrl.searchParams.set("man", "yes");
  searchUrl.searchParams.set("client", "pc");
  searchUrl.searchParams.set("keyword", hit.title);
  searchUrl.searchParams.set("hash", hit.hash);
  searchUrl.searchParams.set("timelength", String(hit.duration || 0));
  searchUrl.searchParams.set("lrctxt", "1");

  const searchResponse = await fetch(searchUrl, {
    headers: {
      "KG-RC": "1",
      "KG-THash": "expand_search_manager.cpp:852736169:451",
      "User-Agent": "KuGou2012-9020-ExpandSearchManager",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!searchResponse?.ok) return null;

  const searchBody = (await searchResponse.json().catch(() => null)) as KugouLyricSearchResponse | null;
  const candidate = searchBody?.candidates?.[0];
  if (!candidate?.id || !candidate.accesskey) return null;

  const format = candidate.krctype === 1 && candidate.contenttype !== 1 ? "krc" : "lrc";
  const downloadUrl = new URL(LYRIC_DOWNLOAD_ENDPOINT);
  downloadUrl.searchParams.set("ver", "1");
  downloadUrl.searchParams.set("client", "pc");
  downloadUrl.searchParams.set("id", String(candidate.id));
  downloadUrl.searchParams.set("accesskey", candidate.accesskey);
  downloadUrl.searchParams.set("fmt", format);
  downloadUrl.searchParams.set("charset", "utf8");

  const lyricResponse = await fetch(downloadUrl, {
    headers: {
      "KG-RC": "1",
      "KG-THash": "expand_search_manager.cpp:852736169:451",
      "User-Agent": "KuGou2012-9020-ExpandSearchManager",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!lyricResponse?.ok) return null;

  const lyricBody = (await lyricResponse.json().catch(() => null)) as KugouLyricDownloadResponse | null;
  if (!lyricBody?.content) return null;
  if (lyricBody.fmt !== "lrc") return null;

  try {
    return Buffer.from(lyricBody.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}
