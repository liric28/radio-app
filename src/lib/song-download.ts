import { promises as fs, createWriteStream } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { addAllowedAudioRoot } from "@/lib/audio-roots";
import { buildSongFromFile } from "@/lib/local-library";
import { getLyricText, getPlaybackUrl, type KugouSearchHit } from "@/lib/kugou";
import { readSongCatalog, writeSongCatalog } from "@/lib/profile";
import { ensureScriptVMLoaded, scriptVM } from "@/lib/script-vm";
import type { MusicSearchHit, NeteaseSearchHit, QQSearchHit } from "@/lib/music-search";
import type { Song } from "@/lib/types";

const execFileAsync = promisify(execFile);

const DOWNLOAD_DIR = path.join("data", "downloads");
const DOWNLOAD_ROOT = process.cwd();
const TEMP_SOURCE_ENDPOINT = "http://ts.tempmusics.tk";

export type DownloadResult = {
  song: Song;
  filePath: string;
  alreadyExists: boolean;
};

export class SongDownloadError extends Error {
  constructor(
    message: string,
    public code:
      | "PAID_NO_URL"
      | "FETCH_FAILED"
      | "WRITE_FAILED"
      | "INVALID_HIT",
  ) {
    super(message);
    this.name = "SongDownloadError";
  }
}

type RemoteTrackMetadata = {
  key: string;
  songId: string;
  source: NonNullable<Song["source"]>;
  title: string;
  artist: string;
  album?: string;
  imageUrl?: string | null;
  preferredStem: string;
  secondaryStem: string;
};

async function ensureDownloadDir() {
  await fs.mkdir(absPath(DOWNLOAD_DIR), { recursive: true });
}

async function writeSidecarIfPresent(filePath: string, nextExt: string, content: string | null) {
  if (!content?.trim()) return null;
  const sidecarPath = filePath.replace(/\.mp3$/i, nextExt);
  await fs.writeFile(sidecarPath, content, "utf8");
  return sidecarPath;
}

async function downloadCoverIfPresent(filePath: string, imageUrl: string | null | undefined) {
  if (!imageUrl) return null;
  const response = await fetch(imageUrl, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.kugou.com/" },
    signal: AbortSignal.timeout(12_000),
  }).catch(() => null);
  if (!response?.ok) return null;

  const bytes = Buffer.from(await response.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (!bytes.length) return null;

  const coverPath = filePath.replace(/\.mp3$/i, ".jpg");
  await fs.writeFile(coverPath, bytes);
  return coverPath;
}

async function writeAudioMetadata(
  filePath: string,
  metadata: { title: string; artist: string; album?: string },
  coverPath: string | null,
) {
  const taggedPath = `${filePath}.tagged.mp3`;
  const args = ["-y", "-i", filePath];

  if (coverPath) {
    args.push("-i", coverPath, "-map", "0:a", "-map", "1:v", "-c:a", "copy", "-c:v", "mjpeg");
  } else {
    args.push("-map", "0:a", "-c:a", "copy");
  }

  args.push(
    "-id3v2_version",
    "3",
    "-metadata",
    `title=${metadata.title}`,
    "-metadata",
    `artist=${metadata.artist}`,
  );

  if (metadata.album) {
    args.push("-metadata", `album=${metadata.album}`);
  }

  if (coverPath) {
    args.push("-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)");
  }

  args.push(taggedPath);

  await execFileAsync("ffmpeg", args);
  await fs.rename(taggedPath, filePath);
}

async function ensureDownloadedSongAssets(filePath: string, hit: MusicSearchHit) {
  const metadata = getTrackMetadata(hit);
  const tasks = [downloadCoverIfPresent(filePath, metadata.imageUrl).catch(() => null)];

  if (hit.source === "kugou") {
    tasks.push(getLyricText(hit.raw as KugouSearchHit).catch(() => null));
  } else {
    tasks.push(Promise.resolve(null));
  }

  const [coverPath, lyricText] = await Promise.all(tasks) as [string | null, string | null];

  if (lyricText) {
    await writeSidecarIfPresent(filePath, ".lrc", lyricText).catch(() => null);
  }

  await writeAudioMetadata(
    filePath,
    {
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album,
    },
    coverPath,
  ).catch(() => null);
}

