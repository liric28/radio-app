import {
  applyFeedbackAndBuildProgram,
  buildRadioProgram,
} from "@/lib/radio-engine";
import {
  buildBridgePrompt,
  buildColdOpenForTracksPrompt,
  buildLiveStartIntentPrompt,
} from "@/lib/claudio/context";
import { buildOnlineClaudioTracks } from "@/lib/claudio/live-music";
import { generateClaudioJson, generateClaudioStartIntent } from "@/lib/claudio/llm";
import {
  applyLegacyTrackIntrosFromSegments,
  normalizeSegments,
  programStartIdSegment,
} from "@/lib/claudio/segment-normalizer";
import {
  broadcastClaudioEvent,
  enqueueClaudioJob,
  getClaudioStationState,
  setClaudioProgramContext,
} from "@/lib/claudio/station-runtime";
import { synthesizeClaudioSpeech } from "@/lib/claudio/tts";
import type {
  ClaudioBridgeGenerationJob,
  ClaudioProgramStartJob,
  ClaudioMusicRefillJob,
  ClaudioSegment,
  ClaudioTrack,
} from "@/lib/claudio/types";
import type { RadioProgram } from "@/lib/types";

const STATION_NAME = "Claudio FM";
const PROGRAM_NAME = "Live";
// live 现在支持两条源：
// - online：独立在线搜歌 live，不走本地四时段 program
// - local：回退到原本的 buildRadioProgram，本地歌单逻辑保持不变
const LIVE_MUSIC_MODE = process.env.CLAUDIO_LIVE_MUSIC_MODE || "online";

function fallbackLiveStartIntent(language: "en" | "zh") {
  if (language === "zh") {
    return "先从本地音乐库里找熟悉感强的歌，再慢慢把情绪推开。";
  }
  return "Start from the local library and pull a few songs that feel familiar before widening the mood.";
}

function toClaudioTrack(program: RadioProgram): ClaudioTrack[] {
  return [program.currentTrack, ...program.queue].map((track) => ({
    query: `${track.title}${track.artist ? ` - ${track.artist}` : ""}`,
    title: track.title,
    artist: track.artist,
    streamUrl: track.sourcePath ? `/api/audio?path=${encodeURIComponent(track.sourcePath)}&libraryRoot=${encodeURIComponent(track.libraryRoot || "")}` : "",
    scene: program.scene,
    sourceSong: track,
  }));
}

function programTranscript(program: RadioProgram) {
  return [program.hostIntro, ...program.explanation].filter(Boolean).join("\n\n");
}

async function synthesizeSegments(segments: ClaudioSegment[]) {
  // 文案段统一在这里做 TTS；失败不阻断节目，只把该段标成 tts_failed，
  // 前端仍能继续播歌，避免“某一句播报挂了整台停住”。
  for (const segment of segments) {
    if (segment.type === "silence" || !segment.text) {
      segment.status = "silent";
      continue;
    }
    try {
      const filePath = await synthesizeClaudioSpeech(segment.text, { role: "station" });
      segment.ttsUrl = `/api/claudio/tts/${encodeURIComponent(filePath.split("/").pop() || "")}`;
      segment.status = "ready";
    } catch (error) {
      segment.status = "tts_failed";
      segment.error = error instanceof Error ? error.message : String(error);
    }
  }
  return segments;
}

