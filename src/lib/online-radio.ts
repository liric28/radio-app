import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildLiveStartIntentPrompt } from "@/lib/claudio/context";
import { generateClaudioStartIntent } from "@/lib/claudio/llm";
import { readMemory, writeMemory } from "@/lib/memory";
import { searchSongsBySource, type MusicSearchHit, type MusicSearchSource } from "@/lib/music-search";
import { dataDir } from "@/lib/paths";
import { appendPreferenceEvent, preferenceTrackFromSong, readPreferenceModel, type PreferenceModel } from "@/lib/preference-learning";
import { readPlaylistProfiles, readRoutineProfiles, readSongCatalog, readTasteProfile } from "@/lib/profile";
import { batchRewriteTrackReasons, composeHostIntro, summarizeReasons } from "@/lib/providers/llm";
import { resolvePlaybackUrlForHit } from "@/lib/song-download";
import { buildTrackLabel, trackLabelFromSong } from "@/lib/track-labels";
import type { ChatIntent, DailySchedule, RadioMemory, RadioProgram, RoutineProfile, Song, UserTasteProfile } from "@/lib/types";

const onlineStatePath = path.join(dataDir, "online-radio-state.json");
const DEFAULT_SOURCE = (process.env.RADIO_ONLINE_SOURCE || process.env.CLAUDIO_LIVE_MUSIC_SOURCE || "qq") as MusicSearchSource;
const DEFAULT_TRACK_COUNT = Math.max(4, Number(process.env.RADIO_ONLINE_TRACK_COUNT || 6));

type OnlineRecommendationSeed = {
  input: string;
  reason: string;
};

type OnlineRadioState = {
  date: string;
  seed: OnlineRecommendationSeed;
  source: MusicSearchSource;
  program: RadioProgram;
};

type BuildOnlineProgramOptions = {
  action?: "skip" | "fresh" | "calmer" | "familiar" | "regenerate";
  targetPeriod?: string;
  forceNew?: boolean;
  source?: MusicSearchSource;
  excludeTrackIds?: string[];
  messageHint?: string;
};

type RequestPreferences = {
  language?: "中文" | "英文" | "粤语" | "日语" | "韩语";
  energy?: "high" | "low";
  vibes: string[];
};

const MIN_EVENTS_FOR_STRONG_LEARNING = 12;

function getTodayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function resolveCurrentPeriod() {
  const hour = new Date().getHours();
  if (hour < 9) return "morning";
  if (hour < 18) return "daytime";
  if (hour < 23) return "evening";
  return "late-night";
}

function resolveRoutine(routines: RoutineProfile[], targetPeriod?: string) {
  const period = targetPeriod || resolveCurrentPeriod();
  return (
    routines.find((item) => item.period === period) ??
    routines[0] ?? {
      period,
      scene: "在线流动",
      preferredMoods: ["流动", "夜晚"],
    }
  );
}

function normalizeSource(source: string | undefined): MusicSearchSource {
  if (source === "qq" || source === "netease" || source === "kugou") return source;
  return "kugou";
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

  return songs.find((song) => {
    if (!song.sourcePath) return false;
    const songTitle = normalizeName(song.title);
    const songArtist = normalizeName(song.artist);
    return Boolean(songTitle && songArtist && songTitle === targetTitle && songArtist === targetArtist);
  });
}

function sanitizeAnchorArtists(artists: string[]) {
  return artists.filter((artist) => {
    const normalized = artist.trim().toLowerCase();
    return Boolean(
      normalized &&
      normalized !== "unknown artist" &&
      normalized !== "dj" &&
      normalized !== "various artists" &&
      normalized !== "未知艺术家",
    );
  });
}

function matchesLanguagePreference(hit: MusicSearchHit, language: RequestPreferences["language"]) {
  const text = `${hit.title}${hit.artist}`;
  if (language === "中文" || language === "粤语") return /[\u4e00-\u9fff]/.test(text);
  if (language === "日语") return /[\u3040-\u30ff]/.test(text);
  if (language === "韩语") return /[\uac00-\ud7af]/.test(text);
  if (language === "英文") return /[a-z]/i.test(text) && !/[\u4e00-\u9fff]/.test(text);
  return false;
}

