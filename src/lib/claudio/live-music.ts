import { readDailySchedule } from "@/lib/daily-schedule";
import { readMemory } from "@/lib/memory";
import {
  readMoodRules,
  readPlaylistProfiles,
  readRoutineProfiles,
  readSongCatalog,
  readTasteProfile,
} from "@/lib/profile";
import { searchSongsBySource, type MusicSearchHit, type MusicSearchSource } from "@/lib/music-search";
import { resolvePlaybackUrlForHit } from "@/lib/song-download";
import type { ClaudioTrack } from "@/lib/claudio/types";
import type { Song } from "@/lib/types";

const DEFAULT_SOURCE = (process.env.CLAUDIO_LIVE_MUSIC_SOURCE || "kugou") as MusicSearchSource;
const DEFAULT_COUNT = Number(process.env.CLAUDIO_LIVE_TRACK_COUNT || 6);
const SEARCH_PAGE_SIZE = 8;

function normalizeSource(value: string | undefined): MusicSearchSource {
  if (value === "qq" || value === "netease" || value === "kugou") return value;
  return "kugou";
}

function compactText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function topUnique(values: Array<string | undefined>, limit: number) {
  return [...new Set(values.map((value) => compactText(value || "")).filter(Boolean))].slice(0, limit);
}

function buildTrackKey(track: { title?: string; artist?: string }) {
  return `${track.title || ""}__${track.artist || ""}`.toLowerCase();
}

function normalizeName(value: string | undefined) {
  return (value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()（）\[\]【】\-_.·,，/\\]+/g, "");
}

function findLocalMatch(hit: MusicSearchHit, songs: Song[]) {
  const targetTitle = normalizeName(hit.title);
  const targetArtist = normalizeName(hit.artist);

  // live 搜到的歌如果本地已有同名同艺人的文件，就优先复用本地；
  // 这里故意保持严格匹配，避免把“相似歌名”的别版本误当成命中。
  return songs.find((song) => {
    if (!song.sourcePath) return false;
    const songTitle = normalizeName(song.title);
    const songArtist = normalizeName(song.artist);
    if (!songTitle || !songArtist) return false;
    return songTitle === targetTitle && songArtist === targetArtist;
  });
}

async function buildSeedQueries(input: string) {
  const [taste, routines, playlists, moodRules, memory, schedule, songs] = await Promise.all([
    readTasteProfile(),
    readRoutineProfiles(),
    readPlaylistProfiles(),
    readMoodRules(),
    readMemory(),
    readDailySchedule().catch(() => null),
    readSongCatalog().catch(() => []),
  ]);
  const currentPeriod = (() => {
    const hour = new Date().getHours();
    if (hour < 9) return "morning";
    if (hour < 18) return "daytime";
    if (hour < 23) return "evening";
    return "late-night";
  })();
  const currentRoutine = routines.find((item) => item.period === currentPeriod);
  const scene = currentRoutine?.scene || "";
  const currentBlock = schedule?.blocks.find((block) => block.period === schedule.currentBlockPeriod);
  const recentTitleMap = new Map(songs.map((song) => [song.id, song.title]));
  const recentTrackTitles = topUnique(
    memory.recentTrackIds.map((id) => recentTitleMap.get(id)),
    4,
  );
  const playlistKeywords = topUnique(
    playlists.flatMap((playlist) => [playlist.name, playlist.summary, ...(playlist.tags || [])]),
    6,
  );
  const ruleKeywords = topUnique(
    moodRules.flatMap((rule) => [rule.trigger, rule.shiftTo, ...(rule.avoid || [])]),
    6,
  );
  const scheduleKeywords = topUnique(
    [
      currentBlock?.scene,
      currentBlock?.title,
      ...(currentBlock?.tracks.slice(0, 4).flatMap((track) => [track.title, track.artist, track.mood]) || []),
    ],
    8,
  );
  const memoryKeywords = topUnique(
    [
      memory.lastAction,
      ...memory.recentProgramTitles.slice(-3),
      memory.feedbackBias.fresh > memory.feedbackBias.familiar ? "fresh" : "",
      memory.feedbackBias.familiar > memory.feedbackBias.fresh ? "familiar" : "",
      memory.feedbackBias.calmer > 0 ? "calmer" : "",
    ],
    6,
  );
  const routineKeywords = topUnique(
    [scene, ...(currentRoutine?.preferredMoods || [])],
    5,
  );
  // 把电台现有风格配置压成一组短 seed：
  // 画像 / 时段 / 播单摘要 / 最近反馈 / 当前 block / 最近听过的歌名。
  // 这些只负责“扩大搜歌范围”，真正入队还要经过本地优先和可播校验。
  const seeds = [
    compactText(input),
    ...taste.anchorArtists.slice(0, 4),
    ...taste.favoriteMoods.slice(0, 3).map((mood) => compactText(`${mood} ${scene}`)),
    ...taste.favoriteLanguages.slice(0, 2).map((language) => compactText(`${language} ${scene}`)),
    ...playlistKeywords,
    ...routineKeywords,
    ...ruleKeywords,
    ...memoryKeywords,
    ...scheduleKeywords,
    ...recentTrackTitles,
  ].filter(Boolean);

  return [...new Set(seeds)];
}

