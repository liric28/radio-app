import { readMemory } from "@/lib/memory";
import { readPlaylistProfiles, readRoutineProfiles, readSongCatalog, readTasteProfile } from "@/lib/profile";

function normalizeDjLanguage(language: string | undefined) {
  return language === "zh" ? "zh" : "en";
}

function djLanguageInstruction(language: string, scope = "spoken segment text") {
  if (normalizeDjLanguage(language) === "zh") {
    return `All ${scope} must be in natural, restrained Chinese. Keep song titles and artist names in their original language for accurate music search.`;
  }
  return `All ${scope} must be in English unless the listener explicitly requests Chinese.`;
}

function coldOpenLengthInstruction(language: string) {
  return normalizeDjLanguage(language) === "zh"
    ? "The full cold open should use concrete musical detail and connect to the current moment, usually 120-220 Chinese characters across all cold_open parts."
    : "The full cold open should use concrete musical detail and connect to the current moment, usually 80-140 English words across all cold_open parts.";
}

function topUnique(values: Array<string | undefined>, limit: number) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].slice(0, limit);
}

export async function buildLiveStartIntentPrompt({
  djLanguage = "en",
}: {
  djLanguage?: string;
}) {
  const [taste, playlists, routines, memory, songs] = await Promise.all([
    readTasteProfile(),
    readPlaylistProfiles(),
    readRoutineProfiles(),
    readMemory(),
    readSongCatalog().catch(() => []),
  ]);
  const normalizedLanguage = normalizeDjLanguage(djLanguage);
  const currentHour = new Date().getHours();
  const currentPeriod = currentHour < 9 ? "morning" : currentHour < 18 ? "daytime" : currentHour < 23 ? "evening" : "late-night";
  const currentRoutine = routines.find((item) => item.period === currentPeriod);
  const recentTracks = topUnique(memory.recentTrackIds, 5);
  const recentProgramTitles = topUnique(memory.recentProgramTitles.slice(-6), 6);
  const localAnchorSongs = topUnique(
    songs
      .filter((song) => taste.anchorArtists.includes(song.artist) || song.tags?.includes("导入") || song.source === "local" || song.sourcePath)
      .slice(0, 8)
      .map((song) => `${song.title} — ${song.artist}`),
    6,
  );
  const playlistHints = topUnique(
    playlists.flatMap((playlist) => [playlist.name, playlist.summary, ...(playlist.tags || [])]),
    6,
  );

  return [
    `# DJ Persona\n${taste.radioPersona}`,
    "# Task\nGenerate one short kickoff intent for a live radio session. This is not on-air copy. This is an internal seed used to search tracks and shape the cold open.",
    `# Current Period\n${currentPeriod}`,
    currentRoutine?.scene ? `# Current Scene\n${currentRoutine.scene}` : "",
    taste.anchorArtists.length ? `# Anchor Artists\n${taste.anchorArtists.slice(0, 6).join(", ")}` : "",
    taste.favoriteMoods.length ? `# Favorite Moods\n${taste.favoriteMoods.slice(0, 6).join(", ")}` : "",
    playlistHints.length ? `# Playlist Hints\n${playlistHints.join(" | ")}` : "",
    localAnchorSongs.length ? `# Familiar Local Library Anchors\n${localAnchorSongs.join("\n")}` : "",
    recentTracks.length ? `# Recently Played Tracks\n${recentTracks.join("\n")}` : "",
    recentProgramTitles.length ? `# Avoid Repeating Recent Session Angles\n${recentProgramTitles.join("\n")}` : "",
    [
      "Strictly output JSON only, with no extra text.",
      "Return only: {\"input\":\"...\",\"reason\":\"...\"}.",
      djLanguageInstruction(normalizedLanguage, "input and reason"),
      "The input must be one compact sentence.",
      "Do not write a title. Do not write multiple options. Do not include quotes.",
      "Use the local library familiarity as a first instinct when possible, especially around anchor artists, imported songs, and emotionally recognizable songs.",
      "Avoid repeating the framing, metaphors, and emotional angle of recent session titles listed above.",
      "Make it specific enough to steer both search and spoken cold open, but short enough to act as a seed.",
      "Good examples: \"Lean into familiar late-night Chinese city-pop and pull a few songs that feel privately remembered.\"",
      "{\"input\":\"One compact kickoff sentence.\",\"reason\":\"One short internal reason.\"}",
    ].join("\n"),
  ].filter(Boolean).join("\n\n");
}

