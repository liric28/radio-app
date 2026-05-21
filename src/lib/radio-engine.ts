import {
  readMoodRules,
  readPlaylistProfiles,
  readRoutineProfiles,
  readSongCatalog,
  readTasteProfile,
} from "@/lib/profile";
import { readMemory, writeMemory } from "@/lib/memory";
import { composeHostIntro, summarizeReasons } from "@/lib/providers/llm";
import type { RadioMemory, RadioProgram, Song } from "@/lib/types";

type BuildProgramOptions = {
  forceRandom?: boolean;
  excludeTrackIds?: string[];
  pinnedTrackId?: string;
};

/**
 * 根据当前小时选择一个最贴近的日常场景。
 */
function resolveCurrentPeriod() {
  const hour = new Date().getHours();

  if (hour < 9) return "morning";
  if (hour < 18) return "daytime";
  if (hour < 23) return "evening";
  return "late-night";
}

/**
 * 根据反馈偏移、场景和自动画像，为每首歌生成可比较的评分。
 */
function scoreSong(
  song: Song,
  memory: RadioMemory,
  preferredMoods: string[],
  taste: Awaited<ReturnType<typeof readTasteProfile>>,
) {
  let score = 0;

  if (preferredMoods.includes(song.mood)) score += 4;
  if (memory.recentTrackIds.includes(song.id)) score -= 6;
  score += song.tags.includes("华语") ? 2 : 0;
  score += taste.favoriteMoods.includes(song.mood) ? 3 : 0;
  score += taste.favoriteLanguages.includes(song.language) ? 2 : 0;
  score += taste.anchorArtists.includes(song.artist) ? 5 : 0;
  score += memory.feedbackBias.familiar > memory.feedbackBias.fresh ? 1 : 0;
  score += memory.feedbackBias.calmer > 0 ? Math.max(0, 6 - song.energy) : 0;
  score += memory.feedbackBias.fresh > 0 ? song.energy : 0;

  return score;
}

/**
 * 将数值能量映射为更接近电台语感的标签。
 */
function toEnergyLabel(energy: number) {
  if (energy <= 3) return "低照度安静流";
  if (energy <= 6) return "熟悉暖调";
  return "轻推力上行";
}

/**
 * 生成每首歌给用户看的推荐理由。
 */
function buildTrackReason(song: Song, scene: string) {
  return `${scene}里保留${song.mood}质感，${song.reasonSeed}`;
}

/**
 * 构建当前节目标题，让首版 UI 先有“台”的感觉。
 */
function buildSegmentTitle(scene: string, playlistSummary: string) {
  return `${scene}电台 · ${playlistSummary}`;
}

/**
 * 在高分候选里做一次随机抽样，避免连续播放总卡在固定顺序。
 */
function pickRandomizedTracks(
  songs: Song[],
  memory: RadioMemory,
  preferredMoods: string[],
  taste: Awaited<ReturnType<typeof readTasteProfile>>,
  excludeTrackIds: string[] = [],
) {
  const excluded = new Set(excludeTrackIds);

  const scoredSongs = songs
    .filter((song) => !excluded.has(song.id))
    .map((song) => ({
      song,
      score: scoreSong(song, memory, preferredMoods, taste),
    }))
    .sort((left, right) => right.score - left.score);

  const candidatePool = scoredSongs.slice(0, Math.min(8, scoredSongs.length));
  const picked: Song[] = [];
  const workingPool = [...candidatePool];

  while (picked.length < 4 && workingPool.length > 0) {
    const totalWeight = workingPool.reduce(
      (sum, item) => sum + Math.max(item.score + 8, 1),
      0,
    );
    let cursor = Math.random() * totalWeight;
    let selectedIndex = 0;

    for (const [index, item] of workingPool.entries()) {
      cursor -= Math.max(item.score + 8, 1);
      if (cursor <= 0) {
        selectedIndex = index;
        break;
      }
    }

    picked.push(workingPool[selectedIndex].song);
    workingPool.splice(selectedIndex, 1);
  }

  if (picked.length < 4) {
    for (const item of scoredSongs) {
      if (!picked.find((song) => song.id === item.song.id)) {
        picked.push(item.song);
      }
      if (picked.length >= 4) {
        break;
      }
    }
  }

  return picked;
}

/**
 * 核心逻辑：基于画像、时段和记忆状态生成一个节目流。
 */
