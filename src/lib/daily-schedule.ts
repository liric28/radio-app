/**
 * 一天四段歌单（schedule）的持久化 + 操作层。
 *
 * 数据：data/daily-schedule.json，结构是
 *   { date, stationName, currentBlockPeriod, currentTrackIndex, blocks: [{ period, scene, title, tracks }] }
 *
 * 函数分类：
 *   读 / 写：
 *     readDailySchedule        读盘 + normalize；过期或损坏 → 重生成
 *     ensureDailySchedule      readDailySchedule 的别名（语义化）
 *     writeDailySchedule       原子写盘
 *
 *   生成 / 重生成：
 *     generateDailySchedule    全量生成（recommendBlockTrackCount + 打分排序，不调 LLM）
 *     regenerateDailySchedule  ⌁ 按钮入口，generate + write
 *
 *   定位 / 取数：
 *     resolveCurrentScheduleBlock  根据 currentBlockPeriod 找当前段
 *     getCurrentScheduledTrack     拿当前段的 currentTrack + 剩余 queue
 *
 *   游标操作：
 *     advanceDailyScheduleTrack    next：游标 +1，到段尾跳下一段，到日尾回卷
 *     selectScheduledTrack         在 4 段里找指定 trackId，把游标移过去
 *     switchDailySchedulePeriod    切到指定 period，currentTrackIndex 重置 0
 *
 *   重排：
 *     rewriteCurrentScheduleBlock  reapply intent（fresh/calmer/familiar）重写当前段
 *
 *   辅助：
 *     normalizeDailySchedule       从曲库 hydrate 缺字段的 track（兼容旧 schedule）
 *     summarizeDailySchedule       生成 explanation 三行摘要
 *     scoreSongForBlock/Intent     评分：偏好情绪 / 最近播放 / 锚点艺人 / 反馈偏移
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { readMemory } from "@/lib/memory";
import {
  readPlaylistProfiles,
  readRoutineProfiles,
  readSongCatalog,
  readTasteProfile,
} from "@/lib/profile";
import type { ChatIntentAction, ScheduledTrack } from "@/lib/types";
import { recommendBlockTrackCount, rewriteTrackReason, summarizeReasons } from "@/lib/providers/llm";
import { dataDir } from "@/lib/paths";
import { trackLabelFromSong } from "@/lib/track-labels";
import type {
  DailySchedule,
  DailyScheduleBlock,
  RadioMemory,
  Song,
} from "@/lib/types";

const dailySchedulePath = path.join(dataDir, "daily-schedule.json");

function getTodayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function getCurrentPeriod() {
  const hour = new Date().getHours();

  if (hour < 9) return "morning";
  if (hour < 18) return "daytime";
  if (hour < 23) return "evening";
  return "late-night";
}

async function buildTrackReason(song: Song, scene: string) {
  return rewriteTrackReason(song, scene);
}

function buildBlockTitle(scene: string, playlistSummary: string) {
  return `${scene} · ${playlistSummary}`;
}

function hydrateScheduledTrack(
  track: Partial<ScheduledTrack>,
  catalog: Map<string, Song>,
): ScheduledTrack | null {
  const catalogTrack = track.id ? catalog.get(track.id) : null;
  const title = track.title ?? catalogTrack?.title;
  const artist = track.artist ?? catalogTrack?.artist;
  const reason = track.reason ?? track.reasonSeed ?? catalogTrack?.reasonSeed;

  if (!track.id || !title || !artist || !reason) {
    return null;
  }

  return {
    ...(catalogTrack ?? {
      id: track.id,
      title,
      artist,
      year: new Date().getFullYear(),
      mood: track.mood ?? "回忆感",
      energy: typeof track.energy === "number" ? track.energy : 5,
      language: track.language ?? "中文",
      tags: track.tags ?? [],
      reasonSeed: track.reasonSeed ?? "",
      sourcePath: track.sourcePath,
      libraryRoot: (track as Song).libraryRoot,
    }),
    ...track,
    title,
    artist,
    reason,
  } as ScheduledTrack;
}

async function normalizeDailySchedule(schedule: DailySchedule): Promise<DailySchedule> {
  const songs = await readSongCatalog();
  const catalog = new Map(songs.map((song) => [song.id, song]));

  return {
    ...schedule,
    blocks: schedule.blocks.map((block) => ({
      ...block,
      tracks: block.tracks
        .map((track) => hydrateScheduledTrack(track, catalog))
        .filter((track): track is ScheduledTrack => Boolean(track)),
    })),
  };
}

function scoreSongForBlock(
  song: Song,
  memory: RadioMemory,
  preferredMoods: string[],
  taste: Awaited<ReturnType<typeof readTasteProfile>>,
) {
  let score = 0;

  if (preferredMoods.includes(song.mood)) score += 4;
  if (memory.recentTrackIds.includes(trackLabelFromSong(song))) score -= 6;
  score += song.tags.includes("华语") ? 2 : 0;
  score += taste.favoriteMoods.includes(song.mood) ? 3 : 0;
  score += taste.favoriteLanguages.includes(song.language) ? 2 : 0;
  score += taste.anchorArtists.includes(song.artist) ? 5 : 0;
  score += memory.feedbackBias.familiar > memory.feedbackBias.fresh ? 1 : 0;
  score += memory.feedbackBias.calmer > 0 ? Math.max(0, 6 - song.energy) : 0;
  score += memory.feedbackBias.fresh > 0 ? song.energy : 0;

  return score;
}

function scoreSongForIntent(
  song: Song,
  action: ChatIntentAction,
  memory: RadioMemory,
  preferredMoods: string[],
  taste: Awaited<ReturnType<typeof readTasteProfile>>,
) {
  let score = scoreSongForBlock(song, memory, preferredMoods, taste);

  if (action === "familiar") {
    score += taste.favoriteLanguages.includes(song.language) ? 3 : 0;
    score += taste.anchorArtists.includes(song.artist) ? 5 : 0;
    score += song.language === "中文" ? 8 : -3;
    score += song.year < 2020 ? 4 : 0;
  }

  if (action === "calmer") {
    score += Math.max(0, 8 - song.energy) * 2;
    score += ["夜晚", "回忆感", "安静"].includes(song.mood) ? 3 : 0;
  }

  if (action === "fresh") {
    score += song.energy;
    score += memory.recentTrackIds.includes(trackLabelFromSong(song)) ? -8 : 0;
    score += !taste.anchorArtists.includes(song.artist) ? 2 : 0;
  }

  return score;
}

/**
 * 生成一天的四段歌单（morning / daytime / evening / late-night）。
 *
 * 关键决策：这里不调 LLM 润色推荐语，每首歌的 reason 用 reasonSeed 占位。
 * 原因：早期版本每段都 await batchRewriteTrackReasons，4 段串行 ≈ 30s，
 * 用户点 ⌁ 后要等很久 UI 才更新。现在改成：
 *   - schedule 本身快速生成（<1s，纯本地打分排序）
 *   - 推荐语由 player-shell.tsx 的 useEffect 监听 currentTrack.id 变化后，
 *     调 /api/rewrite-reasons 只润色当前 block（懒加载）
 *
 * 每段歌曲数走 recommendBlockTrackCount(scene, moods, catalogSize)，
 * 内部按场景给基线 + 随机抖动 ±2，所以每次总数都不一样（典型 27-42 首）。
 */