export async function downloadAndIngestSong(hit: MusicSearchHit): Promise<DownloadResult> {
  const metadata = getTrackMetadata(hit);

  await ensureDownloadDir();

  const existingCatalog = await readSongCatalog();
  const filePath = await resolveDownloadFilePath(metadata, existingCatalog);
  const existing = existingCatalog.find(
    (song) => song.id === metadata.songId,
  );

  /**
   * 主流程：
   * 1. 先根据标题/歌手算出目标文件名，并把同 songId 的旧数字文件名迁移过来。
   * 2. 命中过往已入库记录时，只补封面/歌词/tag，不重复下载音频。
   * 3. 否则按来源取直链，流式落到 tmp，再原子 rename 为最终文件名。
   * 4. 用 buildSongFromFile 统一构造 Song，并刷新 songs.json。
   */
  if (existing && existing.sourcePath) {
    const sp = existing.sourcePath as string;
    const absExistingPath = absPath(sp);
    const exists = await fileExists(absExistingPath);
    if (exists) {
      await addAllowedAudioRoot(absPath(DOWNLOAD_DIR));
      await ensureDownloadedSongAssets(absExistingPath, hit);
      await writeSongCatalog(
        existingCatalog.map((song) =>
          song.id === existing.id ? { ...song, sourcePath: filePath } : song,
        ),
      );
      return { song: existing, filePath, alreadyExists: true };
    }
  }

  const playbackUrl = await resolvePlaybackUrlForHit(hit);
  if (!playbackUrl) {
    throw new SongDownloadError(
      "这首歌当前没有可用下载直链",
      "PAID_NO_URL",
    );
  }

  const tmpPath = `${absPath(filePath)}.tmp`;
  try {
    const response = await fetch(playbackUrl, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok || !response.body) {
      throw new Error(`status=${response.status}`);
    }
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(tmpPath),
    );
    await fs.rename(tmpPath, absPath(filePath));
  } catch (error) {
    await fs.rm(tmpPath, { force: true });
    throw new SongDownloadError(
      `下载失败：${(error as Error).message}`,
      "FETCH_FAILED",
    );
  }

  // filePath stays absolute for fs operations and ffprobe
  const absFilePath = absPath(filePath);

  // DOWNLOAD_DIR is relative; resolve to absolute when adding to allowed roots
  const absDownloadDir = absPath(DOWNLOAD_DIR);
  await addAllowedAudioRoot(absDownloadDir);
  await ensureDownloadedSongAssets(absFilePath, hit);

  const song = await buildSongFromFile(
    absFilePath,
    existingCatalog.length,
    {
      idOverride: metadata.songId,
      source: metadata.source,
      reasonSeed: "刚从网上抓回来加进你的电台，先放一遍听听看合不合适",
    },
    {
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album,
    },
  );
  // Override to relative path so player-shell can use same libraryRoot="data" pattern as local songs
  song.sourcePath = filePath;
  song.libraryRoot = "";

  const next = [
    ...existingCatalog.filter((item) => item.id !== song.id && item.sourcePath !== song.sourcePath),
    song,
  ];
  try {
    await writeSongCatalog(next);
  } catch (error) {
    throw new SongDownloadError(
      `写入 songs.json 失败：${(error as Error).message}`,
      "WRITE_FAILED",
    );
  }

  return { song, filePath, alreadyExists: false };
}

/**
 * 从 MusicSearchHit 提取用户脚本需要的 musicInfo 字段
 */
