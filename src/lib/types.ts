export type UserTasteProfile = {
  favoriteEras: string[];
  favoriteMoods: string[];
  favoriteLanguages: string[];
  anchorArtists: string[];
  radioPersona: string;
};

export type PlaylistProfile = {
  name: string;
  summary: string;
  tags: string[];
};

export type RoutineProfile = {
  period: string;
  scene: string;
  preferredMoods: string[];
};

export type MoodRule = {
  trigger: string;
  shiftTo: string;
  avoid: string[];
};

export type Song = {
  id: string;
  title: string;
  artist: string;
  year: number;
  mood: string;
  energy: number;
  language: string;
  tags: string[];
  reasonSeed: string;
  sourcePath?: string;
};

export type SongImportItem = {
  title: string;
  artist: string;
  year?: number | string;
  mood?: string;
  energy?: number | string;
  language?: string;
  tags?: string[] | string;
  reasonSeed?: string;
};

export type RadioMemory = {
  recentTrackIds: string[];
  recentProgramTitles: string[];
  feedbackBias: {
    calmer: number;
    familiar: number;
    fresh: number;
  };
  lastAction: string;
  playbackMode?: "continuous-random";
};

export type RadioProgram = {
  stationName: string;
  segmentTitle: string;
  scene: string;
  energyLabel: string;
  hostIntro: string;
  currentTrack: Song & { reason: string };
  queue: Array<Song & { reason: string }>;
  explanation: string[];
  controlsHint: string;
  memorySummary: string;
};

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
};

export type ChatIntentAction =
  | "none"
  | "skip"
  | "fresh"
  | "calmer"
  | "familiar"
  | "select-track";

export type ChatIntent = {
  action: ChatIntentAction;
  trackId?: string;
  targetPeriod?: string;
};

export type ScheduledTrack = Song & {
  reason: string;
};

export type DailyScheduleBlock = {
  period: string;
  scene: string;
  title: string;
  tracks: ScheduledTrack[];
};

export type DailySchedule = {
  date: string;
  stationName: string;
  currentBlockPeriod: string;
  currentTrackIndex: number;
  blocks: DailyScheduleBlock[];
};