async function generateDailySchedule(): Promise<DailySchedule> {
  const [taste, playlists, routines, songs, memory] = await Promise.all([
    readTasteProfile(),
    readPlaylistProfiles(),
    readRoutineProfiles(),
    readSongCatalog(),
    readMemory(),
  ]);

  const playlist = playlists[0];
  const usedTrackIds = new Set<string>();
  const blocks: DailyScheduleBlock[] = [];
  for (const routine of routines) {
    const trackCount = await recommendBlockTrackCount(
      routine.scene,
      routine.preferredMoods,
      songs.length,
    );

    const rankedSongs = [...songs]
      .filter((song) => !usedTrackIds.has(song.id))
      .sort((left, right) => {
        return (
          scoreSongForBlock(right, memory, routine.preferredMoods, taste) -
          scoreSongForBlock(left, memory, routine.preferredMoods, taste)
        );
      });

    const fallbackSongs = [...songs].filter((song) => !usedTrackIds.has(song.id));
    const pickedSongs = [...rankedSongs, ...fallbackSongs].slice(0, trackCount);

    const withReason = pickedSongs.map((track) => ({
      ...track,
      reason: track.reasonSeed,
    }));

    for (const track of pickedSongs) {
      usedTrackIds.add(track.id);
    }

    blocks.push({
      period: routine.period,
      scene: routine.scene,
      title: buildBlockTitle(routine.scene, playlist.summary),
      tracks: withReason,
    });
  }

  return {
    date: getTodayDateKey(),
    stationName: "Claudio FM",
    currentBlockPeriod: routines.find((item) => item.period === getCurrentPeriod())?.period ?? getCurrentPeriod(),
    currentTrackIndex: 0,
    blocks,
  };
}

/**
 * 读取今天的 schedule。三种情况：
 *   1. 文件存在 + 日期是今天 → 直接返回 normalize 后的数据
 *   2. 文件存在 + 日期不是今天 → 视为过期，重新生成并落盘
 *   3. 文件不存在 / JSON 解析失败 → catch 后直接重生成
 *
 * normalizeDailySchedule 的作用：曲库可能比 schedule 新（导入了新歌），
 * 用 catalog hydrate 一遍，让 track 缺的字段（reasonSeed/sourcePath 等）补全。
 */
