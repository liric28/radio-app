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
  buildRuleBasedDjReply,
  buildChatModelMessages,
  describeAgentState,
} from "@/lib/providers/llm";
import { requestChatCompletion } from "@/lib/providers/chat-llm";
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
  directReply?: string;
};

type IntentResolution = {
  resolver: "rule" | "llm";
};

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

  return {
    mode: "chat",
    tool: "none",
    intent,
    summary: "用户在随意聊天，先正常接话。",
  };
}

async function inferOnlineFreeformIntent(message: string, program: RadioProgram): Promise<ChatIntent> {
  const nextTrack = program.queue[0];
  const prompt = [
    "你是音乐电台首页的意图路由器。",
    "任务：判断用户这句话是不是在要求你改当前推荐 LIST。",
    "只输出一行 JSON，不要解释，不要 markdown。",
    '允许的 action 只有：none, regenerate, fresh, calmer, familiar, skip, favorite, download-current, scene-change。',
    "规则：",
    "- 用户在随口描述想听什么风格、语言、气氛、艺人、时段、强度时，通常输出 regenerate。",
    "- 只有明显是“更安静/更轻/更慢”才用 calmer。",
    "- 只有明显是“更熟/回忆/老歌”才用 familiar。",
    "- 只有明显是“换新一点/换个感觉/更刺激”才用 fresh。",
    "- 只有明显是下载当前歌才用 download-current。",
    "- 只有明显是收藏当前歌才用 favorite。",
    "- 只有明显是跳过当前歌才用 skip。",
    "- 只有明显是切到某个时段才用 scene-change，并给 targetPeriod: morning/daytime/evening/late-night。",
    "- 普通闲聊、吐槽、问候、问你是谁、非音乐问题输出 none。",
    `当前时段: ${program.scene}`,
    `当前歌: ${program.currentTrack.artist} - ${program.currentTrack.title}`,
    `下一首: ${nextTrack ? `${nextTrack.artist} - ${nextTrack.title}` : "暂无"}`,
    `用户消息: ${message}`,
    '输出格式示例：{"action":"regenerate","targetPeriod":null}',
  ].join("\n");

  try {
    const raw = await requestChatCompletion(
      [
        { role: "system", content: "你是一个严格输出 JSON 的音乐意图分类器。" },
        { role: "user", content: prompt },
      ],
      120,
    );
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { action: "none" };
    const parsed = JSON.parse(jsonMatch[0]) as Partial<ChatIntent>;
    const action = parsed.action;
    if (
      action === "none" ||
      action === "regenerate" ||
      action === "fresh" ||
      action === "calmer" ||
      action === "familiar" ||
      action === "skip" ||
      action === "favorite" ||
      action === "download-current" ||
      action === "scene-change"
    ) {
      return {
        action,
        targetPeriod: parsed.targetPeriod,
      };
    }
  } catch {}

  return { action: "none" };
}

/**
 * 统一执行页内 agent：先判断意图，再调用对应工具，最后把回复上下文交给文案层。
 */
export async function runChatAgent({
  message,
  program,
  history,
}: RunChatAgentInput): Promise<RunChatAgentResult> {
  let initialState = resolveAgentState(message, program);
  let intentResolution: IntentResolution | null =
    initialState.mode === "music-control" ? { resolver: "rule" } : null;
  if (initialState.mode === "chat" && isOnlineRadioMode()) {
    const inferredIntent = await inferOnlineFreeformIntent(message, program);
    if (inferredIntent.action !== "none") {
      initialState = {
        mode: "music-control",
        tool: "schedule",
        intent: inferredIntent,
        summary: "用户在用自然语言改首页推荐，已转成明确电台动作。",
      };
      intentResolution = { resolver: "llm" };
    }
  }
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
      type: "intent_resolved",
      message,
      action: initialState.intent.action,
      scene: program.scene,
      track: preferenceTrackFromSong(program.currentTrack, program.scene),
      resolver: intentResolution?.resolver || "rule",
    }).catch(() => null);
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
    directReply:
      nextState.mode === "music-control"
        ? buildRuleBasedDjReply({
            message,
            program: nextProgram,
            memory,
            intent: nextState.intent,
            history,
            state: nextState,
          })
        : undefined,
  };
}