function scoreOnlineHit(
  hit: MusicSearchHit,
  taste: UserTasteProfile,
  memory: RadioMemory,
  routine: RoutineProfile,
  currentSeed: string,
  preferences: RequestPreferences,
) {
  let score = 0;
  const haystack = `${hit.title} ${hit.artist} ${hit.albumName || ""}`.toLowerCase();
  const normalizedArtist = hit.artist.trim().toLowerCase();

  if (sanitizeAnchorArtists(taste.anchorArtists).some((artist) => hit.artist.includes(artist))) score += 10;
  if (preferences.language) {
    if (matchesLanguagePreference(hit, preferences.language)) score += 10;
    else score -= 6;
  } else if (taste.favoriteLanguages.some((language) => haystack.includes(language.toLowerCase()))) {
    score += 4;
  }
  if (routine.preferredMoods.some((mood) => haystack.includes(mood.toLowerCase()))) score += 4;
  if (currentSeed && haystack.includes(currentSeed.toLowerCase().slice(0, 24))) score += 3;
  if (memory.feedbackBias.calmer > memory.feedbackBias.fresh) score += Math.max(0, 8 - hit.duration / 45);
  if (memory.feedbackBias.fresh > memory.feedbackBias.calmer) score += Math.min(4, hit.duration / 90);
  if (preferences.energy === "high") score += Math.min(6, hit.duration / 35);
  if (preferences.energy === "low") score += Math.max(0, 8 - hit.duration / 40);
  if (preferences.vibes.some((item) => haystack.includes(item.toLowerCase()))) score += 5;
  if (memory.recentTrackIds.some((id) => id === buildTrackLabel(hit.title, hit.artist))) score -= 8;
  if (!hit.downloadable) score -= 2;
  if (normalizedArtist === "unknown artist" || normalizedArtist === "dj") score -= 12;

  return score;
}

function buildFallbackSeed(
  taste: UserTasteProfile,
  routine: RoutineProfile,
  memory: RadioMemory,
  action?: BuildOnlineProgramOptions["action"],
  messageHint?: string,
) {
  const language = taste.favoriteLanguages[0] || "中文";
  const mood = taste.favoriteMoods[0] || routine.preferredMoods[0] || "流动";
  const artist = taste.anchorArtists[0] || "";
  const actionHint =
    action === "calmer"
      ? "更安静、呼吸感更松"
      : action === "fresh"
        ? "更往前、更带一点新的气味"
        : action === "familiar"
          ? "更熟悉、更私人的记忆感"
          : "顺着当下的情绪慢慢展开";

  return {
    input: [messageHint?.trim(), routine.scene, language, mood, artist, actionHint].filter(Boolean).join("，"),
    reason: `最近动作是 ${memory.lastAction}，这轮想把 ${routine.scene} 拉到 ${actionHint}。`,
  };
}

function countTopValues(values: string[], limit: number) {
  const counts = new Map<string, number>();
  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([value, count]) => `${value} x${count}`);
}

function summarizeStoredLocalSongs(localSongs: string[] | undefined) {
  const labels = (localSongs || []).map((item) => item.trim()).filter(Boolean);
  const artistCounts = new Map<string, number>();

  for (const label of labels) {
    const separatorIndex = label.lastIndexOf(" - ");
    const artist = separatorIndex >= 0 ? label.slice(separatorIndex + 3).trim() : "";
    if (!artist) continue;
    artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1);
  }

  const topArtists = [...artistCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 12)
    .map(([artist, count]) => `${artist} x${count}`);

  return {
    totalSongs: labels.length,
    topArtists,
    representativeSongs: labels.slice(0, 40),
  };
}

function summarizeLocalLibrary(songs: Song[], taste: UserTasteProfile, memory: RadioMemory) {
  const recentSet = new Set(memory.recentTrackIds);
  const topArtists = countTopValues(
    songs
      .map((song) => song.artist)
      .filter((artist) => sanitizeAnchorArtists([artist]).length > 0),
    8,
  );
  const topMoods = countTopValues(songs.map((song) => song.mood), 6);
  const topLanguages = countTopValues(songs.map((song) => song.language), 4);
  const topTags = countTopValues(songs.flatMap((song) => song.tags || []), 10);
  const familiarAnchors = songs
    .filter((song) => sanitizeAnchorArtists(taste.anchorArtists).includes(song.artist) || recentSet.has(trackLabelFromSong(song)))
    .slice(0, 8)
    .map((song) => `${song.title} — ${song.artist}`);

  return {
    totalSongs: songs.length,
    topArtists,
    topMoods,
    topLanguages,
    topTags,
    familiarAnchors,
  };
}

