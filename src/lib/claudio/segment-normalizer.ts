import type {
  ClaudioSegment,
  ClaudioSegmentPosition,
  ClaudioSegmentType,
  ClaudioTrack,
} from "@/lib/claudio/types";

const PROGRAM_START_ID_TEXT = "This is Claudio.";

type RawSegment = Partial<ClaudioSegment> & {
  text?: string;
};

const ALLOWED_TYPES = new Set<ClaudioSegmentType>([
  "cold_open",
  "bridge",
  "quick_touch",
  "back_announce",
  "silence",
]);

const ALLOWED_POSITIONS = new Set<ClaudioSegmentPosition>([
  "before_track",
  "between_tracks",
  "after_track",
  "immediate",
]);

export function programStartIdSegment(programId: string): ClaudioSegment {
  return {
    id: `${programId}_station_id`,
    type: "cold_open",
    groupId: "open_0",
    part: "station_id",
    partIndex: 0,
    position: "before_track",
    trackIndex: 0,
    text: PROGRAM_START_ID_TEXT,
    status: "pending",
  };
}

function makeSegmentId(index: number) {
  return `seg_${Date.now()}_${index}`;
}

function splitSentences(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const pieces = normalized.match(/[^.!?。！？]+[.!?。！？"'’”)\]]*/g);
  return (pieces || [normalized]).map((part) => part.trim()).filter(Boolean);
}

function expandColdOpenParts(segments: ClaudioSegment[]) {
  const defaultParts = ["anchor", "heart", "turn", "image", "invitation"];
  const expanded: ClaudioSegment[] = [];

  for (const segment of segments) {
    if (segment.type !== "cold_open" || !segment.text || segment.part) {
      expanded.push(segment);
      continue;
    }

    const sentences = splitSentences(segment.text);
    if (sentences.length <= 1) {
      expanded.push(segment);
      continue;
    }

    const groupId = segment.groupId || segment.id || makeSegmentId(expanded.length);
    sentences.forEach((text, partIndex) => {
      expanded.push({
        ...segment,
        id: `${groupId}_${partIndex}`,
        groupId,
        part: defaultParts[partIndex] || "line",
        partIndex,
        partCount: sentences.length,
        text,
      });
    });
  }

  return expanded;
}

export function normalizeSegment(raw: RawSegment | null | undefined, index: number, trackCount: number) {
  if (!raw || typeof raw !== "object") return null;

  const type = ALLOWED_TYPES.has(raw.type as ClaudioSegmentType)
    ? (raw.type as ClaudioSegmentType)
    : "quick_touch";
  const defaultPosition: ClaudioSegmentPosition =
    type === "bridge" ? "between_tracks" : type === "cold_open" ? "before_track" : "immediate";
  const position = ALLOWED_POSITIONS.has(raw.position as ClaudioSegmentPosition)
    ? (raw.position as ClaudioSegmentPosition)
    : defaultPosition;

  const segment: ClaudioSegment = {
    id: raw.id || makeSegmentId(index),
    type,
    position,
    text: typeof raw.text === "string" ? raw.text.trim() : "",
    status: type === "silence" ? "silent" : "pending",
  };

  if (typeof raw.groupId === "string" && raw.groupId.trim()) segment.groupId = raw.groupId.trim();
  if (typeof raw.part === "string" && raw.part.trim()) segment.part = raw.part.trim();
  if (Number.isInteger(raw.partIndex)) segment.partIndex = Math.max(0, raw.partIndex as number);
  if (Number.isInteger(raw.partCount)) segment.partCount = Math.max(1, raw.partCount as number);
  if (typeof raw.ttsUrl === "string" && raw.ttsUrl) segment.ttsUrl = raw.ttsUrl;
  if (typeof raw.error === "string" && raw.error) segment.error = raw.error;
  if (raw.resetClockOnSpeak) segment.resetClockOnSpeak = true;

  if (Number.isInteger(raw.trackIndex)) {
    segment.trackIndex = Math.max(0, Math.min(raw.trackIndex as number, Math.max(0, trackCount - 1)));
  }
  if (Number.isInteger(raw.afterTrackIndex)) {
    segment.afterTrackIndex = Math.max(0, Math.min(raw.afterTrackIndex as number, Math.max(0, trackCount - 1)));
  }
  if (Number.isInteger(raw.beforeTrackIndex)) {
    segment.beforeTrackIndex = Math.max(0, Math.min(raw.beforeTrackIndex as number, Math.max(0, trackCount - 1)));
  }

  if (position === "before_track" && segment.trackIndex === undefined) segment.trackIndex = 0;
  if (position === "between_tracks") {
    if (segment.afterTrackIndex === undefined) {
      segment.afterTrackIndex = Math.max(0, (segment.beforeTrackIndex ?? index) - 1);
    }
    if (segment.beforeTrackIndex === undefined) {
      segment.beforeTrackIndex = Math.min(trackCount - 1, segment.afterTrackIndex + 1);
    }
  }

  if (!trackCount && ["before_track", "between_tracks", "after_track"].includes(position)) {
    segment.position = "immediate";
    delete segment.trackIndex;
    delete segment.afterTrackIndex;
    delete segment.beforeTrackIndex;
  }

  return segment;
}

export function normalizeSegments(
  rawSegments: RawSegment[] | null | undefined,
  tracks: ClaudioTrack[],
  fallbackSay?: string,
) {
  const trackCount = tracks.length;
  const segments = Array.isArray(rawSegments)
    ? rawSegments.map((item, index) => normalizeSegment(item, index, trackCount)).filter(Boolean) as ClaudioSegment[]
    : [];

  if (!segments.length && fallbackSay?.trim()) {
    const normalized = normalizeSegment(
      {
        type: tracks.length ? "cold_open" : "quick_touch",
        position: tracks.length ? "before_track" : "immediate",
        trackIndex: 0,
        text: fallbackSay,
      },
      0,
      trackCount,
    );
    if (normalized) segments.push(normalized);
  }

  return expandColdOpenParts(segments).map((segment, index) => ({
    ...segment,
    id: segment.id || makeSegmentId(index),
  }));
}

export function applyLegacyTrackIntrosFromSegments(
  tracks: ClaudioTrack[],
  segments: ClaudioSegment[],
) {
  for (const segment of segments) {
    if (!segment.ttsUrl || !segment.text) continue;
    if (segment.position === "between_tracks" && Number.isInteger(segment.beforeTrackIndex)) {
      const beforeTrackIndex = segment.beforeTrackIndex as number;
      const track = tracks[beforeTrackIndex];
      if (track && !track.introTtsUrl) {
        track.introTtsUrl = segment.ttsUrl;
        track.introTranscript = segment.text;
        track.segmentId = segment.id;
      }
    }
  }
}
