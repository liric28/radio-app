import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/paths";
import { readSongCatalog } from "@/lib/profile";
import { buildTrackLabel, trackLabelFromSong } from "@/lib/track-labels";
import type { Song } from "@/lib/types";

const onlineStatePath = path.join(dataDir, "online-radio-state.json");
const preferenceEventsPath = path.join(dataDir, "preference-events.jsonl");

async function readOnlineTrackLookup() {
  const lookup = new Map<string, string>();

  try {
    const raw = await fs.readFile(onlineStatePath, "utf8");
    const state = JSON.parse(raw) as {
      program?: { currentTrack?: Song; queue?: Song[] };
    };
    const tracks = [
      state.program?.currentTrack,
      ...(state.program?.queue || []),
    ].filter(Boolean) as Song[];
    for (const track of tracks) {
      lookup.set(track.id, trackLabelFromSong(track));
    }
  } catch {
    // ignore
  }

  try {
    const raw = await fs.readFile(preferenceEventsPath, "utf8");
    for (const line of raw.split("\n").map((item) => item.trim()).filter(Boolean)) {
      const event = JSON.parse(line) as {
        track?: { id?: string; title?: string; artist?: string };
        queue?: Array<{ id?: string; title?: string; artist?: string }>;
      };
      const tracks = [
        event.track,
        ...(event.queue || []),
      ].filter(Boolean) as Array<{ id?: string; title?: string; artist?: string }>;
      for (const track of tracks) {
        if (track.id && track.title && track.artist) {
          lookup.set(track.id, buildTrackLabel(track.title, track.artist));
        }
      }
    }
  } catch {
    // ignore
  }

  return lookup;
}

export async function resolveTrackLabelLookup() {
  const songs = await readSongCatalog().catch(() => []);
  const lookup = new Map<string, string>();
  for (const song of songs) {
    lookup.set(song.id, trackLabelFromSong(song));
  }
  const onlineLookup = await readOnlineTrackLookup();
  for (const [key, value] of onlineLookup.entries()) {
    lookup.set(key, value);
  }
  return lookup;
}

export async function migrateStoredTrackLabels(values: string[]) {
  const lookup = await resolveTrackLabelLookup();
  return values.map((value) => lookup.get(value) || value).filter(Boolean);
}
