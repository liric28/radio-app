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
import { batchRewriteTrackReasons, recommendBlockTrackCount, rewriteTrackReason, summarizeReasons } from "@/lib/providers/llm";
import { dataDir } from "@/lib/paths";
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
    score += memory.recentTrackIds.includes(song.id) ? -8 : 0;
    score += !taste.anchorArtists.includes(song.artist) ? 2 : 0;
  }

  return score;
}

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

    const reasonMap = await batchRewriteTrackReasons(pickedSongs, routine.scene);
    const withReason = pickedSongs.map((track) => ({
      ...track,
      reason: reasonMap.get(track.id) ?? track.reasonSeed,
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
