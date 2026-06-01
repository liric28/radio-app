/**
 * 聊天 Agent 编排层：消息进来 → 判定意图 → 调对应工具 → 装配给 LLM 的 messages。
 *
 * /api/agent route 的唯一入口，下游只剩模型出 token 这一步流式发回前端。
 *
 * 三种 mode：
 *   - weather：触发关键词（天气/温度/下雨等，见 weather.isWeatherQuestion）
 *              → 调 readWeatherSnapshot，结果塞进 state.weather
 *   - music-control：resolveChatIntent 命中（切歌 / 切段 / 反馈）
 *              → 调 applyChatIntentWithProgram 真的改 program / schedule
 *   - chat：什么都没命中，纯闲聊，不调任何工具
 *
 * 输出 RunChatAgentResult：
 *   - state：含 mode/tool/intent/summary/weather，给前端做 SSE 第一帧
 *   - program / schedule：可能被工具改过，前端 setProgram/setSchedule
 *   - llmMessages：装配好的 LLM 提示词，route 直接转发给当前模型
 *
 * 注意：所有控制动作（切歌切段等）在 runChatAgent 内部已经完成，
 *      模型只负责"用自然语言确认"，不再决定"要不要切"——避免幻觉。
 */
import { ensureDailySchedule } from "@/lib/daily-schedule";
import { readFavorites, updateFavorite } from "@/lib/favorites";
import { readMemory } from "@/lib/memory";
import { applyOnlineChatIntent, ensureOnlineRadioProgram } from "@/lib/online-radio";
import { appendPreferenceEvent, preferenceTrackFromSong } from "@/lib/preference-learning";
import { downloadAndIngestSong, toMusicSearchHitFromSong } from "@/lib/song-download";
import {
  buildChatModelMessages,
  describeAgentState,
} from "@/lib/providers/llm";
import { isOnlineRadioMode } from "@/lib/radio-mode";
import { applyChatIntentWithProgram, resolveChatIntent } from "@/lib/radio-engine";
import { isWeatherQuestion, readWeatherSnapshot } from "@/lib/weather";
import { deriveTasteProfileFromSongs } from "@/lib/local-library";
import { readSongCatalog, writeTasteProfile } from "@/lib/profile";
import type {
  ChatAgentState,
  ChatIntent,
  ChatMessage,
  RadioProgram,
} from "@/lib/types";

type RunChatAgentInput = {
  message: string;
  program: RadioProgram;
  history?: ChatMessage[];
};

type RunChatAgentResult = {
  state: ChatAgentState;
  program: RadioProgram;
  schedule: Awaited<ReturnType<typeof ensureDailySchedule>>;
  favorites: string[];
  llmMessages: Array<{ role: string; content: string }>;
};

const FREEFORM_MUSIC_REQUEST_VERBS = [
  "来点",
  "来首",
  "来一些",
  "来一轮",
  "放点",
  "播点",
  "整点",
  "换点",
  "切点",
  "给我点",
  "推荐点",
  "上点",
  "走点",
  "听点",
  "想听",
];

const FREEFORM_MUSIC_STYLE_HINTS = [
  "抒情",
  "dj",
  "上头",
  "摇滚",
  "劲爆",
  "炸",
  "轻一点",
  "轻点",
  "慢一点",
  "安静",
  "中文",
  "华语",
  "粤语",
  "英文",
  "英语",
  "日语",
  "韩语",
  "女声",
  "男声",
  "器乐",
  "电子",
  "民谣",
  "说唱",
  "爵士",
  "city pop",
  "通勤",
  "深夜",
  "早上",
  "白天",
  "专注",
  "热一点",
  "有力一点",
  "有冲劲",
  "别太炸",
  "新一点",
  "熟一点",
  "老歌",
];

const MUSIC_OBJECT_HINTS = [
  "歌",
  "音乐",
  "电台",
  "playlist",
  "list",
  "radio",
  "bgm",
  "旋律",
  "歌单",
];

function normalizeFreeformMusicRequest(message: string) {
  return message.trim().toLowerCase().replace(/\s+/g, " ");
}

