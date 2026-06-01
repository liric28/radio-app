import type { Song } from "@/lib/types";

export function buildTrackLabel(title: string, artist: string) {
  const cleanTitle = String(title || "").trim();
  const cleanArtist = String(artist || "").trim();
  if (!cleanArtist) return cleanTitle;
  return `${cleanTitle} - ${cleanArtist}`;
}

export function trackLabelFromSong(song: Pick<Song, "title" | "artist">) {
  return buildTrackLabel(song.title, song.artist);
}