export async function runClaudioProgramStartJob(job: ClaudioProgramStartJob) {
  const onlineMode = LIVE_MUSIC_MODE === "online";
  const needsGeneratedInput = !job.input?.trim();
  const effectiveInput = needsGeneratedInput
    ? await (async () => {
      try {
        const prompt = await buildLiveStartIntentPrompt({ djLanguage: job.djLanguage });
        const generated = await generateClaudioStartIntent(prompt);
        return generated.input?.trim() || fallbackLiveStartIntent(job.djLanguage);
      } catch {
        return fallbackLiveStartIntent(job.djLanguage);
      }
    })()
    : job.input.trim();
  // 起台分两路：
  // 1. online：根据风格 seed 在线搜出“已确认可播”的 tracks
  // 2. local：沿用原来的本地 RadioProgram → ClaudioTrack 转换
  const program = onlineMode ? null : await buildRadioProgram();
  const online = onlineMode
    ? await buildOnlineClaudioTracks({
        input: effectiveInput,
      })
    : null;
  const tracks = onlineMode ? online?.tracks || [] : toClaudioTrack(program!);
  if (!tracks.length) {
    throw new Error("Claudio live 没有搜到可播放的在线歌曲");
  }
  const programId = `claudio_${Date.now()}`;
  // LLM 在 live 里只负责“围绕已确认 tracks 写开场播报”，
  // 不再决定选哪首歌，避免文案和实际可播列表脱节。
  const llmPrompt = await buildColdOpenForTracksPrompt({
    programTitle: onlineMode ? online?.sessionTitle || "Live" : program!.segmentTitle,
    tracks,
    userInput: effectiveInput,
    djLanguage: job.djLanguage,
  });
  const llmResult = await generateClaudioJson(llmPrompt);
  const segments = await synthesizeSegments(normalizeSegments(
    [
      programStartIdSegment(programId),
      ...(Array.isArray(llmResult.segments) ? llmResult.segments : []),
    ],
    tracks,
    llmResult.say || program?.hostIntro || "",
  ),
  );

  applyLegacyTrackIntrosFromSegments(tracks, segments);
  setClaudioProgramContext({
    programId,
    sessionTitle: onlineMode ? online?.sessionTitle || "Live" : program!.segmentTitle,
    tracks,
    segments,
  });

  const payload = {
    type: "program-start" as const,
    programId,
    tracks,
    segments,
    sessionTitle: onlineMode ? online?.sessionTitle || "Live" : program!.segmentTitle,
    stationName: STATION_NAME,
    programName: PROGRAM_NAME,
    failedTracks: [],
    reason: llmResult.reason || (onlineMode ? online?.reason : effectiveInput),
  };

  broadcastClaudioEvent(payload);
  broadcastClaudioEvent({
    type: "now-playing",
    ttsUrl: null,
    tracks,
    segments,
    sessionTitle: onlineMode ? online?.sessionTitle || "Live" : program!.segmentTitle,
    transcript:
      segments.map((segment) => segment.text).filter(Boolean).join("\n\n") ||
      (program ? programTranscript(program) : ""),
    djNote: llmResult.say || program?.hostIntro || "",
    reason: llmResult.reason || (onlineMode ? online?.reason : effectiveInput),
    mode: "music",
    status: "queued",
    stationName: STATION_NAME,
    programName: PROGRAM_NAME,
    trigger: job.source,
    failedTracks: [],
  });

  enqueueBridgeJobs({
    programId,
    sessionTitle: onlineMode ? online?.sessionTitle || "Live" : program!.segmentTitle,
    tracks,
    startIndex: 0,
    djLanguage: job.djLanguage,
  });

  return payload;
}

export async function runClaudioMusicRefillJob(job: ClaudioMusicRefillJob) {
  const state = getClaudioStationState();
  const onlineMode = LIVE_MUSIC_MODE === "online";
  // refill 也保持和起台同一条源：
  // - online：继续在线搜新歌，并排除当前队列里已有的歌
  // - local：沿用 fresh 反馈重排本地 program
  const program = onlineMode ? null : await applyFeedbackAndBuildProgram("fresh");
  const nextTracks = onlineMode
    ? (
        await buildOnlineClaudioTracks({
          input: `${job.sessionTitle} ${job.currentTrack?.artist || ""} fresh`,
          count: Math.max(1, job.count),
          exclude: state.tracks,
        })
      ).tracks
    : toClaudioTrack(program!).slice(1, 1 + Math.max(1, job.count));
  const startIndex = state.tracks.length;

  if (!nextTracks.length) {
    return {
      type: "tracks-ready" as const,
      programId: state.programId || job.programId,
      tracks: [],
      startIndex,
      failedTracks: [],
      reason: "empty-refill",
    };
  }

  const mergedTracks = [...state.tracks, ...nextTracks];
  setClaudioProgramContext({
    programId: state.programId || job.programId,
    sessionTitle: state.sessionTitle || program?.segmentTitle || job.sessionTitle,
    tracks: mergedTracks,
  });

  const payload = {
    type: "tracks-ready" as const,
    programId: state.programId || job.programId,
    tracks: nextTracks,
    startIndex,
    failedTracks: [],
    reason: onlineMode ? "online-refill" : "fresh-refill",
  };
  broadcastClaudioEvent(payload);

  const previousTrack = state.tracks[state.tracks.length - 1] || null;
  const previousIndex = Math.max(0, startIndex - 1);
  enqueueBridgeJobs({
    programId: state.programId || job.programId,
    sessionTitle: state.sessionTitle || program?.segmentTitle || job.sessionTitle,
    tracks: nextTracks,
    startIndex,
    previousTrack,
    previousIndex,
    djLanguage: job.djLanguage,
  });

  return payload;
}