function extractMessageHints(messageHint: string | undefined) {
  const text = (messageHint || "").trim();
  if (!text) return [];
  const normalized = text
    .replace(/[，。！？、/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const directPhrases = [
    "华语", "中文", "粤语", "英文", "英语", "日语", "韩语",
    "女声", "男声", "器乐", "电子", "摇滚", "民谣", "说唱", "爵士", "city pop",
    "安静", "轻一点", "慢一点", "深夜", "早上", "通勤", "熟悉", "新一点", "别太炸",
    "劲爆", "炸一点", "炸", "推起来", "有冲劲", "有力一点", "热一点",
  ];
  const matched = directPhrases.filter((phrase) => normalized.toLowerCase().includes(phrase.toLowerCase()));
  return [...new Set([normalized, ...matched])].slice(0, 8);
}

function parseRequestPreferences(messageHint: string | undefined): RequestPreferences {
  const text = (messageHint || "").trim().toLowerCase();
  const preferences: RequestPreferences = { vibes: extractMessageHints(messageHint).slice(0, 5) };

  if (text.includes("华语") || text.includes("中文")) preferences.language = "中文";
  else if (text.includes("粤语")) preferences.language = "粤语";
  else if (text.includes("英文") || text.includes("英语")) preferences.language = "英文";
  else if (text.includes("日语")) preferences.language = "日语";
  else if (text.includes("韩语")) preferences.language = "韩语";

  if (
    text.includes("劲爆") ||
    text.includes("炸一点") ||
    text.includes("炸") ||
    text.includes("推起来") ||
    text.includes("有冲劲") ||
    text.includes("有力一点") ||
    text.includes("热一点")
  ) {
    preferences.energy = "high";
  } else if (
    text.includes("安静") ||
    text.includes("轻一点") ||
    text.includes("慢一点") ||
    text.includes("别太炸")
  ) {
    preferences.energy = "low";
  }

  return preferences;
}

function topModelKey(map: Record<string, number>) {
  return Object.entries(map)
    .sort((left, right) => right[1] - left[1])
    .map(([key]) => key)
    .find(Boolean);
}

function learningConfidence(model: PreferenceModel) {
  return Math.max(0, Math.min(1, model.totalEvents / MIN_EVENTS_FOR_STRONG_LEARNING));
}

function explicitArtistRequest(messageHint: string | undefined, taste: UserTasteProfile) {
  const normalized = String(messageHint || "").toLowerCase();
  return sanitizeAnchorArtists(taste.anchorArtists).find((artist) =>
    normalized.includes(artist.toLowerCase()),
  );
}

async function buildRecommendationSeed(
  taste: UserTasteProfile,
  routines: RoutineProfile[],
  memory: RadioMemory,
  model: PreferenceModel,
  options: BuildOnlineProgramOptions,
): Promise<OnlineRecommendationSeed> {
  const routine = resolveRoutine(routines, options.targetPeriod);
  const songs = await readSongCatalog().catch(() => []);
  const librarySummary = summarizeLocalLibrary(songs, taste, memory);
  const storedLocalSummary = summarizeStoredLocalSongs(taste.localSongs);
  const messageHints = extractMessageHints(options.messageHint);
  const preferences = parseRequestPreferences(options.messageHint);
  const fallback = buildFallbackSeed(taste, routine, memory, options.action, options.messageHint);

  try {
    const prompt = await buildLiveStartIntentPrompt({ djLanguage: "zh" });
    const generated = await generateClaudioStartIntent(
      [
        prompt,
        "# Online Recommendation Override",
        "Do not pick songs directly from the local library, but do use the whole local library as evidence of the listener's long-term taste.",
        "Combine user request, local library distribution, explicit taste profile, recent feedback, and current routine to form one precise online music search intent.",
        "If the user explicitly asks for a language or an energy level, that request overrides default taste tendencies.",
        "Do not drift into English songs unless the user explicitly asks for English or the request is language-neutral.",
        options.messageHint ? `# User Request\n${options.messageHint}` : "",
        messageHints.length ? `# Parsed User Hints\n${messageHints.join(" | ")}` : "",
        preferences.language ? `# Forced Language\n${preferences.language}` : "",
        preferences.energy ? `# Forced Energy\n${preferences.energy}` : "",
        `# Local Library Summary\nTotal songs: ${librarySummary.totalSongs}`,
        librarySummary.topArtists.length ? `Top artists: ${librarySummary.topArtists.join(" | ")}` : "",
        librarySummary.topMoods.length ? `Top moods: ${librarySummary.topMoods.join(" | ")}` : "",
        librarySummary.topLanguages.length ? `Top languages: ${librarySummary.topLanguages.join(" | ")}` : "",
        librarySummary.topTags.length ? `Top tags: ${librarySummary.topTags.join(" | ")}` : "",
        librarySummary.familiarAnchors.length ? `Representative familiar songs:\n${librarySummary.familiarAnchors.join("\n")}` : "",
        storedLocalSummary.totalSongs ? `# Stored Local Songs In Taste Profile\nTotal songs: ${storedLocalSummary.totalSongs}` : "",
        storedLocalSummary.topArtists.length ? `Top stored local artists: ${storedLocalSummary.topArtists.join(" | ")}` : "",
        storedLocalSummary.representativeSongs.length ? `Representative stored local songs:\n${storedLocalSummary.representativeSongs.join("\n")}` : "",
        topModelKey(model.artistAffinity) ? `# Learned Top Artist\n${topModelKey(model.artistAffinity)}` : "",
        topModelKey(model.languageAffinity) ? `# Learned Top Language\n${topModelKey(model.languageAffinity)}` : "",
        Object.keys(model.requestPatternStats).length ? `# Learned Request Patterns\n${Object.entries(model.requestPatternStats).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} x${v}`).join(" | ")}` : "",
        options.action ? `Current adjustment request: ${options.action}` : "",
        options.targetPeriod ? `Target period override: ${options.targetPeriod}` : "",
      ].filter(Boolean).join("\n\n"),
    );
    const input = generated.input?.trim();
    if (!input) return fallback;
    return {
      input,
      reason: generated.reason?.trim() || fallback.reason,
    };
  } catch {
    return fallback;
  }
}

function buildSearchQueries(
  seed: OnlineRecommendationSeed,
  taste: UserTasteProfile,
  model: PreferenceModel,
  routine: RoutineProfile,
  messageHint: string | undefined,
  action?: BuildOnlineProgramOptions["action"],
) {
  const messageHints = extractMessageHints(messageHint);
  const preferences = parseRequestPreferences(messageHint);
  const confidence = learningConfidence(model);
  const preferredLanguage = preferences.language || topModelKey(model.languageAffinity) || taste.favoriteLanguages[0];
  const energyHint =
    preferences.energy === "high"
      ? "劲爆"
      : preferences.energy === "low"
        ? "安静"
        : "";
  const learnedArtist = confidence >= 0.6 ? topModelKey(model.artistAffinity) : "";
  const learnedTag = confidence >= 0.4 ? topModelKey(model.tagAffinity) : "";
  const queries = [
    seed.input,
    ...messageHints,
    [routine.scene, taste.favoriteMoods[0], preferredLanguage, energyHint].filter(Boolean).join(" "),
    [sanitizeAnchorArtists(taste.anchorArtists)[0], routine.scene].filter(Boolean).join(" "),
    [learnedArtist, routine.scene].filter(Boolean).join(" "),
    [preferredLanguage, learnedTag, routine.scene].filter(Boolean).join(" "),
    action === "calmer"
      ? [preferredLanguage, "安静", routine.scene].filter(Boolean).join(" ")
      : action === "fresh"
        ? [preferredLanguage, "新一点", routine.scene].filter(Boolean).join(" ")
        : action === "familiar"
          ? [preferredLanguage, "熟悉", routine.scene].filter(Boolean).join(" ")
          : "",
  ];

  return [...new Set(queries.map((item) => item.trim()).filter(Boolean))];
}

async function verifyPlaybackUrl(url: string) {
  const head = await fetch(url, {
    method: "HEAD",
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);

  if (head?.ok) return true;

  const probe = await fetch(url, {
    method: "GET",
    headers: { Range: "bytes=0-0" },
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);

  return probe?.ok || probe?.status === 206;
}

function buildOnlineTrackId(title: string, artist: string) {
  const digest = createHash("sha1").update(`${title}__${artist}`).digest("hex").slice(0, 12);
  return `online-${digest}`;
}

function inferLanguage(taste: UserTasteProfile, title: string, artist: string) {
  const text = `${title}${artist}`;
  if (/[\u3040-\u30ff]/.test(text)) return "日语";
  if (/[\uac00-\ud7af]/.test(text)) return "韩语";
  if (/[a-z]/i.test(text) && !/[\u4e00-\u9fff]/.test(text)) return "英语";
  return taste.favoriteLanguages[0] || "中文";
}

function inferEnergy(
  memory: RadioMemory,
  options: BuildOnlineProgramOptions,
  index: number,
) {
  const base =
    options.action === "calmer"
      ? 3
      : options.action === "fresh"
        ? 7
        : memory.feedbackBias.calmer > memory.feedbackBias.fresh
          ? 4
          : memory.feedbackBias.fresh > memory.feedbackBias.calmer
            ? 7
            : 5;
  return Math.max(1, Math.min(9, base + Math.min(index, 2)));
}

function toEnergyLabel(energy: number) {
  if (energy <= 3) return "低照度安静流";
  if (energy <= 6) return "熟悉暖调";
  return "轻推力上行";
}

function buildSegmentTitle(scene: string, seed: string) {
  return `${scene}在线电台 · ${seed}`;
}

function sanitizeSeedText(seed: string) {
  return seed
    .replace(/[“”"'《》]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 36);
}

function buildOnlineHostIntro({
  scene,
  seed,
  currentTrack,
  nextTrack,
}: {
  scene: string;
  seed: OnlineRecommendationSeed;
  currentTrack: Song & { reason: string };
  nextTrack: (Song & { reason: string }) | undefined;
}) {
  const seedText = sanitizeSeedText(seed.input);
  const hasUnknownArtist =
    currentTrack.artist.trim().toLowerCase() === "unknown artist" ||
    nextTrack?.artist.trim().toLowerCase() === "unknown artist";

  const genericTemplates = [
    `早上好，先把这条在线流轻轻推起来。前面先给一点${currentTrack.mood}，后面再把节奏顺着接开。`,
    `先别急着认歌，这一轮我想先把气口放稳。前面偏${currentTrack.mood}，后面会慢慢亮一点。`,
    `这一轮不从本地记忆里翻旧歌，直接按你现在的口味去外面抓。先听前面这首，后面我把线接顺。`,
    `先让这一轮在线推荐自己说话。前面这首把步子带起来，后面那首负责把情绪接住。`,
  ];
  const namedTemplates = [
    `早上好，先把这条在线流慢慢推起来。前面是《${currentTrack.title}》，后面会顺着接到《${nextTrack?.title || currentTrack.title}》。`,
    `这一轮我按“${seedText || scene}”往外抓了几首。先听《${currentTrack.title}》，后面那首会把节奏接得更顺。`,
    `今天先不急着解释，先让《${currentTrack.title}》把气口定住。后面那首我也给你连好了。`,
  ];

  const templates = hasUnknownArtist ? genericTemplates : [...genericTemplates, ...namedTemplates];
  return templates[Math.floor(Math.random() * templates.length)];
}

function createScheduleFromProgram(program: RadioProgram): DailySchedule {
  return {
    date: getTodayDateKey(),
    stationName: program.stationName,
    currentBlockPeriod: "online",
    currentTrackIndex: 0,
    blocks: [
      {
        period: "online",
        scene: program.scene,
        title: program.segmentTitle,
        tracks: [program.currentTrack, ...program.queue],
      },
    ],
  };
}

async function buildProgramExplanation(
  seed: OnlineRecommendationSeed,
  routine: RoutineProfile,
  tracks: Song[],
  source: MusicSearchSource,
) {
  return summarizeReasons([
    `这轮不再从本地曲库起歌，直接按 ${routine.scene} 的在线推荐意图去搜。`,
    `推荐线索是“${seed.input}”，实际落地优先保留 ${tracks.slice(0, 3).map((track) => track.artist).join("、") || "当前命中的在线艺人"} 这些锚点。`,
    `当前来源是 ${source}，本轮确认了 ${tracks.length} 首可播在线歌曲。`,
  ]);
}

async function collectRankedHits(
  queries: string[],
  source: MusicSearchSource,
  taste: UserTasteProfile,
  memory: RadioMemory,
  model: PreferenceModel,
  routine: RoutineProfile,
  seed: OnlineRecommendationSeed,
  preferences: RequestPreferences,
  excludeTrackIds: string[],
) {
  const hitMap = new Map<string, MusicSearchHit>();
  const excluded = new Set(excludeTrackIds);

  for (const query of queries) {
    const hits = await searchSongsBySource(query, source, 1, 10).catch(() => []);
    for (const hit of hits) {
      const id = buildOnlineTrackId(hit.title, hit.artist);
      if (excluded.has(id)) continue;
      const key = buildTrackKey(hit);
      if (!hitMap.has(key)) hitMap.set(key, hit);
    }
  }

  return [...hitMap.values()].sort(
    (left, right) => {
      const confidence = learningConfidence(model);
      const rightLearned =
        ((model.artistAffinity[right.artist] || 0) +
          (model.languageAffinity[matchesLanguagePreference(right, "中文") ? "中文" : "英文"] || 0)) *
        confidence;
      const leftLearned =
        ((model.artistAffinity[left.artist] || 0) +
          (model.languageAffinity[matchesLanguagePreference(left, "中文") ? "中文" : "英文"] || 0)) *
        confidence;

      return (
        scoreOnlineHit(right, taste, memory, routine, seed.input, preferences) +
        rightLearned -
        (scoreOnlineHit(left, taste, memory, routine, seed.input, preferences) + leftLearned)
      );
    },
  );
}

async function buildProgramTracks(
  hits: MusicSearchHit[],
  count: number,
  taste: UserTasteProfile,
  routine: RoutineProfile,
  memory: RadioMemory,
  options: BuildOnlineProgramOptions,
) {
  const localSongs = await readSongCatalog().catch(() => []);
  const tracks: Song[] = [];
  const artistCounts = new Map<string, number>();
  const forcedArtist = explicitArtistRequest(options.messageHint, taste);
  const maxPerArtist = forcedArtist ? count : 2;

  for (const [index, hit] of hits.entries()) {
    if (tracks.length >= count) break;
    const normalizedArtist = hit.artist.trim().toLowerCase();
    const currentArtistCount = artistCounts.get(normalizedArtist) || 0;
    if (currentArtistCount >= maxPerArtist) continue;
    const localMatch = findLocalMatch(hit, localSongs);
    let streamUrl = localMatch?.sourcePath
      ? `/api/audio?path=${encodeURIComponent(localMatch.sourcePath)}&libraryRoot=${encodeURIComponent(localMatch.libraryRoot || "")}`
      : "";

    if (!streamUrl) {
      const remoteUrl = await resolvePlaybackUrlForHit(hit).catch(() => null);
      if (!remoteUrl) continue;
      const playable = await verifyPlaybackUrl(remoteUrl).catch(() => false);
      if (!playable) continue;
      streamUrl = remoteUrl;
    }

    tracks.push({
      id: buildOnlineTrackId(hit.title, hit.artist),
      title: hit.title,
      artist: hit.artist,
      year: new Date().getFullYear(),
      mood: routine.preferredMoods[index % Math.max(routine.preferredMoods.length, 1)] || taste.favoriteMoods[0] || "流动",
      energy: inferEnergy(memory, options, index),
      language: inferLanguage(taste, hit.title, hit.artist),
      tags: ["在线推荐", routine.scene, hit.source],
      reasonSeed: `这首歌是按“${routine.scene} / ${hit.artist} / ${hit.title}”这条在线推荐线索命中的。`,
      sourcePath: localMatch?.sourcePath,
      libraryRoot: localMatch?.libraryRoot || "",
      streamUrl,
      source: localMatch?.source || hit.source,
      downloadContext: {
        source: hit.source,
        duration: hit.duration,
        payable: hit.payable,
        downloadable: hit.downloadable,
        albumName: hit.albumName,
        imageUrl: hit.imageUrl,
        raw: hit.raw,
      },
    });
    artistCounts.set(normalizedArtist, currentArtistCount + 1);
  }

  return tracks;
}

async function writeOnlineState(state: OnlineRadioState) {
  await fs.writeFile(onlineStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readOnlineState() {
  try {
    const content = await fs.readFile(onlineStatePath, "utf8");
    return JSON.parse(content) as OnlineRadioState;
  } catch {
    return null;
  }
}

async function writeProgramMemory(program: RadioProgram, lastAction: string) {
  const memory = await readMemory();
  const nextMemory = {
    ...memory,
    lastAction,
    recentTrackIds: [buildTrackLabel(program.currentTrack.title, program.currentTrack.artist), ...memory.recentTrackIds].slice(0, 12),
    recentProgramTitles: [program.segmentTitle, ...memory.recentProgramTitles].slice(0, 6),
  };
  await writeMemory(nextMemory);
  return nextMemory;
}

async function buildOnlineProgram(options: BuildOnlineProgramOptions = {}) {
  const source = normalizeSource(options.source || DEFAULT_SOURCE);
  const [taste, playlists, routines, memory] = await Promise.all([
    readTasteProfile(),
    readPlaylistProfiles(),
    readRoutineProfiles(),
    readMemory(),
  ]);
  const model = await readPreferenceModel();
  const routine = resolveRoutine(routines, options.targetPeriod);
  const seed = await buildRecommendationSeed(taste, routines, memory, model, options);
  const queries = buildSearchQueries(seed, taste, model, routine, options.messageHint, options.action);
  const preferences = parseRequestPreferences(options.messageHint);
  const hits = await collectRankedHits(
    queries,
    source,
    taste,
    memory,
    model,
    routine,
    seed,
    preferences,
    options.excludeTrackIds || [],
  );
  const tracks = await buildProgramTracks(hits, DEFAULT_TRACK_COUNT, taste, routine, memory, options);

  if (!tracks.length) {
    throw new Error("在线推荐没有找到可播放歌曲");
  }

  const reasons = await batchRewriteTrackReasons(tracks, routine.scene);
  const hydratedTracks = tracks.map((track) => ({
    ...track,
    reason: reasons.get(track.id) || track.reasonSeed,
  }));
  const [currentTrack, ...queue] = hydratedTracks;
  const hostIntro = buildOnlineHostIntro({
    scene: routine.scene,
    seed,
    currentTrack,
    nextTrack: queue[0] ?? currentTrack,
  });
  const explanation = await buildProgramExplanation(seed, routine, hydratedTracks, source);
  const playlistSummary = playlists[0]?.summary || seed.input;
  const program: RadioProgram = {
    stationName: "Claudio FM",
    segmentTitle: buildSegmentTitle(routine.scene, playlistSummary),
    scene: routine.scene,
    energyLabel: toEnergyLabel(currentTrack.energy),
    hostIntro,
    currentTrack,
    queue,
    explanation,
    controlsHint: "这条在线队列会跟着你的反馈、时段和口味继续重组。",
    memorySummary: `当前直接从在线来源抓歌；最近动作是 ${memory.lastAction}，本轮种子是“${seed.input}”。`,
  };

  await appendPreferenceEvent({
    type: "recommendation_generated",
    scene: routine.scene,
    seed: seed.input,
    source,
    message: options.messageHint,
    track: preferenceTrackFromSong(program.currentTrack, routine.scene),
    queue: [program.currentTrack, ...program.queue].map((track) => preferenceTrackFromSong(track, routine.scene)),
  }).catch(() => null);

  return { program, seed, source };
}

async function refillProgramQueue(program: RadioProgram, currentTrack: Song) {
  if (program.queue.length >= 2) return program;
  const rebuilt = await buildOnlineProgram({
    action: "skip",
    excludeTrackIds: [currentTrack.id, ...program.queue.map((track) => track.id)],
  });
  const existingKeys = new Set([currentTrack, ...program.queue].map((track) => buildTrackKey(track)));
  const refillQueue = rebuilt.program.queue
    .concat(rebuilt.program.currentTrack)
    .filter((track) => !existingKeys.has(buildTrackKey(track)));

  return {
    ...program,
    queue: [...program.queue, ...refillQueue].slice(0, DEFAULT_TRACK_COUNT - 1),
  };
}

export async function ensureOnlineRadioProgram() {
  const state = await readOnlineState();
  if (state?.date === getTodayDateKey()) {
    if (
      !state.program.hostIntro ||
      state.program.hostIntro.includes("Unknown Artist") ||
      state.program.currentTrack.artist.trim().toLowerCase() === "unknown artist"
    ) {
      const refreshedProgram = {
        ...state.program,
        hostIntro: buildOnlineHostIntro({
          scene: state.program.scene,
          seed: state.seed,
          currentTrack: state.program.currentTrack,
          nextTrack: state.program.queue[0] ?? state.program.currentTrack,
        }),
      };
      await writeOnlineState({
        ...state,
        program: refreshedProgram,
      });
      return { program: refreshedProgram, schedule: createScheduleFromProgram(refreshedProgram) };
    }
    return { program: state.program, schedule: createScheduleFromProgram(state.program) };
  }

  const next = await buildOnlineProgram();
  await writeOnlineState({
    date: getTodayDateKey(),
    seed: next.seed,
    source: next.source,
    program: next.program,
  });
  await writeProgramMemory(next.program, "online-init");
  return { program: next.program, schedule: createScheduleFromProgram(next.program) };
}

export async function regenerateOnlineRadioProgram(options: BuildOnlineProgramOptions = {}) {
  const next = await buildOnlineProgram({
    ...options,
    forceNew: true,
    action: options.action || "regenerate",
  });
  await writeOnlineState({
    date: getTodayDateKey(),
    seed: next.seed,
    source: next.source,
    program: next.program,
  });
  await writeProgramMemory(next.program, options.action || "online-regenerate");
  return { program: next.program, schedule: createScheduleFromProgram(next.program) };
}

export async function advanceOnlineRadioProgram() {
  const current = await ensureOnlineRadioProgram();
  if (current.program.queue.length === 0) {
    return regenerateOnlineRadioProgram({ action: "skip" });
  }

  const [nextTrack, ...restQueue] = current.program.queue;
  let nextProgram: RadioProgram = {
    ...current.program,
    currentTrack: nextTrack,
    queue: restQueue,
    energyLabel: toEnergyLabel(nextTrack.energy),
  };
  nextProgram = await refillProgramQueue(nextProgram, nextTrack);
  nextProgram.hostIntro = buildOnlineHostIntro({
    scene: nextProgram.scene,
    seed: { input: nextProgram.segmentTitle, reason: "queue-advance" },
    currentTrack: nextProgram.currentTrack,
    nextTrack: nextProgram.queue[0] ?? nextProgram.currentTrack,
  });

  await writeOnlineState({
    date: getTodayDateKey(),
    seed: { input: nextProgram.segmentTitle, reason: "queue-advance" },
    source: DEFAULT_SOURCE,
    program: nextProgram,
  });
  await writeProgramMemory(nextProgram, "online-next");
  return { program: nextProgram, schedule: createScheduleFromProgram(nextProgram) };
}

export async function selectOnlineTrackProgram(trackId: string) {
  const current = await ensureOnlineRadioProgram();
  const candidates = [current.program.currentTrack, ...current.program.queue];
  const selected = candidates.find((track) => track.id === trackId);
  if (!selected) {
    throw new Error("选中的在线歌曲不在当前队列里");
  }

  const queue = candidates.filter((track) => track.id !== selected.id);
  const nextProgram: RadioProgram = {
    ...current.program,
    currentTrack: selected,
    queue,
    energyLabel: toEnergyLabel(selected.energy),
  };
  await writeOnlineState({
    date: getTodayDateKey(),
    seed: { input: nextProgram.segmentTitle, reason: "manual-pick" },
    source: DEFAULT_SOURCE,
    program: nextProgram,
  });
  await writeProgramMemory(nextProgram, "manual-pick");
  return { program: nextProgram, schedule: createScheduleFromProgram(nextProgram) };
}

export async function applyOnlineFeedbackAndBuildProgram(action: "skip" | "regenerate" | "fresh" | "calmer" | "familiar") {
  const memory = await readMemory();
  const nextMemory = { ...memory, feedbackBias: { ...memory.feedbackBias }, lastAction: action };

  if (action === "skip") nextMemory.feedbackBias.fresh += 1;
  if (action === "fresh") nextMemory.feedbackBias.fresh += 2;
  if (action === "calmer") nextMemory.feedbackBias.calmer += 2;
  if (action === "familiar") nextMemory.feedbackBias.familiar += 2;

  await writeMemory(nextMemory);

  if (action === "skip") {
    return advanceOnlineRadioProgram();
  }

  return regenerateOnlineRadioProgram({
    action: action === "regenerate" ? "regenerate" : action,
  });
}

export async function applyOnlineChatIntent(
  intent: ChatIntent,
  currentProgram: RadioProgram,
  messageHint?: string,
) {
  if (intent.action === "scene-change") {
    return regenerateOnlineRadioProgram({
      targetPeriod: intent.targetPeriod,
      action: "regenerate",
      messageHint,
    });
  }

  if (intent.action === "select-track" && intent.trackId) {
    return selectOnlineTrackProgram(intent.trackId);
  }

  if (
    intent.action === "regenerate" ||
    intent.action === "skip" ||
    intent.action === "fresh" ||
    intent.action === "calmer" ||
    intent.action === "familiar"
  ) {
    if (intent.action === "regenerate") {
      return regenerateOnlineRadioProgram({
        action: "regenerate",
        targetPeriod: intent.targetPeriod,
        messageHint,
      });
    }

    return applyOnlineFeedbackAndBuildProgram(intent.action);
  }

  return { program: currentProgram, schedule: createScheduleFromProgram(currentProgram) };
}
