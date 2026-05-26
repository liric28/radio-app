import type { Song } from "@/lib/types";

export type ClaudioTrack = {
  query: string;
  title: string;
  artist: string;
  streamUrl: string;
  introTtsUrl?: string;
  introTranscript?: string;
  segmentId?: string;
  sourceSong?: Song;
};

export type ClaudioSegmentType =
  | "cold_open"
  | "bridge"
  | "quick_touch"
  | "back_announce"
  | "silence";

export type ClaudioSegmentPosition =
  | "before_track"
  | "between_tracks"
  | "after_track"
  | "immediate";

export type ClaudioSegmentStatus = "pending" | "ready" | "silent" | "tts_failed";

export type ClaudioSegment = {
  id: string;
  type: ClaudioSegmentType;
  position: ClaudioSegmentPosition;
  text: string;
  status: ClaudioSegmentStatus;
  ttsUrl?: string;
  error?: string;
  trackIndex?: number;
  afterTrackIndex?: number;
  beforeTrackIndex?: number;
  groupId?: string;
  part?: string;
  partIndex?: number;
  partCount?: number;
  resetClockOnSpeak?: boolean;
};

export type ClaudioProgramEvent =
  | {
      type: "program-start";
      programId: string;
      tracks: ClaudioTrack[];
      segments: ClaudioSegment[];
      sessionTitle: string;
      stationName: string;
      programName: string;
      failedTracks: string[];
      reason?: string;
    }
  | {
      type: "tracks-ready";
      programId: string;
      tracks: ClaudioTrack[];
      startIndex: number;
      failedTracks: string[];
      reason?: string;
    }
  | {
      type: "segment-ready";
      programId: string;
      segments: ClaudioSegment[];
    }
  | {
      type: "now-playing";
      ttsUrl: string | null;
      tracks: ClaudioTrack[];
      segments: ClaudioSegment[];
      sessionTitle: string;
      transcript: string;
      djNote?: string;
      reason?: string;
      mode: "speech-only" | "music";
      status: "queued" | "speaking";
      stationName: string;
      programName: string;
      trigger: string;
      failedTracks: string[];
    }
  | {
      type: "control";
      action: "next" | "pause" | "resume" | "volume";
      delta?: number;
    }
  | {
      type: "job-status";
      key: string;
      jobType: ClaudioJob["type"];
      status: "queued" | "running" | "failed" | "completed";
      error?: string;
    };

export type ClaudioProgramStartJob = {
  type: "program_start";
  key: string;
  input: string;
  source: string;
  djLanguage: "en" | "zh";
};

export type ClaudioMusicRefillJob = {
  type: "music_refill";
  key: string;
  programId: string;
  sessionTitle: string;
  currentTrack?: ClaudioTrack | null;
  previousTrack?: ClaudioTrack | null;
  previousIndex?: number;
  queue: ClaudioTrack[];
  queueLength: number;
  count: number;
  djLanguage: "en" | "zh";
};

export type ClaudioBridgeGenerationJob = {
  type: "bridge_generation";
  key: string;
  programId: string;
  sessionTitle: string;
  afterTrack: ClaudioTrack;
  beforeTrack: ClaudioTrack;
  afterTrackIndex: number;
  beforeTrackIndex: number;
  djLanguage: "en" | "zh";
};

export type ClaudioJob =
  | ClaudioProgramStartJob
  | ClaudioMusicRefillJob
  | ClaudioBridgeGenerationJob;

export type ClaudioStationState = {
  programId: string | null;
  sessionTitle: string;
  tracks: ClaudioTrack[];
  segments: ClaudioSegment[];
  generationJobs: ClaudioJob[];
  jobKeys: Set<string>;
  workerRunning: boolean;
  history: ClaudioProgramEvent[];
};
