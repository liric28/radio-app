import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/paths";
import type { Song } from "@/lib/types";

const eventsPath = path.join(dataDir, "preference-events.jsonl");
const modelPath = path.join(dataDir, "preference-model.json");

export type PreferenceTrackSnapshot = {
  id: string;
  title: string;
  artist: string;
  language?: string;
  energy?: number;
  tags?: string[];
  source?: string;
  scene?: string;
};

export type PreferenceEvent = {
  ts: string;
  type:
    | "recommendation_generated"
    | "chat_request"
    | "favorite"
    | "download"
    | "replay"
    | "playback_interrupted"
    | "playback_completed";
  message?: string;
  action?: string;
  scene?: string;
  seed?: string;
  source?: string;
  track?: PreferenceTrackSnapshot | null;
  queue?: PreferenceTrackSnapshot[];
  playbackSeconds?: number;
  playbackRatio?: number;
};

export type PreferenceModel = {
  updatedAt: string;
  totalEvents: number;
  artistAffinity: Record<string, number>;
  languageAffinity: Record<string, number>;
  tagAffinity: Record<string, number>;
  energyPreferenceByScene: Record<string, number>;
  negativeSignals: Record<string, number>;
  requestPatternStats: Record<string, number>;
};

const EMPTY_MODEL: PreferenceModel = {
  updatedAt: "",
  totalEvents: 0,
  artistAffinity: {},
  languageAffinity: {},
  tagAffinity: {},
  energyPreferenceByScene: {},
  negativeSignals: {},
  requestPatternStats: {},
};

const REQUEST_PATTERNS = [
  "华语", "中文", "粤语", "英文", "英语", "日语", "韩语",
  "女声", "男声", "器乐", "电子", "摇滚", "民谣", "说唱", "爵士", "city pop",
  "安静", "轻一点", "慢一点", "深夜", "早上", "通勤", "熟悉", "新一点", "别太炸",
  "劲爆", "炸一点", "炸", "推起来", "有冲劲", "热一点",
];

function bump(map: Record<string, number>, key: string | undefined, value: number) {
  const normalized = String(key || "").trim();
  if (!normalized) return;
  map[normalized] = Number(((map[normalized] || 0) + value).toFixed(3));
}

function scoreEvent(event: PreferenceEvent) {
  switch (event.type) {
    case "favorite":
      return 3;
    case "download":
      return 2.5;
    case "replay":
      return 2;
    case "playback_completed":
      return 1.5;
    case "playback_interrupted":
      return (event.playbackRatio || 0) < 0.2 ? -2 : -0.5;
    default:
      return 0;
  }
}

function summarizeTrack(song: Song, scene?: string): PreferenceTrackSnapshot {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    language: song.language,
    energy: song.energy,
    tags: song.tags,
    source: song.source,
    scene,
  };
}

function extractRequestPatterns(message: string | undefined) {
  const normalized = String(message || "").toLowerCase();
  if (!normalized) return [];
  return REQUEST_PATTERNS.filter((pattern) => normalized.includes(pattern.toLowerCase()));
}

export async function readPreferenceEvents() {
  try {
    const raw = await fs.readFile(eventsPath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PreferenceEvent);
  } catch {
    return [];
  }
}

export async function buildPreferenceModel(events?: PreferenceEvent[]) {
  const sourceEvents = events || (await readPreferenceEvents());
  const energySums = new Map<string, { sum: number; count: number }>();
  const model: PreferenceModel = {
    ...EMPTY_MODEL,
    updatedAt: new Date().toISOString(),
    totalEvents: sourceEvents.length,
  };

  for (const event of sourceEvents) {
    const weight = scoreEvent(event);
    const track = event.track;

    if (event.type === "chat_request") {
      for (const pattern of extractRequestPatterns(event.message)) {
        bump(model.requestPatternStats, pattern, 1);
      }
    }

    if (!track) continue;

    if (weight !== 0) {
      bump(model.artistAffinity, track.artist, weight);
      bump(model.languageAffinity, track.language, weight);
      for (const tag of track.tags || []) bump(model.tagAffinity, tag, weight);

      if (typeof track.energy === "number" && track.scene) {
        const current = energySums.get(track.scene) || { sum: 0, count: 0 };
        current.sum += track.energy * Math.abs(weight);
        current.count += Math.abs(weight);
        energySums.set(track.scene, current);
      }

      if (weight < 0) {
        bump(model.negativeSignals, track.artist, Math.abs(weight));
        bump(model.negativeSignals, track.language, Math.abs(weight) * 0.5);
      }
    }
  }

  for (const [scene, value] of energySums.entries()) {
    model.energyPreferenceByScene[scene] = Number((value.sum / Math.max(value.count, 1)).toFixed(2));
  }

  await fs.writeFile(modelPath, `${JSON.stringify(model, null, 2)}\n`, "utf8");
  return model;
}

export async function readPreferenceModel() {
  try {
    const raw = await fs.readFile(modelPath, "utf8");
    return JSON.parse(raw) as PreferenceModel;
  } catch {
    return buildPreferenceModel();
  }
}

export async function appendPreferenceEvent(event: Omit<PreferenceEvent, "ts"> & { ts?: string }) {
  const payload: PreferenceEvent = {
    ts: event.ts || new Date().toISOString(),
    ...event,
  };
  await fs.mkdir(path.dirname(eventsPath), { recursive: true });
  await fs.appendFile(eventsPath, `${JSON.stringify(payload)}\n`, "utf8");
  await buildPreferenceModel();
  return payload;
}

export function preferenceTrackFromSong(song: Song, scene?: string) {
  return summarizeTrack(song, scene);
}