export async function buildColdOpenForTracksPrompt({
  programTitle = "",
  tracks = [],
  userInput = "",
  djLanguage = "en",
}: {
  programTitle?: string;
  tracks?: Array<{ title?: string; query?: string; artist?: string }>;
  userInput?: string;
  djLanguage?: string;
}) {
  const [taste, playlists, routines] = await Promise.all([
    readTasteProfile(),
    readPlaylistProfiles(),
    readRoutineProfiles(),
  ]);
  const normalizedLanguage = normalizeDjLanguage(djLanguage);
  const trackText = tracks.length
    ? tracks.map((track, index) => `${index}. ${track.title || track.query}${track.artist ? ` — ${track.artist}` : ""}`).join("\n")
    : "（无可播放歌曲）";

  return [
    `# DJ Persona\n${taste.radioPersona}`,
    `# Playlist Summary\n${playlists[0]?.summary || ""}`,
    `# Routine Scenes\n${routines.map((routine) => `${routine.period}: ${routine.scene}`).join("\n")}`,
    "# Task\ncold_open_for_resolved_tracks：根据已经确认可播放的真实歌曲生成开场播报。",
    programTitle ? `# Program Title\n${programTitle}` : "",
    userInput ? `# User Intent\n${userInput}` : "",
    `# Confirmed Playable Tracks\n${trackText}`,
    [
      "Strictly output JSON only, with no extra text.",
      "Return only: {\"segments\":[...],\"reason\":\"internal reason\"}.",
      djLanguageInstruction(normalizedLanguage, "cold_open segment text"),
      "The opening is for trackIndex 0 and must introduce the first confirmed playable track.",
      "If you mention a song title or artist, it must exactly be from the confirmed playable song list above.",
      "Do not mention or describe any song that is not in the confirmed playable song list.",
      "The segments array must contain only cold_open segments for trackIndex 0.",
      "Write 3-5 consecutive cold_open segments, each one sentence, same position before_track and trackIndex 0.",
      coldOpenLengthInstruction(normalizedLanguage),
      "Use optional part values: anchor, heart, turn, image, invitation.",
      "{\"segments\":[{\"type\":\"cold_open\",\"groupId\":\"open_0\",\"part\":\"anchor\",\"position\":\"before_track\",\"trackIndex\":0,\"text\":\"One sentence about the exact first confirmed track.\"},{\"type\":\"cold_open\",\"groupId\":\"open_0\",\"part\":\"turn\",\"position\":\"before_track\",\"trackIndex\":0,\"text\":\"One sentence that stays accurate to the confirmed tracks.\"},{\"type\":\"cold_open\",\"groupId\":\"open_0\",\"part\":\"invitation\",\"position\":\"before_track\",\"trackIndex\":0,\"text\":\"One short sentence into the first track.\"}],\"reason\":\"internal reason\"}",
    ].join("\n"),
  ].filter(Boolean).join("\n\n");
}

export async function buildBridgePrompt({
  programTitle = "",
  afterTrack,
  beforeTrack,
  afterTrackIndex,
  beforeTrackIndex,
  djLanguage = "en",
}: {
  programTitle?: string;
  afterTrack: { title?: string; query?: string; artist?: string };
  beforeTrack: { title?: string; query?: string; artist?: string };
  afterTrackIndex: number;
  beforeTrackIndex: number;
  djLanguage?: string;
}) {
  const [taste] = await Promise.all([readTasteProfile()]);
  const normalizedLanguage = normalizeDjLanguage(djLanguage);
  const afterText = `${afterTrack?.title || afterTrack?.query || "previous track"}${afterTrack?.artist ? ` — ${afterTrack.artist}` : ""}`;
  const beforeText = `${beforeTrack?.title || beforeTrack?.query || "next track"}${beforeTrack?.artist ? ` — ${beforeTrack.artist}` : ""}`;

  return [
    `# DJ Persona\n${taste.radioPersona}`,
    "# Task\nbridge_generation：只生成从上一首到下一首的歌曲缝隙播报，或明确选择 silence。",
    programTitle ? `# Program Title\n${programTitle}` : "",
    `# Previous Track\nindex ${afterTrackIndex}: ${afterText}`,
    `# Next Track\nindex ${beforeTrackIndex}: ${beforeText}`,
    [
      "Strictly output JSON only, with no extra text.",
      djLanguageInstruction(normalizedLanguage, "bridge segment text"),
      "Return only {\"segments\":[...],\"reason\":\"internal reason\"}.",
      "Output either 1-3 sentence-level bridge segments OR one silence segment.",
      "For bridge segments, use the same groupId, position between_tracks, and exact afterTrackIndex/beforeTrackIndex provided.",
      "Do not write a recommendation explanation. This is live radio at the seam.",
      "If there is nothing worth saying, return one silence segment with text \"\".",
      `{"segments":[{"type":"bridge","groupId":"bridge_${afterTrackIndex}_${beforeTrackIndex}","part":"back_announce","position":"between_tracks","afterTrackIndex":${afterTrackIndex},"beforeTrackIndex":${beforeTrackIndex},"text":"One sentence."},{"type":"bridge","groupId":"bridge_${afterTrackIndex}_${beforeTrackIndex}","part":"handoff","position":"between_tracks","afterTrackIndex":${afterTrackIndex},"beforeTrackIndex":${beforeTrackIndex},"text":"One sentence into the next track."}],"reason":"internal reason"}`,
    ].join("\n"),
  ].filter(Boolean).join("\n\n");
}