export async function buildRadioProgram(
  options: BuildProgramOptions = {},
): Promise<RadioProgram> {
  const [taste, playlists, routines, songs, memory] = await Promise.all([
    readTasteProfile(),
    readPlaylistProfiles(),
    readRoutineProfiles(),
    readSongCatalog(),
    readMemory(),
  ]);

  const period = resolveCurrentPeriod();
  const routine =
    routines.find((item) => item.period === period) ?? routines[routines.length - 1];
  const playlist = playlists[0];
  const rankedSongs = options.forceRandom
    ? pickRandomizedTracks(
        songs,
        memory,
        routine.preferredMoods,
        taste,
        options.excludeTrackIds,
      )
    : [...songs].sort((left, right) => {
        return (
          scoreSong(right, memory, routine.preferredMoods, taste) -
          scoreSong(left, memory, routine.preferredMoods, taste)
        );
      });

  const pinnedTrack =
    options.pinnedTrackId &&
    songs.find((song) => song.id === options.pinnedTrackId);

  const workingSongs = pinnedTrack
    ? [
        pinnedTrack,
        ...rankedSongs.filter((song) => song.id !== pinnedTrack.id),
      ]
    : rankedSongs;

  const [currentTrack, ...queueBase] = workingSongs.slice(0, 4);

  if (!currentTrack) {
    throw new Error("当前曲库为空，无法生成节目流");
  }

  const queue = queueBase.map((track) => ({
    ...track,
    reason: buildTrackReason(track, routine.scene),
  }));

  const currentWithReason = {
    ...currentTrack,
    reason: buildTrackReason(currentTrack, routine.scene),
  };

  const rawReasons = [
    `当前时段是 ${routine.scene}，优先命中 ${routine.preferredMoods.join(" / ")}。`,
    `你的本地库目前更偏向 ${taste.favoriteEras.join("、")}，常出现 ${taste.anchorArtists.slice(0, 3).join("、")}。`,
    `最近一次动作是“${memory.lastAction}”，所以节目在熟悉感和新鲜度之间做了重新平衡。`,
  ];

  const explanation = await summarizeReasons(rawReasons);
  const hostIntro = await composeHostIntro({
    scene: routine.scene,
    persona: taste.radioPersona,
    currentTrack,
    nextTrack: queueBase[0] ?? currentTrack,
    moodHint: currentTrack.mood,
  });

  return {
    stationName: "Claudio FM",
    segmentTitle: buildSegmentTitle(routine.scene, playlist.summary),
    scene: routine.scene,
    energyLabel: toEnergyLabel(currentTrack.energy),
    hostIntro,
    currentTrack: currentWithReason,
    queue,
    explanation,
    controlsHint: "点击换台或情绪按钮，会直接修改下一轮候选集的排序。",
    memorySummary: `最近已记住 ${memory.recentTrackIds.length} 首歌，当前更偏向 ${memory.feedbackBias.calmer > memory.feedbackBias.fresh ? "安静与熟悉" : "新鲜与流动"}；高频艺人里有 ${taste.anchorArtists.slice(0, 2).join("、")}。`,
  };
}

/**
 * 应用用户反馈后更新记忆状态，并返回新的节目。
 */
export async function applyFeedbackAndBuildProgram(action: string) {
  const [memory, moodRules] = await Promise.all([readMemory(), readMoodRules()]);
  const nextMemory = { ...memory, feedbackBias: { ...memory.feedbackBias } };

  nextMemory.lastAction = action;

  if (action === "skip") {
    nextMemory.feedbackBias.fresh += 1;
  }

  if (action === "fresh") {
    nextMemory.feedbackBias.fresh += 2;
  }

  if (action === "calmer") {
    nextMemory.feedbackBias.calmer += 2;
  }

  if (action === "familiar") {
    nextMemory.feedbackBias.familiar += 2;
  }

  const matchedRule = moodRules.find((rule) => rule.trigger === action);
  if (matchedRule?.shiftTo === "settle") {
    nextMemory.feedbackBias.calmer += 1;
  }

  await writeMemory(nextMemory);
  const program = await buildRadioProgram({
    forceRandom: action === "fresh" || action === "skip",
    excludeTrackIds: memory.recentTrackIds,
  });

  const refreshedMemory = await readMemory();
  refreshedMemory.recentTrackIds = [
    program.currentTrack.id,
    ...refreshedMemory.recentTrackIds,
  ].slice(0, 6);
  refreshedMemory.recentProgramTitles = [
    program.segmentTitle,
    ...refreshedMemory.recentProgramTitles,
  ].slice(0, 4);

  await writeMemory(refreshedMemory);
  return program;
}

/**
 * 连续播放时自动切到下一首，默认使用随机模式并避开最近播放。
 */
export async function advanceProgramRandomly() {
  const memory = await readMemory();
  const program = await buildRadioProgram({
    forceRandom: true,
    excludeTrackIds: memory.recentTrackIds,
  });

  const nextMemory = {
    ...memory,
    lastAction: "autoplay-next",
    recentTrackIds: [program.currentTrack.id, ...memory.recentTrackIds].slice(0, 12),
    recentProgramTitles: [program.segmentTitle, ...memory.recentProgramTitles].slice(0, 6),
  };

  await writeMemory(nextMemory);
  return program;
}

/**
 * 用户手动点选队列中的某一首时，直接将它提升为当前播放。
 */
export async function selectTrackProgram(trackId: string) {
  const memory = await readMemory();
  const program = await buildRadioProgram({
    pinnedTrackId: trackId,
    excludeTrackIds: memory.recentTrackIds.filter((id) => id !== trackId),
  });

  const nextMemory = {
    ...memory,
    lastAction: "manual-pick",
    recentTrackIds: [program.currentTrack.id, ...memory.recentTrackIds].slice(0, 12),
    recentProgramTitles: [program.segmentTitle, ...memory.recentProgramTitles].slice(0, 6),
  };

  await writeMemory(nextMemory);
  return program;
}