async function collectHits(
  queries: string[],
  source: MusicSearchSource,
  excludeKeys: Set<string>,
  wanted: number,
) {
  const hits: MusicSearchHit[] = [];
  // 先按多组 seed 拉宽候选池，后面再筛掉重复、不可播和本地未命中的远端坏链。
  for (const query of queries) {
    if (hits.length >= wanted * 3) break;
    const result = await searchSongsBySource(query, source, 1, SEARCH_PAGE_SIZE).catch(() => []);
    for (const hit of result) {
      const key = buildTrackKey(hit);
      if (excludeKeys.has(key)) continue;
      excludeKeys.add(key);
      hits.push(hit);
      if (hits.length >= wanted * 3) break;
    }
  }
  return hits;
}

async function verifyPlaybackUrl(url: string) {
  // 有些来源的直链不稳定，先 HEAD，失败再用最小 Range GET 探测。
  // 只有确认这条 URL 真能出音频数据，live 才会把它加入队列。
  const head = await fetch(url, {
    method: "HEAD",
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);

  if (head?.ok) return true;

  const probe = await fetch(url, {
    method: "GET",
    headers: {
      Range: "bytes=0-0",
    },
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);

  return probe?.ok || probe?.status === 206;
}

export async function buildOnlineClaudioTracks({
  input,
  count = DEFAULT_COUNT,
  exclude = [],
  source = DEFAULT_SOURCE,
}: {
  input: string;
  count?: number;
  exclude?: Array<{ title?: string; artist?: string }>;
  source?: string;
}) {
  const excludeKeys = new Set(exclude.map((item) => buildTrackKey(item)));
  const searchSource = normalizeSource(source);
  const queries = await buildSeedQueries(input);
  const songs = await readSongCatalog().catch(() => []);
  const hits = await collectHits(queries, searchSource, excludeKeys, count);
  const tracks: ClaudioTrack[] = [];

  // live 组歌顺序：
  // 1. 在线搜候选
  // 2. 本地库里找同歌，命中则优先播本地
  // 3. 本地没有才尝试远端直链
  // 4. 远端直链必须验活通过，否则直接丢弃
  for (const hit of hits) {
    if (tracks.length >= count) break;
    const localSong = findLocalMatch(hit, songs);
    let streamUrl = "";

    if (localSong?.sourcePath) {
      streamUrl = `/api/audio?path=${encodeURIComponent(localSong.sourcePath)}`;
    } else {
      const remoteUrl = await resolvePlaybackUrlForHit(hit).catch(() => null);
      if (!remoteUrl) continue;
      const playable = await verifyPlaybackUrl(remoteUrl).catch(() => false);
      if (!playable) continue;
      streamUrl = remoteUrl;
    }

    tracks.push({
      query: `${hit.title}${hit.artist ? ` - ${hit.artist}` : ""}`,
      title: hit.title,
      artist: hit.artist,
      streamUrl,
      sourceSong: localSong,
    });
  }

  return {
    tracks,
    searchSource,
    sessionTitle: compactText(`Live · ${queries[0] || "Online Mix"}`),
    reason: queries[0] || "online-live",
  };
}
