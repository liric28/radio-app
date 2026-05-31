import { createCipheriv, createHash } from "node:crypto";
import { searchSongs, type KugouSearchHit } from "@/lib/kugou";
import { ensureScriptVMLoaded, scriptVM } from "@/lib/script-vm";

export type MusicSearchSource = "kugou" | "qq" | "netease";

export type MusicSearchHit = {
  source: MusicSearchSource;
  title: string;
  artist: string;
  duration: number;
  payable: boolean;
  downloadable: boolean;
  albumName?: string;
  imageUrl?: string | null;
  raw: KugouSearchHit | QQSearchHit | NeteaseSearchHit;
};

export type QQSearchHit = {
  source: "qq";
  songId: number;
  songmid: string;
  mediaMid: string;
  title: string;
  artist: string;
  albumName: string;
  duration: number;
  imageUrl: string | null;
};

export type NeteaseSearchHit = {
  source: "netease";
  songId: number;
  title: string;
  artist: string;
  albumName: string;
  duration: number;
  imageUrl: string | null;
};

const QQ_SEARCH_ENDPOINT = "https://u.y.qq.com/cgi-bin/musics.fcg";
const NETEASE_SEARCH_ENDPOINT = "http://interface.music.163.com/eapi/batch";
const NETEASE_EAPI_KEY = "e82ckenh8dichen8";

const QQ_PART_1_INDEXES = [23, 14, 6, 36, 16, 40, 7, 19];
const QQ_PART_2_INDEXES = [16, 1, 32, 12, 19, 27, 8, 5];
const QQ_SCRAMBLE_VALUES = [
  89, 39, 179, 150, 218, 82, 58, 252, 177, 52,
  186, 123, 120, 64, 242, 133, 143, 161, 121, 179,
];

type QQSearchResponse = {
  code?: number;
  req?: {
    code?: number;
    data?: {
      body?: {
        item_song?: Array<{
          id?: number;
          mid?: string;
          title?: string;
          interval?: number;
          singer?: Array<{ name?: string; mid?: string }>;
          album?: { name?: string; mid?: string };
          file?: { media_mid?: string };
        }>;
      };
    };
  };
};

type NeteaseSearchResponse = {
  code?: number;
  data?: {
    totalCount?: number;
    resources?: Array<{
      baseInfo?: {
        simpleSongData?: {
          id?: number;
          name?: string;
          dt?: number;
          ar?: Array<{ name?: string }>;
          al?: { name?: string; picUrl?: string };
        };
      };
    }>;
  };
};

export async function searchSongsBySource(
  keyword: string,
  source: MusicSearchSource,
  page = 1,
  limit = 20,
): Promise<MusicSearchHit[]> {
  await ensureScriptVMLoaded();
  switch (source) {
    case "qq":
      return searchQQSongs(keyword, page, limit);
    case "netease":
      return searchNeteaseSongs(keyword, page, limit);
    case "kugou":
    default:
      return searchKugouSongs(keyword, page, limit);
  }
}

function isCustomSourceDownloadable(source: MusicSearchSource) {
  return scriptVM.canResolve(source, "musicUrl");
}

export function asKugouDownloadHit(hit: MusicSearchHit): KugouSearchHit | null {
  return hit.source === "kugou" ? (hit.raw as KugouSearchHit) : null;
}

async function searchKugouSongs(
  keyword: string,
  page: number,
  limit: number,
): Promise<MusicSearchHit[]> {
  const hits = await searchSongs(keyword, page, limit);
  const customDownloadable = isCustomSourceDownloadable("kugou");
  return hits.map((hit) => ({
    source: "kugou",
    title: hit.title,
    artist: hit.artist,
    duration: hit.duration,
    payable: hit.payable,
    downloadable: hit.payable || customDownloadable,
    albumName: hit.albumName,
    imageUrl: materializeKugouImage(hit.imageTemplate),
    raw: hit,
  }));
}

