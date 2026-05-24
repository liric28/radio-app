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
 * Exported 后供下载路径（song-download.ts）复用，下载完的 mp3 也走同一份 tag 提取，
 * 保证本地扫描和网络下载入库的字段结构、解析行为一致。
 */
export async function probeAudioFile(filePath: string): Promise<ProbeTags> {
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
 * 从文件 path + tag 元数据构造一个 Song。
 *
 * options 让两条入库路径共用同一函数：
 *   - 本地扫描 (scanLocalLibrary)：默认参数即可，id 形如 `local-{artist}-{title}-{index}`
 *   - 网络下载 (song-download.ts)：传入 idOverride（用稳定的 kugou audioId）+ source: "kugou" + reasonSeed
 */
function toSong(
  filePath: string,
  tags: ProbeTags,
  index: number,
  options: { idOverride?: string; source?: Song["source"]; reasonSeed?: string } = {},
): Song {
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
    id:
      options.idOverride ??
      `local-${artist}-${title}-${index}`.replace(/\s+/g, "-").toLowerCase(),
    title,
    artist,
    year,
    mood: inferred.mood,
    energy: inferred.energy,
    language: /[\u4e00-\u9fa5]/.test(`${title}${artist}`) ? "中文" : "英文",
    tags: [...new Set([...inferred.tags, ...genreTags])],
    reasonSeed: options.reasonSeed ?? "它来自你的本地音乐库，不是样例数据",
    sourcePath: filePath,
    source: options.source ?? "local",
  };
}

/**
 * 统一入口：拿到本地文件路径 → ffprobe → 构造 Song。
 * scanLocalLibrary 和 song-download.ts 都走这个函数，行为一致。
 *
 * @param knownTags 已知 tag（如网络下载时酷狗搜索结果给的 title/artist），优先级高于 ffprobe 探测值
 */
export async function buildSongFromFile(
  filePath: string,
  index: number,
  options: { idOverride?: string; source?: Song["source"]; reasonSeed?: string } = {},
  knownTags: ProbeTags = {},
): Promise<Song> {
  let probedTags: ProbeTags = {};
  try {
    probedTags = await probeAudioFile(filePath);
  } catch {
    // ffprobe 缺失 / 单文件读取失败 → 走纯文件名+目录名推断
  }
  const tags: ProbeTags = { ...probedTags, ...knownTags };
  return toSong(filePath, tags, index, options);
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
    // buildSongFromFile 内部已 try/catch ffprobe，无需在这里再包一层
    songs.push(await buildSongFromFile(filePath, index));
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