export async function readDailySchedule() {
  try {
    const content = await fs.readFile(dailySchedulePath, "utf8");
    const schedule = JSON.parse(content) as Partial<DailySchedule>;
    const normalizedSchedule = await normalizeDailySchedule({
      ...schedule,
      currentBlockPeriod: schedule.currentBlockPeriod || getCurrentPeriod(),
      currentTrackIndex: typeof schedule.currentTrackIndex === "number" ? schedule.currentTrackIndex : 0,
    } as DailySchedule);

    if (normalizedSchedule.date === getTodayDateKey()) {
      return normalizedSchedule;
    }
  } catch {
    // ignore and regenerate
  }

  const nextSchedule = await generateDailySchedule();
  await writeDailySchedule(nextSchedule);
  return nextSchedule;
}

export async function writeDailySchedule(schedule: DailySchedule) {
  await fs.writeFile(dailySchedulePath, `${JSON.stringify(schedule, null, 2)}\n`, "utf8");
}

export async function ensureDailySchedule() {
  return readDailySchedule();
}

export async function summarizeDailySchedule(schedule: DailySchedule) {
  const currentBlock = resolveCurrentScheduleBlock(schedule);

  return summarizeReasons([
    `今天已经按四段节律编好了节目单，当前处于 ${currentBlock?.scene ?? "默认时段"}。`,
    `当前 block 里优先保留 ${currentBlock?.tracks.slice(0, 3).map((track) => track.artist).join("、") || "你的高频艺人"} 这类熟悉锚点。`,
    `整天节目单总共安排了 ${schedule.blocks.reduce((sum, block) => sum + block.tracks.length, 0)} 首歌。`,
  ]);
}

export function resolveCurrentScheduleBlock(schedule: DailySchedule) {
  return (
    schedule.blocks.find((block) => block.period === schedule.currentBlockPeriod) ??
    schedule.blocks.find((block) => block.period === getCurrentPeriod()) ??
    schedule.blocks[0]
  );
}

export function getCurrentScheduledTrack(schedule: DailySchedule) {
  const block = resolveCurrentScheduleBlock(schedule);
  const index = Math.max(
    0,
    Math.min(schedule.currentTrackIndex, Math.max(block.tracks.length - 1, 0)),
  );

  return {
    block,
    index,
    track: block.tracks[index],
    queue: block.tracks.slice(index + 1),
  };
}

export async function regenerateDailySchedule() {
  const schedule = await generateDailySchedule();
  await writeDailySchedule(schedule);
  return schedule;
}

/**
 * 游标 +1（下一首）。三种情况：
 *   1. 当前段还有下一首 → currentTrackIndex + 1
 *   2. 当前段播完 → 跳到下一段（currentBlockPeriod 切换、index 归零）
 *   3. 整天播完（最后一段也播完）→ 回卷到第一段重头开始
 *
 * 不重新打分排序、不调 LLM，纯游标移动，~10ms 完成。
 */
export async function advanceDailyScheduleTrack() {
  const schedule = await readDailySchedule();
  const currentBlockIndex = schedule.blocks.findIndex(
    (block) => block.period === schedule.currentBlockPeriod,
  );
  const safeBlockIndex = currentBlockIndex >= 0 ? currentBlockIndex : 0;
  const currentBlock = schedule.blocks[safeBlockIndex];

  if (!currentBlock) {
    throw new Error("今天的节目单为空");
  }

  if (schedule.currentTrackIndex < currentBlock.tracks.length - 1) {
    const nextSchedule = {
      ...schedule,
      currentTrackIndex: schedule.currentTrackIndex + 1,
    };
    await writeDailySchedule(nextSchedule);
    return nextSchedule;
  }

  const nextBlock = schedule.blocks[safeBlockIndex + 1];
  if (nextBlock) {
    const nextSchedule = {
      ...schedule,
      currentBlockPeriod: nextBlock.period,
      currentTrackIndex: 0,
    };
    await writeDailySchedule(nextSchedule);
    return nextSchedule;
  }

  const wrappedSchedule = {
    ...schedule,
    currentBlockPeriod: schedule.blocks[0]?.period ?? schedule.currentBlockPeriod,
    currentTrackIndex: 0,
  };
  await writeDailySchedule(wrappedSchedule);
  return wrappedSchedule;
}

/**
 * 跳到指定 trackId：在 4 段里搜，找到就把游标移到那段那首。找不到原 schedule 不变。
 * 用于点 queue 列表里的歌、聊天精确点歌。
 */
