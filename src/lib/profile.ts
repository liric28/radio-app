import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  MoodRule,
  PlaylistProfile,
  RoutineProfile,
  Song,
  SongImportItem,
  UserTasteProfile,
} from "./types";
import { dataDir } from "./paths";

/**
 * 读取 JSON 文件并解析为指定类型。
 */
async function readJsonFile<T>(fileName: string): Promise<T> {
  const fullPath = path.join(dataDir, fileName);
  const content = await fs.readFile(fullPath, "utf8");
  return JSON.parse(content) as T;
}

/**
 * 读取用户口味画像。
 */
export async function readTasteProfile() {
  return readJsonFile<UserTasteProfile>("taste.json");
}

/**
 * 将新的口味画像写回本地，供后续推荐直接使用。
 */
export async function writeTasteProfile(profile: UserTasteProfile) {
  const fullPath = path.join(dataDir, "taste.json");
  await fs.writeFile(fullPath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
}

/**
 * 读取歌单摘要，供节目命名与解释引用。
 */
export async function readPlaylistProfiles() {
  return readJsonFile<PlaylistProfile[]>("playlists.json");
}

/**
 * 读取日常节律，帮助首版根据时段匹配场景。
 */
export async function readRoutineProfiles() {
  return readJsonFile<RoutineProfile[]>("routines.json");
}

/**
 * 读取情绪规则，用于用户反馈后的调节。
 */
export async function readMoodRules() {
  return readJsonFile<MoodRule[]>("mood-rules.json");
}

/**
 * 读取本地样例曲库，作为第一版推荐候选集合。
 */
export async function readSongCatalog() {
  return readJsonFile<Song[]>("songs.json");
}

/**
 * 将新的歌曲目录写回本地曲库文件。
 */
export async function writeSongCatalog(songs: Song[]) {
  const fullPath = path.join(dataDir, "songs.json");
  await fs.writeFile(fullPath, `${JSON.stringify(songs, null, 2)}\n`, "utf8");
}

/**
 * 把外部导入数据归一化为首版电台可消费的曲库结构。
 */
export function normalizeImportedSongs(items: SongImportItem[]) {
  return items
    .filter((item) => item.title && item.artist)
    .map((item, index) => {
      const title = item.title.trim();
      const artist = item.artist.trim();
      const year =
        typeof item.year === "number"
          ? item.year
          : Number.parseInt(String(item.year ?? "2024"), 10) || 2024;
      const mood = item.mood?.trim() || "回忆感";
      const energy =
        typeof item.energy === "number"
          ? item.energy
          : Number.parseInt(String(item.energy ?? "5"), 10) || 5;
      const tags = Array.isArray(item.tags)
        ? item.tags
        : String(item.tags ?? "")
            .split(/[|,，]/)
            .map((tag) => tag.trim())
            .filter(Boolean);

      return {
        id: `imported-${artist}-${title}-${index}`
          .replace(/\s+/g, "-")
          .toLowerCase(),
        title,
        artist,
        year,
        mood,
        energy: Math.max(1, Math.min(9, energy)),
        language: item.language?.trim() || "中文",
        tags: tags.length > 0 ? tags : ["导入", "个人歌单"],
        reasonSeed:
          item.reasonSeed?.trim() || "它来自你亲手导入的真实歌单片段",
      } satisfies Song;
    });
}