function isFreeformMusicRequest(message: string) {
  const normalized = normalizeFreeformMusicRequest(message);
  if (!normalized) return false;

  const hasVerb = FREEFORM_MUSIC_REQUEST_VERBS.some((item) => normalized.includes(item));
  const hasStyleHint = FREEFORM_MUSIC_STYLE_HINTS.some((item) => normalized.includes(item));
  const hasMusicObject = MUSIC_OBJECT_HINTS.some((item) => normalized.includes(item));
  const looksLikeForSceneRequest =
    normalized.includes("适合") &&
    (normalized.includes("听") || normalized.includes("歌") || normalized.includes("音乐"));

  if (hasVerb && hasStyleHint) return true;
  if (hasVerb && hasMusicObject) return true;
  if (hasStyleHint && hasMusicObject) return true;
  if (looksLikeForSceneRequest && (hasStyleHint || hasMusicObject)) return true;

  return false;
}

/**
 * 判断这句话更像是在闲聊、控歌还是查外部天气，并收口成统一 agent 状态。
 */
function resolveAgentState(message: string, program: RadioProgram): ChatAgentState {
  if (isWeatherQuestion(message)) {
    return {
      mode: "weather",
      tool: "weather",
      intent: { action: "none" },
      summary: "用户在问天气这类外部事实。",
    };
  }

  const intent = resolveChatIntent(message, program);

  if (intent.action !== "none") {
    return {
      mode: "music-control",
      tool: "schedule",
      intent,
      summary: "用户在通过聊天改节目单或切歌。",
    };
  }

  if (isOnlineRadioMode() && isFreeformMusicRequest(message)) {
    const regenerateIntent: ChatIntent = {
      action: "regenerate",
      targetPeriod: intent.targetPeriod,
    };
    return {
      mode: "music-control",
      tool: "schedule",
      intent: regenerateIntent,
      summary: "用户在随口描述想听的方向，默认按这句话重组在线推荐。",
    };
  }

  return {
    mode: "chat",
    tool: "none",
    intent,
    summary: "用户在随意聊天，先正常接话。",
  };
}

/**
 * 统一执行页内 agent：先判断意图，再调用对应工具，最后把回复上下文交给文案层。
 */
export async function runChatAgent({
  message,
  program,
  history,
}: RunChatAgentInput): Promise<RunChatAgentResult> {
  const initialState = resolveAgentState(message, program);
  let nextProgram = program;
  let nextState = initialState;
  let nextFavorites = await readFavorites();

  if (initialState.mode === "weather") {
    const weather = await readWeatherSnapshot().catch(() => null);
    nextState = {
      ...initialState,
      weather,
      summary: weather
        ? `用户在问天气；当前天气是 ${weather.locationLabel} ${weather.conditionText} ${weather.temperatureC} 度。`
        : "用户在问天气，但当前没有拿到天气结果。",
    };
  }

  if (initialState.mode === "music-control") {
    await appendPreferenceEvent({
      type: "chat_request",
      message,
      action: initialState.intent.action,
      scene: program.scene,
      track: preferenceTrackFromSong(program.currentTrack, program.scene),
    }).catch(() => null);

    if (initialState.intent.action === "favorite") {
      nextFavorites = await updateFavorite(program.currentTrack, "add");
      await appendPreferenceEvent({
        type: "favorite",
        message,
        action: "favorite",
        scene: program.scene,
        track: preferenceTrackFromSong(program.currentTrack, program.scene),
      }).catch(() => null);
    } else if (initialState.intent.action === "download-current") {
      const hit = toMusicSearchHitFromSong(program.currentTrack);
      if (hit) {
        await downloadAndIngestSong(hit);
        const songs = await readSongCatalog();
        await writeTasteProfile(deriveTasteProfileFromSongs(songs));
        await appendPreferenceEvent({
          type: "download",
          message,
          action: "download-current",
          scene: program.scene,
          track: preferenceTrackFromSong(program.currentTrack, program.scene),
        }).catch(() => null);
      }
    }

    nextProgram = isOnlineRadioMode()
      ? (await applyOnlineChatIntent(initialState.intent, program, message)).program
      : (await applyChatIntentWithProgram(initialState.intent, program)) ?? program;
    nextState = {
      ...initialState,
      summary: describeAgentState({
        message,
        beforeProgram: program,
        afterProgram: nextProgram,
        state: initialState,
      }),
    };
  }

  const [memory, schedule] = await Promise.all([
    readMemory(),
    isOnlineRadioMode()
      ? ensureOnlineRadioProgram().then((result) => result.schedule)
      : ensureDailySchedule(),
  ]);
  return {
    state: nextState,
    program: nextProgram,
    schedule,
    favorites: nextFavorites,
    llmMessages: buildChatModelMessages({
      message,
      program: nextProgram,
      memory,
      intent: nextState.intent,
      history,
      state: nextState,
    }),
  };
}
