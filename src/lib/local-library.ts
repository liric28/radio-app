import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Song, UserTasteProfile } from "@/lib/types";

const execFileAsync = promisify(execFile);

const supportedExtensions = new Set([
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".flac",
  ".aiff",
  ".alac",
]);

export const defaultLibraryPath = "/Users/lipan/Music/Music/Media/Music";

type ProbeTags = {
  title?: string;
  artist?: string;
  album?: string;
  date?: string;
  genre?: string;
};

/**
 * 递归扫描本地音乐目录，返回可识别的音频文件路径。
 */
async function walkAudioFiles(rootDir: string, bucket: string[] = []) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      await walkAudioFiles(fullPath, bucket);
      continue;
    }

    if (supportedExtensions.has(path.extname(entry.name).toLowerCase())) {
      bucket.push(fullPath);
    }
  }

  return bucket;
}

/**
 * 用 ffprobe 读取单首音频的基础元数据。
 */
async function probeAudioFile(filePath: string) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format_tags=title,artist,album,date,genre",
    "-of",
    "json",
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as { format?: { tags?: ProbeTags } };
  return parsed.format?.tags ?? {};
}

/**
 * 根据文件名和目录信息，为首版电台补一层简单情绪标签。
 */
function inferMoodAndEnergy(filePath: string, title: string) {
  const text = `${filePath} ${title}`.toLowerCase();

  if (text.includes("dj")) {
    return { mood: "通勤", energy: 8, tags: ["动感", "DJ", "上行"] };
  }

  if (text.includes("夜") || text.includes("moon") || text.includes("晚")) {
    return { mood: "夜晚", energy: 4, tags: ["夜晚", "回忆"] };
  }

  if (text.includes("love") || text.includes("爱")) {
    return { mood: "回忆感", energy: 5, tags: ["情绪", "回忆"] };
  }

  return { mood: "回忆感", energy: 5, tags: ["个人歌单", "本地音乐库"] };
}

/**
 * 将本地音乐文件映射成当前电台可消费的曲库结构。
 */
function toSong(filePath: string, tags: ProbeTags, index: number): Song {
  const title = tags.title?.trim() || path.basename(filePath, path.extname(filePath));
  const artist =
    tags.artist?.trim() || path.basename(path.dirname(path.dirname(filePath)));
  const inferred = inferMoodAndEnergy(filePath, title);
  const year = Number.parseInt(String(tags.date ?? ""), 10) || 2024;
  const genreTags = String(tags.genre ?? "")
    .split(/[;/,，]/)
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    id: `local-${artist}-${title}-${index}`.replace(/\s+/g, "-").toLowerCase(),
    title,
    artist,
    year,
    mood: inferred.mood,
    energy: inferred.energy,
    language: /[\u4e00-\u9fa5]/.test(`${title}${artist}`) ? "中文" : "英文",
    tags: [...new Set([...inferred.tags, ...genreTags])],
    reasonSeed: "它来自你的本地音乐库，不是样例数据",
    sourcePath: filePath,
  };
}

/**
 * 扫描本地音乐库并抽取首版所需的歌曲信息。
 */
export async function scanLocalLibrary(
  rootDir = defaultLibraryPath,
  limit?: number,
) {
  const audioFiles = await walkAudioFiles(rootDir);
  const targetFiles = typeof limit === "number" ? audioFiles.slice(0, limit) : audioFiles;
  const songs: Song[] = [];

  for (const [index, filePath] of targetFiles.entries()) {
    try {
      const tags = await probeAudioFile(filePath);
      songs.push(toSong(filePath, tags, index));
    } catch {
      // 没有 ffprobe 或单文件探测失败时，退回到文件名/目录名推断，避免整批扫描失效。
      songs.push(toSong(filePath, {}, index));
    }
  }

  return songs;
}

/**
 * 从本地扫描结果中提炼一个足够实用的首版用户画像。
 */
export function deriveTasteProfileFromSongs(songs: Song[]): UserTasteProfile {
  const artistCounter = new Map<string, number>();
  const moodCounter = new Map<string, number>();
  const languageCounter = new Map<string, number>();
  const eraCounter = new Map<string, number>();

  for (const song of songs) {
    artistCounter.set(song.artist, (artistCounter.get(song.artist) ?? 0) + 1);
    moodCounter.set(song.mood, (moodCounter.get(song.mood) ?? 0) + 1);
    languageCounter.set(song.language, (languageCounter.get(song.language) ?? 0) + 1);

    const era =
      song.year < 2000
        ? "1990s 及更早"
        : song.year < 2010
          ? "2000s"
          : song.year < 2020
            ? "2010s"
            : "2020s";
    eraCounter.set(era, (eraCounter.get(era) ?? 0) + 1);
  }

  const topValues = (counter: Map<string, number>, size: number) =>
    [...counter.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, size)
      .map(([key]) => key);

  const languages = topValues(languageCounter, 2);
  const moods = topValues(moodCounter, 4);
  const artists = topValues(artistCounter, 5);
  const eras = topValues(eraCounter, 3);

  return {
    favoriteEras: eras.length > 0 ? eras : ["2010s"],
    favoriteMoods: moods.length > 0 ? moods : ["回忆感", "夜晚"],
    favoriteLanguages: languages.length > 0 ? languages : ["中文", "英文"],
    anchorArtists: artists,
    radioPersona: "那个会优先从你本地音乐库里把熟悉感捞出来的 DJ",
  };
}
