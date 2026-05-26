import { readPlaylistProfiles, readRoutineProfiles, readTasteProfile } from "@/lib/profile";

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
