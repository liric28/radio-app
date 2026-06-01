import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "@/lib/paths";
import { buildTrackLabel } from "@/lib/track-labels";
import { migrateStoredTrackLabels } from "@/lib/track-labels-server";

const favoritesPath = path.join(dataDir, "favorites.json");

export async function readFavorites() {
  try {
    const raw = await fs.readFile(favoritesPath, "utf8");
    const ids = JSON.parse(raw) as string[];
    if (!Array.isArray(ids)) return [];
    const migrated = await migrateStoredTrackLabels(ids);
    if (JSON.stringify(migrated) !== JSON.stringify(ids)) {
      await writeFavorites(migrated);
    }
    return migrated;
  } catch {
    return [];
  }
}

export async function writeFavorites(ids: string[]) {
  await fs.mkdir(path.dirname(favoritesPath), { recursive: true });
  await fs.writeFile(favoritesPath, `${JSON.stringify(ids, null, 2)}\n`, "utf8");
}

export async function updateFavorite(
  track: { title: string; artist: string },
  action: "add" | "remove",
) {
  const ids = await readFavorites();
  const trackLabel = buildTrackLabel(track.title, track.artist);
  const next =
    action === "add"
      ? ids.includes(trackLabel) ? ids : [...ids, trackLabel]
      : ids.filter((id) => id !== trackLabel);
  await writeFavorites(next);
  return next;
}