async function searchQQSongs(
  keyword: string,
  page: number,
  limit: number,
): Promise<MusicSearchHit[]> {
  const payload = {
    comm: {
      ct: "11",
      cv: "14090508",
      v: "14090508",
      tmeAppID: "qqmusic",
      phonetype: "EBG-AN10",
      deviceScore: "553.47",
      devicelevel: "50",
      newdevicelevel: "20",
      rom: "HuaWei/EMOTION/EmotionUI_14.2.0",
      os_ver: "12",
      OpenUDID: "0",
      OpenUDID2: "0",
      QIMEI36: "0",
      udid: "0",
      chid: "0",
      aid: "0",
      oaid: "0",
      taid: "0",
      tid: "0",
      wid: "0",
      uid: "0",
      sid: "0",
      modeSwitch: "6",
      teenMode: "0",
      ui_mode: "2",
      nettype: "1020",
      v4ip: "",
    },
    req: {
      module: "music.search.SearchCgiService",
      method: "DoSearchForQQMusicMobile",
      param: {
        search_type: 0,
        searchid: Math.random().toString().slice(2),
        query: keyword,
        page_num: page,
        num_per_page: limit,
        highlight: 0,
        nqc_flag: 0,
        multi_zhida: 0,
        cat: 2,
        grp: 1,
        sin: 0,
        sem: 0,
      },
    },
  };

  const text = JSON.stringify(payload);
  const response = await fetch(`${QQ_SEARCH_ENDPOINT}?sign=${createQQSign(text)}`, {
    method: "POST",
    headers: {
      "User-Agent": "QQMusic 14090508(android 12)",
      "Content-Type": "application/json",
    },
    body: text,
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  }).catch(() => null);

  if (!response?.ok) return [];

  const body = (await response.json().catch(() => null)) as QQSearchResponse | null;
  if (!body || body.code !== 0 || body.req?.code !== 0) return [];

  const items = body.req?.data?.body?.item_song ?? [];
  return items
    .filter((item) => item.file?.media_mid)
    .map<MusicSearchHit>((item) => {
      const artist = (item.singer ?? []).map((singer) => singer.name?.trim() ?? "").filter(Boolean).join("、");
      const albumMid = item.album?.mid ?? "";
      const imageUrl = albumMid
        ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`
        : item.singer?.[0]?.mid
          ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${item.singer[0].mid}.jpg`
          : null;

      const raw: QQSearchHit = {
        source: "qq",
        songId: item.id ?? 0,
        songmid: item.mid ?? "",
        mediaMid: item.file?.media_mid ?? "",
        title: item.title?.trim() ?? "",
        artist,
        albumName: item.album?.name?.trim() ?? "",
        duration: item.interval ?? 0,
        imageUrl,
      };

      return {
        source: "qq",
        title: raw.title,
        artist: raw.artist,
        duration: raw.duration,
        payable: false,
        downloadable: true,
        albumName: raw.albumName,
        imageUrl: raw.imageUrl,
        raw,
      };
    });
}

async function searchNeteaseSongs(
  keyword: string,
  page: number,
  limit: number,
): Promise<MusicSearchHit[]> {
  const body = {
    keyword,
    needCorrect: "1",
    channel: "typing",
    offset: limit * (page - 1),
    scene: "normal",
    total: page === 1,
    limit,
  };

  const response = await fetch(NETEASE_SEARCH_ENDPOINT, {
    method: "POST",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36",
      Origin: "https://music.163.com",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(createNeteaseEapiForm("/api/search/song/list/page", body)),
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  }).catch(() => null);

  if (!response?.ok) return [];

  const result = (await response.json().catch(() => null)) as NeteaseSearchResponse | null;
  if (!result || result.code !== 200) return [];

  const items = result.data?.resources ?? [];
  const hits: MusicSearchHit[] = [];

  for (const item of items) {
    const song = item.baseInfo?.simpleSongData;
    if (!song) continue;

      const artist = (song.ar ?? []).map((item) => item.name?.trim() ?? "").filter(Boolean).join("、");
      const raw: NeteaseSearchHit = {
        source: "netease",
        songId: song.id ?? 0,
        title: song.name?.trim() ?? "",
        artist,
        albumName: song.al?.name?.trim() ?? "",
        duration: Math.floor((song.dt ?? 0) / 1000),
        imageUrl: song.al?.picUrl ?? null,
      };
      hits.push({
        source: "netease",
        title: raw.title,
        artist: raw.artist,
        duration: raw.duration,
        payable: false,
        downloadable: true,
        albumName: raw.albumName,
        imageUrl: raw.imageUrl,
        raw,
      });
  }

  return hits;
}

function materializeKugouImage(template: string | null) {
  if (!template) return null;
  return template.replace("{size}", "240");
}

function createQQSign(text: string) {
  const hash = createHash("sha1").update(text).digest("hex");
  const part1 = QQ_PART_1_INDEXES.map((index) => hash[index]).join("");
  const part2 = QQ_PART_2_INDEXES.map((index) => hash[index]).join("");
  const part3 = QQ_SCRAMBLE_VALUES.map(
    (value, index) => value ^ Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16),
  );
  const middle = Buffer.from(part3)
    .toString("base64")
    .replace(/[\\/+=]/g, "");
  return `zzc${part1}${middle}${part2}`.toLowerCase();
}

function createNeteaseEapiForm(url: string, payload: unknown) {
  const text = JSON.stringify(payload);
  const digest = createHash("md5")
    .update(`nobody${url}use${text}md5forencrypt`)
    .digest("hex");
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  const encrypted = encryptNeteaseEapi(data);
  return { params: encrypted };
}

function encryptNeteaseEapi(text: string) {
  const cipher = createCipheriv("aes-128-ecb", NETEASE_EAPI_KEY, "");
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(Buffer.from(text)), cipher.final()])
    .toString("hex")
    .toUpperCase();
}
