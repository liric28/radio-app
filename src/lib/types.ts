export type UserTasteProfile = {
  favoriteEras: string[];
  favoriteMoods: string[];
  favoriteLanguages: string[];
  anchorArtists: string[];
  radioPersona: string;
  localSongs?: string[];
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
  /**
   * 入库渠道，区分调度策略和 UI 提示：
   * - "local"：本地 import-library 扫描而来（默认，向后兼容字段缺失情况）
   * - "kugou"：通过网络搜索下载到 data/downloads/ 的曲目，PayType=0 免费试听版本
   * - "qq" / "netease"：通过搜索结果下载到 data/downloads/ 的网络曲目
   */
  source?: "local" | "kugou" | "qq" | "netease";
  /**
   * 在线推荐时保留原始搜索命中，供“下载当前这首”这类动作复用。
   */
  downloadContext?: {
    source: "kugou" | "qq" | "netease";
    duration: number;
    payable: boolean;
    downloadable: boolean;
    albumName?: string;
    imageUrl?: string | null;
    raw: unknown;
  };
  /**
   * 在线推荐时直接返回远端可播地址；本地文件场景留空。
   */
  streamUrl?: string;
  /**
   * 本地音乐库根目录，导入时记录。播放时用 libraryRoot + sourcePath 拼接完整路径。
   * 网络来源（kugou/qq/netease）此字段为空。
   */
  libraryRoot?: string;
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
  | "regenerate"
  | "fresh"
  | "calmer"
  | "familiar"
  | "favorite"
  | "download-current"
  | "select-track"
  | "scene-change";

export type ChatIntent = {
  action: ChatIntentAction;
  trackId?: string;
  targetPeriod?: string;
};

export type ChatAgentMode = "chat" | "weather" | "music-control";

export type ChatAgentTool = "none" | "weather" | "schedule";

export type ChatAgentState = {
  mode: ChatAgentMode;
  tool: ChatAgentTool;
  intent: ChatIntent;
  summary: string;
  weather?: WeatherSnapshot | null;
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

export type WeatherSnapshot = {
  locationLabel: string;
  temperatureC: number;
  conditionText: string;
  daytimeHighC?: number;
  daytimeLowC?: number;
};
