import {
  readMoodRules,
  readPlaylistProfiles,
  readRoutineProfiles,
  readSongCatalog,
  readTasteProfile,
} from "@/lib/profile";
import { readMemory, writeMemory } from "@/lib/memory";
import {
  advanceDailyScheduleTrack,
  ensureDailySchedule,
  getCurrentScheduledTrack,
  rewriteCurrentScheduleBlock,
  resolveCurrentScheduleBlock,
  selectScheduledTrack,
  summarizeDailySchedule,
} from "@/lib/daily-schedule";
import { batchRewriteTrackReasons, composeHostIntro, rewriteTrackReason, summarizeReasons } from "@/lib/providers/llm";
import type { ChatIntent, RadioMemory, RadioProgram, Song } from "@/lib/types";

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
async function buildTrackReason(song: Song, scene: string) {
  return rewriteTrackReason(song, scene);
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
  if (!options.forceRandom && !options.pinnedTrackId) {
    return buildProgramFromDailySchedule();
  }

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

  // 一次调用批量生成所有推荐语，避免并发打挂 Hermes
  const allTracks = [currentTrack, ...queueBase];
  const reasons = await batchRewriteTrackReasons(allTracks, routine.scene);

  const currentWithReason = { ...currentTrack, reason: reasons.get(currentTrack.id)! };
  const queue = queueBase.map((t) => ({ ...t, reason: reasons.get(t.id)! }));

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

async function buildProgramFromDailySchedule(): Promise<RadioProgram> {
  const [taste, memory, schedule] = await Promise.all([
    readTasteProfile(),
    readMemory(),
    ensureDailySchedule(),
  ]);
  const currentBlock = resolveCurrentScheduleBlock(schedule);
  const scheduled = getCurrentScheduledTrack(schedule);

  if (!currentBlock || currentBlock.tracks.length === 0 || !scheduled.track) {
    throw new Error("今天的节目单为空，无法生成节目流");
  }

  const currentTrack = scheduled.track;
  const queue = scheduled.queue;
  const explanation = await summarizeDailySchedule(schedule);
  const hostIntro = await composeHostIntro({
    scene: currentBlock.scene,
    persona: taste.radioPersona,
    currentTrack,
    nextTrack: queue[0] ?? currentTrack,
    moodHint: currentTrack.mood,
  });

  return {
    stationName: schedule.stationName,
    segmentTitle: currentBlock.title,
    scene: currentBlock.scene,
    energyLabel: toEnergyLabel(currentTrack.energy),
    hostIntro,
    currentTrack,
    queue: queue.slice(0, 6),
    explanation,
    controlsHint: "今天的节目先按四段式排好，聊天和控制会逐步改写接下来的 block。",
    memorySummary: `今天已编排 ${schedule.blocks.length} 个时段；最近记住 ${memory.recentTrackIds.length} 首歌，当前更偏向 ${memory.feedbackBias.calmer > memory.feedbackBias.fresh ? "安静与熟悉" : "新鲜与流动"}。`,
  };
}

/**
 * 应用用户反馈后更新记忆状态，并返回新的节目。
 */
export async function applyFeedbackAndBuildProgram(action: string) {
  return applyFeedbackAndBuildProgramWithOptions(action);
}

type ApplyFeedbackOptions = {
  avoidTrackId?: string;
};

async function applyFeedbackAndBuildProgramWithOptions(
  action: string,
  options: ApplyFeedbackOptions = {},
) {
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
  let program = await buildRadioProgram({
    forceRandom: action === "fresh" || action === "skip",
    excludeTrackIds: memory.recentTrackIds,
  });

  if (options.avoidTrackId && program.currentTrack.id === options.avoidTrackId) {
    program = await buildRadioProgram({
      forceRandom: true,
      excludeTrackIds: [...memory.recentTrackIds, options.avoidTrackId],
    });
  }

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
  await advanceDailyScheduleTrack();
  const program = await buildProgramFromDailySchedule();
  const memory = await readMemory();

  const nextMemory = {
    ...memory,
    lastAction: "schedule-next",
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
  await selectScheduledTrack(trackId);
  const memory = await readMemory();
  const program = await buildProgramFromDailySchedule();

  const nextMemory = {
    ...memory,
    lastAction: "manual-pick",
    recentTrackIds: [program.currentTrack.id, ...memory.recentTrackIds].slice(0, 12),
    recentProgramTitles: [program.segmentTitle, ...memory.recentProgramTitles].slice(0, 6),
  };

  await writeMemory(nextMemory);
  return program;
}

function findQueueTrackByMessage(program: RadioProgram, message: string) {
  const normalized = message.trim().toLowerCase();

  if (!normalized) {
    return undefined;
  }

  return program.queue.find((track) => {
    const title = track.title.toLowerCase();
    const artist = track.artist.toLowerCase();
    return normalized.includes(title) || normalized.includes(artist);
  });
}

function resolveTargetPeriod(message: string) {
  const normalized = message.trim().toLowerCase();

  if (
    normalized.includes("今晚") ||
    normalized.includes("晚上") ||
    normalized.includes("傍晚")
  ) {
    return "evening";
  }

  if (
    normalized.includes("深夜") ||
    normalized.includes("夜里") ||
    normalized.includes("半夜")
  ) {
    return "late-night";
  }

  if (
    normalized.includes("白天") ||
    normalized.includes("下午") ||
    normalized.includes("工作")
  ) {
    return "daytime";
  }

  if (
    normalized.includes("早上") ||
    normalized.includes("早晨") ||
    normalized.includes("晨间")
  ) {
    return "morning";
  }

  return undefined;
}

/**
 * 聊天意图只做可预测的本地规则判断，避免把实际控制权直接交给模型。
 */
export function resolveChatIntent(message: string, program: RadioProgram): ChatIntent {
  const normalized = message.trim().toLowerCase();
  const targetPeriod = resolveTargetPeriod(message);

  if (!normalized) {
    return { action: "none", targetPeriod };
  }

  const selectedTrack = findQueueTrackByMessage(program, normalized);
  if (selectedTrack) {
    return { action: "select-track", trackId: selectedTrack.id, targetPeriod };
  }

  if (
    normalized.includes("下一首") ||
    normalized.includes("切歌") ||
    normalized.includes("跳过") ||
    normalized.includes("skip") ||
    normalized.includes("next")
  ) {
    return { action: "skip", targetPeriod };
  }

  if (
    normalized.includes("熟") ||
    normalized.includes("回忆") ||
    normalized.includes("老歌") ||
    normalized.includes("familiar")
  ) {
    return { action: "familiar", targetPeriod };
  }

  if (
    normalized.includes("安静") ||
    normalized.includes("轻一点") ||
    normalized.includes("慢一点") ||
    normalized.includes("calm") ||
    normalized.includes("softer")
  ) {
    return { action: "calmer", targetPeriod };
  }

  if (
    normalized.includes("新一点") ||
    normalized.includes("新鲜") ||
    normalized.includes("换个感觉") ||
    normalized.includes("fresh") ||
    normalized.includes("switch")
  ) {
    return { action: "fresh", targetPeriod };
  }

  return { action: "none", targetPeriod };
}

/**
 * 把聊天里的控制意图映射到真实电台动作。
 */
export async function applyChatIntent(intent: ChatIntent) {
  if (intent.action === "select-track" && intent.trackId) {
    return selectTrackProgram(intent.trackId);
  }

  if (intent.action === "skip") {
    return advanceProgramRandomly();
  }

  if (
    intent.action === "fresh" ||
    intent.action === "calmer" ||
    intent.action === "familiar"
  ) {
    return null;
  }

  return null;
}

/**
 * 聊天控制型意图需要更强的即时反馈，优先直接离开当前曲目。
 */
export async function applyChatIntentWithProgram(
  intent: ChatIntent,
  currentProgram: RadioProgram,
) {
  if (intent.action === "fresh" || intent.action === "calmer" || intent.action === "familiar") {
    await applyFeedbackAndBuildProgramWithOptions(intent.action, {
      avoidTrackId: currentProgram.currentTrack.id,
    });
    await rewriteCurrentScheduleBlock(intent.action, intent.targetPeriod);
    return buildRadioProgram();
  }

  return applyChatIntent(intent);
}