export async function selectScheduledTrack(trackId: string) {
  const schedule = await readDailySchedule();

  for (const block of schedule.blocks) {
    const trackIndex = block.tracks.findIndex((track) => track.id === trackId);

    if (trackIndex >= 0) {
      const nextSchedule = {
        ...schedule,
        currentBlockPeriod: block.period,
        currentTrackIndex: trackIndex,
      };
      await writeDailySchedule(nextSchedule);
      return nextSchedule;
    }
  }

  return schedule;
}

/**
 * 切到指定时段：currentBlockPeriod = targetPeriod，currentTrackIndex 重置为 0。
 * 用于聊天意图 scene-change（"切到深夜" / "白天来一段"）。
 * 找不到目标段就保持原状（防止聊天乱传 period 把游标搞坏）。
 */
export async function switchDailySchedulePeriod(targetPeriod: string) {
  const schedule = await readDailySchedule();
  const nextBlock = schedule.blocks.find((block) => block.period === targetPeriod);

  if (!nextBlock) {
    return schedule;
  }

  const nextSchedule = {
    ...schedule,
    currentBlockPeriod: nextBlock.period,
    currentTrackIndex: 0,
  };
  await writeDailySchedule(nextSchedule);
  return nextSchedule;
}

function resolveTargetPeriodFromAction(
  schedule: DailySchedule,
  action: ChatIntentAction,
  targetPeriod?: string,
) {
  if (action !== "familiar" && action !== "calmer" && action !== "fresh") {
    return null;
  }

  return (
    schedule.blocks.find((block) => block.period === targetPeriod)?.period ??
    schedule.currentBlockPeriod
  );
}

/**
 * 重写当前段（或指定段）的 queue 顺序，应用 fresh/calmer/familiar 偏好。
 *
 * 关键策略（保护已播部分）：
 *   - 已播过的 tracks（含当前曲）都保留在前面，避免聊天反馈后跳回上一首
 *   - keepPlayed = 已播 - 1（最后一首不算"已播"，保留为 anchor）
 *   - 剩余位置用 scoreSongForIntent 按 action 偏好排序填上
 *
 * scoreSongForIntent vs scoreSongForBlock：
 *   - familiar：偏中文 + 锚点艺人 + 老歌（year < 2020）
 *   - calmer：偏低 energy + 安静/夜晚情绪
 *   - fresh：偏高 energy + 排除最近播过 + 非锚点艺人
 *
 * 调用者：sendFeedback（fresh/calmer/familiar）、applyChatIntentWithProgram
 */
export async function rewriteCurrentScheduleBlock(
  action: ChatIntentAction,
  targetPeriod?: string,
) {
  if (action !== "familiar" && action !== "calmer" && action !== "fresh") {
    return readDailySchedule();
  }

  const [schedule, songs, memory, routines, taste] = await Promise.all([
    readDailySchedule(),
    readSongCatalog(),
    readMemory(),
    readRoutineProfiles(),
    readTasteProfile(),
  ]);

  const resolvedPeriod = resolveTargetPeriodFromAction(schedule, action, targetPeriod);
  const block =
    schedule.blocks.find((item) => item.period === resolvedPeriod) ??
    resolveCurrentScheduleBlock(schedule);
  const routine =
    routines.find((item) => item.period === block.period) ?? routines[routines.length - 1];

  if (!block || !routine) {
    return schedule;
  }

  const currentIndex =
    block.period === schedule.currentBlockPeriod ? schedule.currentTrackIndex : -1;
  const currentTrack = block.tracks[currentIndex];
  const playedTracks = currentIndex >= 0 ? block.tracks.slice(0, currentIndex + 1) : [];
  const keepPlayed = playedTracks.slice(0, Math.max(playedTracks.length - 1, 0));
  const usedTrackIds = new Set(
    schedule.blocks.flatMap((item) => item.tracks.map((track) => track.id)),
  );

  const candidateSongs = songs
    .filter((song) => !usedTrackIds.has(song.id) || song.id === currentTrack?.id)
    .filter((song) => song.id !== currentTrack?.id)
    .sort((left, right) => {
      return (
        scoreSongForIntent(right, action, memory, routine.preferredMoods, taste) -
        scoreSongForIntent(left, action, memory, routine.preferredMoods, taste)
      );
    });

  const rebuiltTracks = await Promise.all([
    ...keepPlayed,
    ...(currentTrack ? [currentTrack] : []),
    ...candidateSongs.slice(
      0,
      Math.max(block.tracks.length - keepPlayed.length - (currentTrack ? 1 : 0), 0),
    ),
  ].map(async (track) => ({
    ...track,
    reason: await buildTrackReason(track, block.scene),
  })));

  const nextSchedule = {
    ...schedule,
    blocks: schedule.blocks.map((item) =>
      item.period === block.period
        ? {
            ...item,
            tracks: rebuiltTracks,
          }
        : item,
    ),
  };

  await writeDailySchedule(nextSchedule);
  return nextSchedule;
}
