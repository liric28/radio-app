import { readDailySchedule } from "@/lib/daily-schedule";
import { readMemory } from "@/lib/memory";
import { readPreferenceModel, type PreferenceModel } from "@/lib/preference-learning";
import {
  readMoodRules,
  readPlaylistProfiles,
  readRoutineProfiles,
  readSongCatalog,
  readTasteProfile,
} from "@/lib/profile";
import { searchSongsBySource, type MusicSearchHit, type MusicSearchSource } from "@/lib/music-search";
import { resolvePlaybackUrlForHit, extractMusicInfo } from "@/lib/song-download";
import { scriptVM } from "@/lib/script-vm";
import type { ClaudioTrack } from "@/lib/claudio/types";
import type { Song } from "@/lib/types";

const DEFAULT_SOURCE = (process.env.CLAUDIO_LIVE_MUSIC_SOURCE || "qq") as MusicSearchSource;
const DEFAULT_COUNT = Number(process.env.CLAUDIO_LIVE_TRACK_COUNT || 6);
const SEARCH_PAGE_SIZE = 8;
const MIN_EVENTS_FOR_STRONG_LEARNING = 12;

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

function topModelKey(map: Record<string, number>) {
  return Object.entries(map)
    .sort((left, right) => right[1] - left[1])
    .map(([key]) => key)
    .find(Boolean);
}

function topSceneModelKey(map: Record<string, Record<string, number>>, scene: string) {
  return topModelKey(map[scene] || {});
}

function learningConfidence(model: PreferenceModel) {
  return Math.max(0, Math.min(1, model.totalEvents / MIN_EVENTS_FOR_STRONG_LEARNING));
}

function scenePreferenceScore(
  map: Record<string, Record<string, number>>,
  scene: string,
  key: string | undefined,
) {
  const normalized = String(key || "").trim();
  if (!normalized) return 0;
  return map[scene]?.[normalized] || 0;
}

function inferLanguage(title: string, artist: string) {
  const text = `${title}${artist}`;
  if (/[\u3040-\u30ff]/.test(text)) return "日语";
  if (/[\uac00-\ud7af]/.test(text)) return "韩语";
  if (/[a-z]/i.test(text) && !/[\u4e00-\u9fff]/.test(text)) return "英语";
  return "中文";
}

