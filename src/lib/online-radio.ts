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

type ExplorationPlan = {
  confidence: number;
  intensity: number;
  mode: "wide" | "balanced" | "focused";
  exploratoryQueries: string[];
};

type RecommendationSourceMeta = {
  sourceLabel: string;
  slotType: Song["recommendationMeta"] extends infer T
    ? T extends { slotType: infer U } ? U : never
    : never;
  slotLabel?: string;
};

type OnlineTrackCandidate = {
  track: Song;
  slotType: NonNullable<Song["recommendationMeta"]>["slotType"];
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

function buildRemoteAudioProxyUrl(remoteUrl: string) {
  return `/api/remote-audio?url=${encodeURIComponent(remoteUrl)}`;
}

function titlesLookCompatible(left: string, right: string) {
  const normalizedLeft = normalizeName(left);
  const normalizedRight = normalizeName(right);
  return Boolean(
    normalizedLeft &&
    normalizedRight &&
    (normalizedLeft === normalizedRight ||
      normalizedLeft.includes(normalizedRight) ||
      normalizedRight.includes(normalizedLeft)),
  );
}

function artistsLookCompatible(left: string, right: string) {
  const normalizedLeft = normalizeName(left);
  const normalizedRight = normalizeName(right);
  return Boolean(
    normalizedLeft &&
    normalizedRight &&
    (normalizedLeft === normalizedRight ||
      normalizedLeft.includes(normalizedRight) ||
      normalizedRight.includes(normalizedLeft)),
  );
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
  model: PreferenceModel,
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

  score += (model.artistAffinity[hit.artist] || 0) * 0.9;
  score += scenePreferenceScore(model.artistAffinityByScene, routine.scene, hit.artist) * 1.6;

  const inferredLanguage = preferences.language || inferLanguage(taste, hit.title, hit.artist);
  score += (model.languageAffinity[inferredLanguage] || 0) * 0.8;
  score += scenePreferenceScore(model.languageAffinityByScene, routine.scene, inferredLanguage) * 1.2;

  for (const token of [hit.source, routine.scene, ...preferences.vibes, hit.albumName || ""]) {
    if (!token) continue;
    score += (model.tagAffinity[token] || 0) * 0.2;
    score += scenePreferenceScore(model.tagAffinityByScene, routine.scene, token) * 0.35;
  }

  score -= sceneNegativeScore(model, routine.scene, hit.artist, inferredLanguage) * 1.4;

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

function topSceneModelKey(
  map: Record<string, Record<string, number>>,
  scene: string,
) {
  return topModelKey(map[scene] || {});
}

function learningConfidence(model: PreferenceModel) {
  return Math.max(0, Math.min(1, model.totalEvents / MIN_EVENTS_FOR_STRONG_LEARNING));
}

function buildExplorationPlan(
  model: PreferenceModel,
  routine: RoutineProfile,
  taste: UserTasteProfile,
  preferences: RequestPreferences,
  action?: BuildOnlineProgramOptions["action"],
): ExplorationPlan {
  const confidence = learningConfidence(model);
  const sceneTag = topSceneModelKey(model.tagAffinityByScene, routine.scene);
  const globalTag = topModelKey(model.tagAffinity);
  const sceneLanguage = topSceneModelKey(model.languageAffinityByScene, routine.scene);
  const preferredLanguage = preferences.language || sceneLanguage || taste.favoriteLanguages[0] || "中文";
  const exploratoryQueries = [
    [preferredLanguage, "冷门", routine.scene].filter(Boolean).join(" "),
    [preferredLanguage, "小众", sceneTag || globalTag || routine.preferredMoods[0], routine.scene].filter(Boolean).join(" "),
    action === "fresh" ? [preferredLanguage, "新一点", "不同艺人", routine.scene].filter(Boolean).join(" ") : "",
  ].filter(Boolean);

  if (confidence < 0.35) {
    return { confidence, intensity: 0.85, mode: "wide", exploratoryQueries };
  }
  if (confidence < 0.7) {
    return { confidence, intensity: 0.45, mode: "balanced", exploratoryQueries };
  }
  return { confidence, intensity: action === "fresh" ? 0.35 : 0.18, mode: "focused", exploratoryQueries };
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

function sceneNegativeScore(
  model: PreferenceModel,
  scene: string,
  ...keys: Array<string | undefined>
) {
  return keys.reduce((sum, key) => {
    const normalized = String(key || "").trim();
    if (!normalized) return sum;
    return sum + (model.negativeSignalsByScene[scene]?.[normalized] || 0) + (model.negativeSignals[normalized] || 0);
  }, 0);
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
  const sceneTopArtist = topSceneModelKey(model.artistAffinityByScene, routine.scene);
  const sceneTopLanguage = topSceneModelKey(model.languageAffinityByScene, routine.scene);
  const sceneTopTag = topSceneModelKey(model.tagAffinityByScene, routine.scene);
  const sceneAvoid = Object.entries(model.negativeSignalsByScene[routine.scene] || {})
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([key, value]) => `${key} x${value.toFixed(1)}`);

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
        sceneTopArtist ? `# Learned Scene Artist (${routine.scene})\n${sceneTopArtist}` : "",
        sceneTopLanguage ? `# Learned Scene Language (${routine.scene})\n${sceneTopLanguage}` : "",
        sceneTopTag ? `# Learned Scene Tag (${routine.scene})\n${sceneTopTag}` : "",
        sceneAvoid.length ? `# Avoid Signals (${routine.scene})\n${sceneAvoid.join(" | ")}` : "",
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
  const exploration = buildExplorationPlan(model, routine, taste, preferences, action);
  const preferredLanguage =
    preferences.language ||
    topSceneModelKey(model.languageAffinityByScene, routine.scene) ||
    topModelKey(model.languageAffinity) ||
    taste.favoriteLanguages[0];
  const energyHint =
    preferences.energy === "high"
      ? "劲爆"
      : preferences.energy === "low"
        ? "安静"
        : "";
  const learnedArtist =
    confidence >= 0.6
      ? topSceneModelKey(model.artistAffinityByScene, routine.scene) || topModelKey(model.artistAffinity)
      : "";
  const learnedTag =
    confidence >= 0.4
      ? topSceneModelKey(model.tagAffinityByScene, routine.scene) || topModelKey(model.tagAffinity)
      : "";
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
    ...(confidence < 0.8 ? exploration.exploratoryQueries : []),
  ];

  return [...new Set(queries.map((item) => item.trim()).filter(Boolean))];
}

function noveltyBoost(
  hit: MusicSearchHit,
  model: PreferenceModel,
  routine: RoutineProfile,
  exploration: ExplorationPlan,
) {
  const artistScore = model.artistAffinity[hit.artist] || 0;
  const sceneArtistScore = scenePreferenceScore(model.artistAffinityByScene, routine.scene, hit.artist);
  const lowerKnownness = Math.max(0, 3 - artistScore - sceneArtistScore);
  return lowerKnownness * exploration.intensity;
}

function reservedExplorationSlots(
  exploration: ExplorationPlan,
  count: number,
  action?: BuildOnlineProgramOptions["action"],
) {
  if (count <= 1) return 0;
  if (action === "fresh") return Math.min(2, Math.max(1, count - 1));
  if (exploration.mode === "wide") return Math.min(2, Math.max(1, count - 1));
  if (exploration.mode === "balanced") return 1;
  return 0;
}

function slotLabelForTrack(
  slotType: RecommendationSourceMeta["slotType"],
  stableIndex: number,
  explorationIndex: number,
) {
  if (slotType === "explore") {
    return explorationIndex === 0 ? "新发现 A" : `新发现 ${explorationIndex + 1}`;
  }
  return stableIndex === 0 ? "当前主推" : "为你延续";
}

function interleaveTrackCandidates(
  stableCandidates: OnlineTrackCandidate[],
  exploreCandidates: OnlineTrackCandidate[],
  count: number,
  explorationSlots: number,
) {
  const selected: Song[] = [];
  const effectiveExplorationSlots = Math.min(explorationSlots, exploreCandidates.length, Math.max(0, count - 1));
  const explorePositions = new Set<number>();

  for (let index = 0; index < effectiveExplorationSlots; index += 1) {
    const position = Math.min(count - 1, 2 + index * 2);
    explorePositions.add(position);
  }

  let stableIndex = 0;
  let explorationIndex = 0;
  for (let position = 0; position < count; position += 1) {
    const wantExplore = explorePositions.has(position);
    const candidate = wantExplore
      ? exploreCandidates[explorationIndex++] || stableCandidates[stableIndex++]
      : stableCandidates[stableIndex++] || exploreCandidates[explorationIndex++];
    if (!candidate) break;
    selected.push({
      ...candidate.track,
      recommendationMeta: candidate.track.recommendationMeta
        ? {
            ...candidate.track.recommendationMeta,
            slotLabel: slotLabelForTrack(
              candidate.slotType,
              Math.max(0, stableIndex - 1),
              Math.max(0, explorationIndex - 1),
            ),
          }
        : candidate.track.recommendationMeta,
    });
  }

  return selected;
}

function classifyRecommendationSource(
  hit: MusicSearchHit,
  localMatch: Song | undefined,
  routine: RoutineProfile,
  taste: UserTasteProfile,
  model: PreferenceModel,
  preferences: RequestPreferences,
  options: BuildOnlineProgramOptions,
  exploration: ExplorationPlan,
) : RecommendationSourceMeta {
  const explicitArtist = explicitArtistRequest(options.messageHint, taste);
  const inferredLanguage = preferences.language || inferLanguage(taste, hit.title, hit.artist);

  if (localMatch?.sourcePath) {
    return { sourceLabel: "本地收藏线", slotType: "local-match" };
  }
  if (explicitArtist && hit.artist.includes(explicitArtist)) {
    return { sourceLabel: "按你点名", slotType: "request" };
  }
  if (preferences.vibes.length > 0 && preferences.vibes.some((item) => `${hit.title} ${hit.artist} ${hit.albumName || ""}`.toLowerCase().includes(item.toLowerCase()))) {
    return { sourceLabel: "按你刚刚的感觉", slotType: "request" };
  }
  if (sanitizeAnchorArtists(taste.anchorArtists).some((artist) => hit.artist.includes(artist))) {
    return { sourceLabel: "你常听的艺人", slotType: "anchor" };
  }
  if (
    scenePreferenceScore(model.artistAffinityByScene, routine.scene, hit.artist) > 0.8 ||
    scenePreferenceScore(model.languageAffinityByScene, routine.scene, inferredLanguage) > 0.8
  ) {
    return { sourceLabel: "顺着你的口味", slotType: "learned" };
  }
  if (exploration.mode !== "focused") {
    return { sourceLabel: "给你换点新的", slotType: "explore" };
  }
  return { sourceLabel: "这一轮的自然延续", slotType: "fallback" };
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

async function findAlternatePlayableHit(hit: MusicSearchHit) {
  const sourceOrder: MusicSearchSource[] = [hit.source, "qq", "kugou", "netease"].filter(
    (value, index, list) => list.indexOf(value) === index,
  ) as MusicSearchSource[];

  for (const source of sourceOrder) {
    const candidate =
      source === hit.source
        ? hit
        : (await searchSongsBySource(`${hit.title} ${hit.artist}`, source, 1, 6).catch(() => []))
            .find((item) => titlesLookCompatible(item.title, hit.title) && artistsLookCompatible(item.artist, hit.artist));
    if (!candidate) continue;

    const remoteUrl = await resolvePlaybackUrlForHit(candidate).catch(() => null);
    if (!remoteUrl) continue;
    const playable = await verifyPlaybackUrl(remoteUrl).catch(() => false);
    if (!playable) continue;
    return {
      hit: candidate,
      streamUrl: buildRemoteAudioProxyUrl(remoteUrl),
    };
  }

  return null;
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

function programHasLegacyRemoteUrls(program: RadioProgram) {
  return [program.currentTrack, ...program.queue].some((track) =>
    Boolean(track.streamUrl && /^https?:\/\//i.test(track.streamUrl)),
  );
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
  const exploration = buildExplorationPlan(model, routine, taste, preferences);

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
      const rightLanguage = preferences.language || inferLanguage(taste, right.title, right.artist);
      const leftLanguage = preferences.language || inferLanguage(taste, left.title, left.artist);
      const rightLearned =
        ((model.artistAffinity[right.artist] || 0) +
          (model.languageAffinity[rightLanguage] || 0) +
          scenePreferenceScore(model.artistAffinityByScene, routine.scene, right.artist) +
          scenePreferenceScore(model.languageAffinityByScene, routine.scene, rightLanguage)) *
        confidence;
      const leftLearned =
        ((model.artistAffinity[left.artist] || 0) +
          (model.languageAffinity[leftLanguage] || 0) +
          scenePreferenceScore(model.artistAffinityByScene, routine.scene, left.artist) +
          scenePreferenceScore(model.languageAffinityByScene, routine.scene, leftLanguage)) *
        confidence;

      return (
        scoreOnlineHit(right, taste, memory, model, routine, seed.input, preferences) +
        noveltyBoost(right, model, routine, exploration) +
        rightLearned -
        (scoreOnlineHit(left, taste, memory, model, routine, seed.input, preferences) +
          noveltyBoost(left, model, routine, exploration) +
          leftLearned)
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
  const stableCandidates: OnlineTrackCandidate[] = [];
  const exploreCandidates: OnlineTrackCandidate[] = [];
  const artistCounts = new Map<string, number>();
  const forcedArtist = explicitArtistRequest(options.messageHint, taste);
  const maxPerArtist = forcedArtist ? count : 2;
  const model = await readPreferenceModel();
  const preferences = parseRequestPreferences(options.messageHint);
  const exploration = buildExplorationPlan(model, routine, taste, preferences, options.action);
  const explorationSlots = reservedExplorationSlots(exploration, count, options.action);

  for (const [index, hit] of hits.entries()) {
    if (stableCandidates.length + exploreCandidates.length >= count * 3) break;
    const normalizedArtist = hit.artist.trim().toLowerCase();
    const currentArtistCount = artistCounts.get(normalizedArtist) || 0;
    if (currentArtistCount >= maxPerArtist) continue;
    const localMatch = findLocalMatch(hit, localSongs);
    const recommendationMeta = classifyRecommendationSource(
      hit,
      localMatch,
      routine,
      taste,
      model,
      preferences,
      options,
      exploration,
    );
    let streamUrl = localMatch?.sourcePath
      ? `/api/audio?path=${encodeURIComponent(localMatch.sourcePath)}&libraryRoot=${encodeURIComponent(localMatch.libraryRoot || "")}`
      : "";
    let resolvedHit = hit;

    if (!streamUrl) {
      const remotePlayback = await findAlternatePlayableHit(hit);
      if (!remotePlayback) continue;
      streamUrl = remotePlayback.streamUrl;
      resolvedHit = remotePlayback.hit;
    }

    const track: Song = {
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
      source: localMatch?.source || resolvedHit.source,
      recommendationMeta,
      downloadContext: {
        source: resolvedHit.source,
        duration: resolvedHit.duration,
        payable: resolvedHit.payable,
        downloadable: resolvedHit.downloadable,
        albumName: resolvedHit.albumName,
        imageUrl: resolvedHit.imageUrl,
        raw: resolvedHit.raw,
      },
    };

    const bucket = recommendationMeta.slotType === "explore" ? exploreCandidates : stableCandidates;
    bucket.push({
      track: {
        ...track,
        recommendationMeta: {
          ...recommendationMeta,
        },
      },
      slotType: recommendationMeta.slotType,
    });
    artistCounts.set(normalizedArtist, currentArtistCount + 1);
  }

  return interleaveTrackCandidates(stableCandidates, exploreCandidates, count, explorationSlots);
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

function createProgramTrack(song: Song, reason?: string) {
  return {
    ...song,
    reason: reason || song.reasonSeed || "这首刚被你明确点名留下，先把它顶到当前。",
  };
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
  const exploration = buildExplorationPlan(model, routine, taste, preferences, options.action);
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
  const learnedSceneArtist = topSceneModelKey(model.artistAffinityByScene, routine.scene);
  const learnedSceneLanguage = topSceneModelKey(model.languageAffinityByScene, routine.scene);
  const program: RadioProgram = {
    stationName: "Claudio FM",
    segmentTitle: buildSegmentTitle(routine.scene, playlistSummary),
    scene: routine.scene,
    energyLabel: toEnergyLabel(currentTrack.energy),
    hostIntro,
    currentTrack,
    queue,
    explanation,
    controlsHint: `这条在线队列会跟着你的反馈、时段和口味继续重组。当前固定保留 ${reservedExplorationSlots(exploration, DEFAULT_TRACK_COUNT, options.action)} 首新发现。`,
    memorySummary: `当前直接从在线来源抓歌；最近动作是 ${memory.lastAction}，本轮种子是“${seed.input}”。${[learnedSceneArtist ? `这时段更偏 ${learnedSceneArtist}` : "", learnedSceneLanguage ? `语言更偏 ${learnedSceneLanguage}` : "", exploration.mode === "wide" ? "当前会多带一点新鲜感" : exploration.mode === "balanced" ? "当前在熟悉和新鲜之间平衡" : "当前以你熟悉的方向为主", reservedExplorationSlots(exploration, DEFAULT_TRACK_COUNT, options.action) > 0 ? `队列里固定留 ${reservedExplorationSlots(exploration, DEFAULT_TRACK_COUNT, options.action)} 首新发现` : "这一轮不额外加新发现"].filter(Boolean).join("，")}`,
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
    if (programHasLegacyRemoteUrls(state.program)) {
      const rebuilt = await buildOnlineProgram({
        source: state.source,
        forceNew: true,
      });
      await writeOnlineState({
        date: getTodayDateKey(),
        seed: rebuilt.seed,
        source: rebuilt.source,
        program: rebuilt.program,
      });
      return { program: rebuilt.program, schedule: createScheduleFromProgram(rebuilt.program) };
    }
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

export async function promoteSongToOnlineProgram(
  song: Song,
  options: { action?: string; messageHint?: string } = {},
) {
  const rebuilt = await regenerateOnlineRadioProgram({
    action: "fresh",
    messageHint: options.messageHint || `${song.title} ${song.artist}`,
  });
  const currentTrack = createProgramTrack(
    song,
    song.reasonSeed || "这首刚从搜索结果收进来，现在先放给你听。",
  );
  const queue = [
    rebuilt.program.currentTrack,
    ...rebuilt.program.queue,
  ].filter((track) => track.id !== song.id);
  const nextProgram: RadioProgram = {
    ...rebuilt.program,
    currentTrack,
    queue,
    energyLabel: toEnergyLabel(currentTrack.energy),
  };
  nextProgram.hostIntro = buildOnlineHostIntro({
    scene: nextProgram.scene,
    seed: { input: `${song.title} ${song.artist}`, reason: "manual-download-promote" },
    currentTrack: nextProgram.currentTrack,
    nextTrack: nextProgram.queue[0] ?? nextProgram.currentTrack,
  });
  await writeOnlineState({
    date: getTodayDateKey(),
    seed: { input: `${song.title} ${song.artist}`, reason: "manual-download-promote" },
    source: DEFAULT_SOURCE,
    program: nextProgram,
  });
  await writeProgramMemory(nextProgram, options.action || "manual-download");
  return { program: nextProgram, schedule: createScheduleFromProgram(nextProgram) };
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