function enqueueBridgeJobs({
  programId,
  sessionTitle,
  tracks,
  startIndex = 0,
  previousTrack = null,
  previousIndex = null,
  djLanguage = "en",
}: {
  programId: string;
  sessionTitle: string;
  tracks: ClaudioTrack[];
  startIndex?: number;
  previousTrack?: ClaudioTrack | null;
  previousIndex?: number | null;
  djLanguage?: "en" | "zh";
}) {
  // 桥段生成和播歌拆成独立 job：
  // 节目先把 tracks 发出去，桥段随后异步补，避免 live 等所有串词生成完才开始播。
  if (previousTrack && tracks.length) {
    enqueueClaudioJob({
      type: "bridge_generation",
      key: `bridge:${programId}:${previousIndex}:${startIndex}`,
      programId,
      sessionTitle,
      afterTrack: previousTrack,
      beforeTrack: tracks[0],
      afterTrackIndex: previousIndex ?? Math.max(0, startIndex - 1),
      beforeTrackIndex: startIndex,
      djLanguage,
    });
  }
  for (let index = 1; index < tracks.length; index += 1) {
    enqueueClaudioJob({
      type: "bridge_generation",
      key: `bridge:${programId}:${startIndex + index - 1}:${startIndex + index}`,
      programId,
      sessionTitle,
      afterTrack: tracks[index - 1],
      beforeTrack: tracks[index],
      afterTrackIndex: startIndex + index - 1,
      beforeTrackIndex: startIndex + index,
      djLanguage,
    });
  }
}

export async function runClaudioBridgeGenerationJob(job: ClaudioBridgeGenerationJob) {
  const prompt = await buildBridgePrompt({
    programTitle: job.sessionTitle,
    afterTrack: job.afterTrack,
    beforeTrack: job.beforeTrack,
    afterTrackIndex: job.afterTrackIndex,
    beforeTrackIndex: job.beforeTrackIndex,
    djLanguage: job.djLanguage,
  });
  const llmResult = await generateClaudioJson(prompt);
  let segments = await synthesizeSegments(
    normalizeSegments(
      Array.isArray(llmResult.segments) ? llmResult.segments : [],
      new Array(Math.max(job.beforeTrackIndex + 1, 1)).fill(null).map(() => ({
        query: "",
        title: "",
        artist: "",
        streamUrl: "",
      })),
      "",
    ).filter((segment) =>
      segment.position === "between_tracks" &&
      segment.afterTrackIndex === job.afterTrackIndex &&
      segment.beforeTrackIndex === job.beforeTrackIndex,
    ),
  );

  if (!segments.length) {
    segments = [
      {
        id: `bridge_silence_${job.afterTrackIndex}_${job.beforeTrackIndex}`,
        type: "silence",
        position: "between_tracks",
        afterTrackIndex: job.afterTrackIndex,
        beforeTrackIndex: job.beforeTrackIndex,
        text: "",
        status: "silent",
      },
    ];
  }

  broadcastClaudioEvent({
    type: "segment-ready",
    programId: job.programId,
    segments,
  });
  return segments;
}
