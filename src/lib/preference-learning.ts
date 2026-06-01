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
  recommendationSourceLabel?: string;
};

export type PreferenceEvent = {
  ts: string;
  type:
    | "recommendation_generated"
    | "chat_request"
    | "intent_resolved"
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
  resolver?: "rule" | "llm";
};

export type PreferenceModel = {
  updatedAt: string;
  totalEvents: number;
  artistAffinity: Record<string, number>;
  artistAffinityByScene: Record<string, Record<string, number>>;
  languageAffinity: Record<string, number>;
  languageAffinityByScene: Record<string, Record<string, number>>;
  tagAffinity: Record<string, number>;
  tagAffinityByScene: Record<string, Record<string, number>>;
  energyPreferenceByScene: Record<string, number>;
  negativeSignals: Record<string, number>;
  negativeSignalsByScene: Record<string, Record<string, number>>;
  requestPatternStats: Record<string, number>;
};

export type PreferenceInsights = {
  updatedAt: string;
  totalEvents: number;
  recentEvents: Array<{
    ts: string;
    type: PreferenceEvent["type"];
    scene: string;
    trackLabel: string;
    action: string;
    playbackRatio: number | null;
  }>;
  topArtists: string[];
  topLanguages: string[];
  topTags: string[];
  topRequestPatterns: string[];
  sceneProfiles: Array<{
    scene: string;
    topArtists: string[];
    topLanguages: string[];
    topTags: string[];
    avoidSignals: string[];
    preferredEnergy: number | null;
  }>;
  recommendationSourceStats: Array<{
    label: string;
    generated: number;
    completed: number;
    interrupted: number;
    favorite: number;
    download: number;
    completionRate: number;
  }>;
  recentIntentResolutions: Array<{
    ts: string;
    message: string;
    action: string;
    resolver: string;
    scene: string;
  }>;
};

const EMPTY_MODEL: PreferenceModel = {
  updatedAt: "",
  totalEvents: 0,
  artistAffinity: {},
  artistAffinityByScene: {},
  languageAffinity: {},
  languageAffinityByScene: {},
  tagAffinity: {},
  tagAffinityByScene: {},
  energyPreferenceByScene: {},
  negativeSignals: {},
  negativeSignalsByScene: {},
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

function bumpNested(
  map: Record<string, Record<string, number>>,
  bucket: string | undefined,
  key: string | undefined,
  value: number,
) {
  const normalizedBucket = String(bucket || "").trim();
  if (!normalizedBucket) return;
  if (!map[normalizedBucket]) map[normalizedBucket] = {};
  bump(map[normalizedBucket], key, value);
}

function getEventDecay(ts: string | undefined) {
  if (!ts) return 1;
  const eventTime = new Date(ts).getTime();
  if (Number.isNaN(eventTime)) return 1;
  const ageDays = Math.max(0, (Date.now() - eventTime) / (1000 * 60 * 60 * 24));
  return Number(Math.pow(0.5, ageDays / 30).toFixed(4));
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
    recommendationSourceLabel: song.recommendationMeta?.sourceLabel,
  };
}

function extractRequestPatterns(message: string | undefined) {
  const normalized = String(message || "").toLowerCase();
  if (!normalized) return [];
  return REQUEST_PATTERNS.filter((pattern) => normalized.includes(pattern.toLowerCase()));
}

