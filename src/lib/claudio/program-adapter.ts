import {
  applyFeedbackAndBuildProgram,
  buildRadioProgram,
} from "@/lib/radio-engine";
import { buildBridgePrompt, buildColdOpenForTracksPrompt } from "@/lib/claudio/context";
import { buildOnlineClaudioTracks } from "@/lib/claudio/live-music";
import { generateClaudioJson } from "@/lib/claudio/llm";
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
const LIVE_MUSIC_MODE = process.env.CLAUDIO_LIVE_MUSIC_MODE || "online";

function toClaudioTrack(program: RadioProgram): ClaudioTrack[] {
  return [program.currentTrack, ...program.queue].map((track) => ({
    query: `${track.title}${track.artist ? ` - ${track.artist}` : ""}`,
    title: track.title,
    artist: track.artist,
    streamUrl: track.sourcePath ? `/api/audio?path=${encodeURIComponent(track.sourcePath)}` : "",
    sourceSong: track,
  }));
}

function programTranscript(program: RadioProgram) {
  return [program.hostIntro, ...program.explanation].filter(Boolean).join("\n\n");
}

async function synthesizeSegments(segments: ClaudioSegment[]) {
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
  const program = onlineMode ? null : await buildRadioProgram();
  const online = onlineMode
    ? await buildOnlineClaudioTracks({
        input: job.input,
      })
    : null;
  const tracks = onlineMode ? online?.tracks || [] : toClaudioTrack(program!);
  if (!tracks.length) {
    throw new Error("Claudio live 没有搜到可播放的在线歌曲");
  }
  const programId = `claudio_${Date.now()}`;
  const llmPrompt = await buildColdOpenForTracksPrompt({
    programTitle: onlineMode ? online?.sessionTitle || "Live" : program!.segmentTitle,
    tracks,
    userInput: job.input,
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
    reason: llmResult.reason || (onlineMode ? online?.reason : job.input),
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
    reason: llmResult.reason || (onlineMode ? online?.reason : job.input),
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