function buildExplorationMode(model: PreferenceModel, scene: string) {
  const confidence = learningConfidence(model);
  if (confidence < 0.35) return { confidence, mode: "wide" as const, sceneTag: topSceneModelKey(model.tagAffinityByScene, scene) };
  if (confidence < 0.7) return { confidence, mode: "balanced" as const, sceneTag: topSceneModelKey(model.tagAffinityByScene, scene) };
  return { confidence, mode: "focused" as const, sceneTag: topSceneModelKey(model.tagAffinityByScene, scene) };
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
  const [taste, routines, playlists, moodRules, memory, schedule, songs, model] = await Promise.all([
    readTasteProfile(),
    readRoutineProfiles(),
    readPlaylistProfiles(),
    readMoodRules(),
    readMemory(),
    readDailySchedule().catch(() => null),
    readSongCatalog().catch(() => []),
    readPreferenceModel().catch(() => null),
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
  const preferenceModel = model || {
    totalEvents: 0,
    artistAffinity: {},
    artistAffinityByScene: {},
    languageAffinity: {},
    languageAffinityByScene: {},
    tagAffinity: {},
    tagAffinityByScene: {},
    energyPreferenceByScene: {},
    negativeSignals: {},
    negativeSignalsByScene: {},
    requestPatternStats: {},
    updatedAt: "",
  } satisfies PreferenceModel;
  const exploration = buildExplorationMode(preferenceModel, scene);
  const currentBlock = schedule?.blocks.find((block) => block.period === schedule.currentBlockPeriod);
  const recentTrackTitles = topUnique(memory.recentTrackIds, 4);
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
  const learnedArtist = topSceneModelKey(preferenceModel.artistAffinityByScene, scene) || topModelKey(preferenceModel.artistAffinity);
  const learnedLanguage = topSceneModelKey(preferenceModel.languageAffinityByScene, scene) || topModelKey(preferenceModel.languageAffinity);
  const learnedTag = exploration.sceneTag || topModelKey(preferenceModel.tagAffinity);
  const exploratoryKeywords = exploration.mode !== "focused"
    ? topUnique(
        [
          `${learnedLanguage || taste.favoriteLanguages[0] || "中文"} 小众 ${scene}`,
          `${learnedLanguage || taste.favoriteLanguages[0] || "中文"} 冷门 ${learnedTag || currentRoutine?.preferredMoods?.[0] || scene}`,
        ],
        3,
      )
    : [];
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
    learnedArtist,
    learnedLanguage ? compactText(`${learnedLanguage} ${scene}`) : "",
    learnedTag ? compactText(`${learnedTag} ${scene}`) : "",
    ...exploratoryKeywords,
    ...ruleKeywords,
    ...memoryKeywords,
    ...scheduleKeywords,
    ...recentTrackTitles,
  ].filter((value): value is string => Boolean(value));

  return {
    queries: [...new Set(seeds)],
    scene,
    model: preferenceModel,
    explorationMode: exploration.mode,
  };
}

async function collectHits(
  queries: string[],
  source: MusicSearchSource,
  excludeKeys: Set<string>,
  wanted: number,
  scene: string,
  model: PreferenceModel,
) {
  const hits: MusicSearchHit[] = [];
  const primaryQuery = compactText(queries[0] || "").toLowerCase();
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
  const confidence = learningConfidence(model);
  return hits.sort((left, right) => {
    const leftHaystack = `${left.title} ${left.artist} ${left.albumName || ""}`.toLowerCase();
    const rightHaystack = `${right.title} ${right.artist} ${right.albumName || ""}`.toLowerCase();
    const leftIntentScore = primaryQuery && leftHaystack.includes(primaryQuery) ? 8 : 0;
    const rightIntentScore = primaryQuery && rightHaystack.includes(primaryQuery) ? 8 : 0;
    const leftLanguage = inferLanguage(left.title, left.artist);
    const rightLanguage = inferLanguage(right.title, right.artist);
    const leftScore =
      leftIntentScore +
      (model.artistAffinity[left.artist] || 0) +
      (model.languageAffinity[leftLanguage] || 0) +
      scenePreferenceScore(model.artistAffinityByScene, scene, left.artist) * 1.5 +
      scenePreferenceScore(model.languageAffinityByScene, scene, leftLanguage) +
      scenePreferenceScore(model.tagAffinityByScene, scene, left.source) * 0.4;
    const rightScore =
      rightIntentScore +
      (model.artistAffinity[right.artist] || 0) +
      (model.languageAffinity[rightLanguage] || 0) +
      scenePreferenceScore(model.artistAffinityByScene, scene, right.artist) * 1.5 +
      scenePreferenceScore(model.languageAffinityByScene, scene, rightLanguage) +
      scenePreferenceScore(model.tagAffinityByScene, scene, right.source) * 0.4;
    return rightScore * Math.max(0.2, confidence) - leftScore * Math.max(0.2, confidence);
  });
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

/**
 * 尝试通过 scriptVM 获取 lyric URL
 */
async function tryScriptLyricUrl(hit: MusicSearchHit): Promise<string | null> {
  if (!scriptVM.isLoaded) return null;
  const musicInfo = extractMusicInfo(hit);
  const lyricResult = await scriptVM.resolve({
    source: hit.source,
    action: "lyric",
    info: { type: "320k", musicInfo },
  });
  if (!lyricResult) return null;
  // lyricResult 是 JSON 字符串，存储到 data/lyrics/ 目录
  return lyricResult; // 前端/后端共同协议：lyricResult 直接是 JSON 字符串
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
  const { queries, scene, model, explorationMode } = await buildSeedQueries(input);
  const songs = await readSongCatalog().catch(() => []);
  const hits = await collectHits(queries, searchSource, excludeKeys, count, scene, model);
  const tracks: ClaudioTrack[] = [];

  // live 组歌顺序：
  // 1. 在线搜候选
  // 2. 本地库里找同歌，命中则优先播本地
  // 3. 本地没有才尝试远端直链
  // 4. 远端直链必须验活通过，否则直接丢弃
  // 5. 如果 scriptVM 声明了 lyric action，顺带拿 lyric
  for (const hit of hits) {
    if (tracks.length >= count) break;
    const localSong = findLocalMatch(hit, songs);
    let streamUrl = "";
    let lyricUrl: string | null = null;

    if (localSong?.sourcePath) {
      streamUrl = `/api/audio?path=${encodeURIComponent(localSong.sourcePath)}&libraryRoot=${encodeURIComponent(localSong.libraryRoot || "")}`;
    } else {
      const remoteUrl = await resolvePlaybackUrlForHit(hit).catch(() => null);
      if (!remoteUrl) continue;
      const playable = await verifyPlaybackUrl(remoteUrl).catch(() => false);
      if (!playable) continue;
      streamUrl = remoteUrl;
      // 远端歌曲，尝试从 scriptVM 获取 lyric
      lyricUrl = await tryScriptLyricUrl(hit).catch(() => null);
    }

    tracks.push({
      query: `${hit.title}${hit.artist ? ` - ${hit.artist}` : ""}`,
      title: hit.title,
      artist: hit.artist,
      streamUrl,
      scene,
      lyricUrl,
      sourceSong: localSong,
    });
  }

  return {
    tracks,
    searchSource,
    sessionTitle: compactText(`Live · ${queries[0] || "Online Mix"}`),
    reason: compactText(`${queries[0] || "online-live"} · ${scene || "live"} · ${explorationMode}`),
  };
}