export function extractMusicInfo(hit: MusicSearchHit): {
  songmid?: string;
  songId?: number | string;
  hash?: string;
  name?: string;
  singer?: string;
  album?: string;
  duration?: number;
} {
  switch (hit.source) {
    case "qq": {
      const raw = hit.raw as QQSearchHit;
      return {
        songmid: raw.songmid,
        name: hit.title,
        singer: hit.artist,
        album: hit.albumName,
        duration: hit.duration,
      };
    }
    case "netease": {
      const raw = hit.raw as NeteaseSearchHit;
      return {
        songId: raw.songId,
        name: hit.title,
        singer: hit.artist,
        album: hit.albumName,
        duration: hit.duration,
      };
    }
    case "kugou":
    default: {
      const raw = hit.raw as KugouSearchHit;
      return {
        hash: raw.hash,
        name: hit.title,
        singer: hit.artist,
        album: hit.albumName,
        duration: hit.duration,
      };
    }
  }
}

function getTrackMetadata(hit: MusicSearchHit): RemoteTrackMetadata {
  switch (hit.source) {
    case "qq": {
      const raw = hit.raw as QQSearchHit;
      if (!raw.songmid) {
        throw new SongDownloadError("QQ 音乐结果缺少 songmid", "INVALID_HIT");
      }
      return {
        key: `qq-${raw.songmid}`,
        songId: `qq-${raw.songmid}`,
        source: "qq",
        title: hit.title,
        artist: hit.artist,
        album: hit.albumName?.trim() || raw.albumName?.trim() || undefined,
        imageUrl: hit.imageUrl ?? raw.imageUrl,
        preferredStem: sanitizeFileStem(hit.title),
        secondaryStem: sanitizeFileStem(`${hit.title} - ${hit.artist || "QQ 音乐"}`),
      };
    }
    case "netease": {
      const raw = hit.raw as NeteaseSearchHit;
      if (!raw.songId) {
        throw new SongDownloadError("网易云结果缺少 songId", "INVALID_HIT");
      }
      return {
        key: `netease-${raw.songId}`,
        songId: `netease-${raw.songId}`,
        source: "netease",
        title: hit.title,
        artist: hit.artist,
        album: hit.albumName?.trim() || raw.albumName?.trim() || undefined,
        imageUrl: hit.imageUrl ?? raw.imageUrl,
        preferredStem: sanitizeFileStem(hit.title),
        secondaryStem: sanitizeFileStem(`${hit.title} - ${hit.artist || "网易云"}`),
      };
    }
    case "kugou":
    default: {
      const raw = hit.raw as KugouSearchHit;
      if (!raw.audioId) {
        throw new SongDownloadError("酷狗结果缺少 audioId", "INVALID_HIT");
      }
      return {
        key: String(raw.audioId),
        songId: `kugou-${raw.audioId}`,
        source: "kugou",
        title: hit.title,
        artist: hit.artist,
        album: hit.albumName?.trim() || raw.albumName?.trim() || undefined,
        imageUrl: hit.imageUrl ?? null,
        preferredStem: sanitizeFileStem(hit.title),
        secondaryStem: sanitizeFileStem(`${hit.title} - ${hit.artist || "酷狗"}`),
      };
    }
  }
}

function absPath(relativePath: string) {
  return path.resolve(DOWNLOAD_ROOT, relativePath);
}

async function fileExistsAt(relativePath: string): Promise<boolean> {
  try {
    await fs.access(absPath(relativePath));
    return true;
  } catch {
    return false;
  }
}