function topEntries(map: Record<string, number>, limit: number) {
  return Object.entries(map)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([key, value]) => `${key} x${value.toFixed(1)}`);
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
    const decay = getEventDecay(event.ts);
    const weight = Number((scoreEvent(event) * decay).toFixed(3));
    const track = event.track;
    const scene = track?.scene || event.scene;

    if (event.type === "chat_request") {
      for (const pattern of extractRequestPatterns(event.message)) {
        bump(model.requestPatternStats, pattern, decay);
      }
    }

    if (!track) continue;

    if (weight !== 0) {
      bump(model.artistAffinity, track.artist, weight);
      bumpNested(model.artistAffinityByScene, scene, track.artist, weight);
      bump(model.languageAffinity, track.language, weight);
      bumpNested(model.languageAffinityByScene, scene, track.language, weight);
      for (const tag of track.tags || []) bump(model.tagAffinity, tag, weight);
      for (const tag of track.tags || []) bumpNested(model.tagAffinityByScene, scene, tag, weight);

      if (typeof track.energy === "number" && scene) {
        const current = energySums.get(scene) || { sum: 0, count: 0 };
        current.sum += track.energy * Math.abs(weight);
        current.count += Math.abs(weight);
        energySums.set(scene, current);
      }

      if (weight < 0) {
        bump(model.negativeSignals, track.artist, Math.abs(weight));
        bump(model.negativeSignals, track.language, Math.abs(weight) * 0.5);
        for (const tag of track.tags || []) bump(model.negativeSignals, tag, Math.abs(weight) * 0.4);
        bumpNested(model.negativeSignalsByScene, scene, track.artist, Math.abs(weight));
        bumpNested(model.negativeSignalsByScene, scene, track.language, Math.abs(weight) * 0.5);
        for (const tag of track.tags || []) {
          bumpNested(model.negativeSignalsByScene, scene, tag, Math.abs(weight) * 0.4);
        }
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

export async function readPreferenceInsights(): Promise<PreferenceInsights> {
  const [model, events] = await Promise.all([
    readPreferenceModel(),
    readPreferenceEvents(),
  ]);

  const sceneNames = [...new Set([
    ...Object.keys(model.artistAffinityByScene),
    ...Object.keys(model.languageAffinityByScene),
    ...Object.keys(model.tagAffinityByScene),
    ...Object.keys(model.negativeSignalsByScene),
    ...Object.keys(model.energyPreferenceByScene),
  ])].filter(Boolean);

  const latestRecommendationSourceByTrackId = new Map<string, string>();
  const recommendationSourceStats = new Map<string, {
    generated: number;
    completed: number;
    interrupted: number;
    favorite: number;
    download: number;
  }>();

  function ensureSourceBucket(label: string) {
    if (!recommendationSourceStats.has(label)) {
      recommendationSourceStats.set(label, {
        generated: 0,
        completed: 0,
        interrupted: 0,
        favorite: 0,
        download: 0,
      });
    }
    return recommendationSourceStats.get(label)!;
  }

  for (const event of events) {
    if (event.type === "recommendation_generated") {
      for (const track of event.queue || []) {
        const label = track.recommendationSourceLabel || "unknown";
        latestRecommendationSourceByTrackId.set(track.id, label);
        ensureSourceBucket(label).generated += 1;
      }
      continue;
    }

    const trackId = event.track?.id;
    const label =
      event.track?.recommendationSourceLabel ||
      (trackId ? latestRecommendationSourceByTrackId.get(trackId) : undefined);
    if (!label) continue;
    const bucket = ensureSourceBucket(label);
    if (event.type === "playback_completed") bucket.completed += 1;
    if (event.type === "playback_interrupted") bucket.interrupted += 1;
    if (event.type === "favorite") bucket.favorite += 1;
    if (event.type === "download") bucket.download += 1;
  }

  return {
    updatedAt: model.updatedAt,
    totalEvents: model.totalEvents,
    recentEvents: events
      .slice(-12)
      .reverse()
      .map((event) => ({
        ts: event.ts,
        type: event.type,
        scene: event.scene || event.track?.scene || "-",
        trackLabel: event.track ? `${event.track.title} - ${event.track.artist}` : "-",
        action: event.action || "-",
        playbackRatio: typeof event.playbackRatio === "number" ? Number(event.playbackRatio.toFixed(2)) : null,
      })),
    topArtists: topEntries(model.artistAffinity, 8),
    topLanguages: topEntries(model.languageAffinity, 6),
    topTags: topEntries(model.tagAffinity, 8),
    topRequestPatterns: topEntries(model.requestPatternStats, 8),
    sceneProfiles: sceneNames
      .map((scene) => ({
        scene,
        topArtists: topEntries(model.artistAffinityByScene[scene] || {}, 4),
        topLanguages: topEntries(model.languageAffinityByScene[scene] || {}, 4),
        topTags: topEntries(model.tagAffinityByScene[scene] || {}, 5),
        avoidSignals: topEntries(model.negativeSignalsByScene[scene] || {}, 5),
        preferredEnergy:
          typeof model.energyPreferenceByScene[scene] === "number"
            ? model.energyPreferenceByScene[scene]
            : null,
      }))
      .sort((left, right) => left.scene.localeCompare(right.scene)),
    recommendationSourceStats: [...recommendationSourceStats.entries()]
      .map(([label, value]) => ({
        label,
        ...value,
        completionRate:
          value.completed + value.interrupted > 0
            ? Number((value.completed / (value.completed + value.interrupted)).toFixed(2))
            : 0,
      }))
      .sort((left, right) => right.generated - left.generated),
    recentIntentResolutions: events
      .filter((event) => event.type === "intent_resolved")
      .slice(-12)
      .reverse()
      .map((event) => ({
        ts: event.ts,
        message: event.message || "-",
        action: event.action || "none",
        resolver: event.resolver || "-",
        scene: event.scene || event.track?.scene || "-",
      })),
  };
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