async function resolveDownloadFilePath(metadata: RemoteTrackMetadata, songs: Song[]) {
  const preferredPath = path.join(DOWNLOAD_DIR, `${metadata.preferredStem}.mp3`);
  const secondaryPath = path.join(DOWNLOAD_DIR, `${metadata.secondaryStem}.mp3`);
  const legacyPath = path.join(DOWNLOAD_DIR, `${metadata.key}.mp3`);
  const existingSong = songs.find((song) => song.id === metadata.songId);

  if (existingSong?.sourcePath && await fileExistsAt(existingSong.sourcePath)) {
    const targetPath = await chooseAvailableFilePath(
      songs,
      metadata.songId,
      preferredPath,
      secondaryPath,
      existingSong.sourcePath,
    );
    if (existingSong.sourcePath !== targetPath) {
      await moveSongBundle(existingSong.sourcePath, targetPath);
    }
    return targetPath;
  }

  if (await fileExistsAt(legacyPath)) {
    const targetPath = await chooseAvailableFilePath(
      songs,
      metadata.songId,
      preferredPath,
      secondaryPath,
      legacyPath,
    );
    if (legacyPath !== targetPath) {
      await moveSongBundle(legacyPath, targetPath);
    }
    return targetPath;
  }

  return chooseAvailableFilePath(songs, metadata.songId, preferredPath, secondaryPath);
}

async function chooseAvailableFilePath(
  songs: Song[],
  songId: string,
  preferredPath: string,
  secondaryPath: string,
  currentPath?: string,
) {
  if (await isPathUsable(songs, songId, preferredPath, currentPath)) {
    return preferredPath;
  }
  if (await isPathUsable(songs, songId, secondaryPath, currentPath)) {
    return secondaryPath;
  }
  return path.join(DOWNLOAD_DIR, `${path.basename(secondaryPath, ".mp3")} (${songId}).mp3`);
}

async function isPathUsable(
  songs: Song[],
  songId: string,
  targetPath: string,
  currentPath?: string,
) {
  if (currentPath === targetPath) return true;
  const occupiedByOtherSong = songs.some(
    (song) => song.id !== songId && song.sourcePath === targetPath,
  );
  if (occupiedByOtherSong) return false;
  const exists = await fileExistsAt(targetPath);
  return !exists;
}

async function moveSongBundle(fromPath: string, toPath: string) {
  await fs.rename(absPath(fromPath), absPath(toPath));
  for (const ext of [".jpg", ".lrc"]) {
    const fromSidecar = fromPath.replace(/\.mp3$/i, ext);
    const toSidecar = toPath.replace(/\.mp3$/i, ext);
    if (await fileExistsAt(fromSidecar)) {
      await fs.rename(absPath(fromSidecar), absPath(toSidecar)).catch(() => null);
    }
  }
}

function sanitizeFileStem(value: string) {
  return (value || "untitled")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "untitled";
}

export async function resolvePlaybackUrlForHit(hit: MusicSearchHit) {
  await ensureScriptVMLoaded();

  // 优先尝试自定义源
  if (scriptVM.isLoaded) {
    const musicInfo = extractMusicInfo(hit);
    const url = await scriptVM.resolve({
      source: hit.source,
      action: "musicUrl",
      info: { type: "320k", musicInfo },
    });
    if (url) return url;
  }

  switch (hit.source) {
    case "qq": {
      const raw = hit.raw as QQSearchHit;
      return getTempSourcePlaybackUrl("tx", raw.songmid);
    }
    case "netease": {
      const raw = hit.raw as NeteaseSearchHit;
      return getTempSourcePlaybackUrl("wy", String(raw.songId));
    }
    case "kugou":
    default: {
      const raw = hit.raw as KugouSearchHit;
      if (!raw.hash) {
        throw new SongDownloadError("酷狗结果缺少 hash", "INVALID_HIT");
      }
      const playInfo = await getPlaybackUrl(raw.hash);
      return playInfo?.url ?? null;
    }
  }
}

async function getTempSourcePlaybackUrl(source: "tx" | "wy", trackId: string) {
  if (!trackId) return null;
  const response = await fetch(`${TEMP_SOURCE_ENDPOINT}/url/${source}/${trackId}/128k`, {
    headers: { "User-Agent": "Mozilla/5.0" },
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  }).catch(() => null);
  if (!response?.ok) return null;

  const body = (await response.json().catch(() => null)) as
    | { code?: number; data?: string }
    | null;
  if (!body || body.code !== 0 || !body.data) return null;
  return body.data;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
