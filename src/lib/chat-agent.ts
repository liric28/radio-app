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
import { executePlayRequest } from "@/lib/play-request-executor";
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
  ChatMessageMeta,
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
  /**
   * 新增：点播旁路专用。只有当 chat-agent 走了 executePlayRequest 且返回
   * kind="candidate-list" 时才会有值。route.ts 把它塞进 SSE type:"assistant"
   * 帧的 meta 字段，前端 store 进 chatHistory[].meta。
   * 原 9 个 action 的链路不会写这个字段，directReply 那条 SSE 帧也不带 meta。
   */
  assistantMeta?: ChatMessageMeta;
  /**
   * 新增：聊天触发主页面音频控件（暂停/继续/音量/重播）。由 chat-agent 旁路
   * 在 resolveAgentState 之后立即判，命中后直接 return 短路原链路。
   * route.ts 把它写进 SSE type:"control" 帧的 action / value 字段，
   * 前端 player-shell.tsx 解析时调 audioRef.current。
   * 与原 9 个 action 完全正交——不写 preference_event / 不动 program。
   */
  controlAction?: "pause" | "resume" | "replay" | "volume-up" | "volume-down" | "set-volume";
  controlValue?: number;
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

  // 控制类旁路（暂停 / 继续 / 音量 / 重播）：在所有原 9 个 action 链路、
  // play-request 旁路、LLM 路由器之前最优先短路。
  // 命中后只构造 SSE control 帧让前端 audioRef 调，不写 preference_event、
  // 不动 program、不调 LLM、不调 radio-engine / online-radio。
  const controlResolved = resolveControlIntent(message);
  if (controlResolved) {
    const [memory, schedule] = await Promise.all([
      readMemory(),
      isOnlineRadioMode()
        ? ensureOnlineRadioProgram().then((result) => result.schedule)
        : ensureDailySchedule(),
    ]);
    const controlState: ChatAgentState = {
      mode: "music-control",
      tool: "schedule",
      intent: { action: controlResolved.controlAction },
      summary: controlResolved.reply,
    };
    return {
      state: controlState,
      program,
      schedule,
      favorites: await readFavorites(),
      llmMessages: buildChatModelMessages({
        message,
        program,
        memory,
        intent: controlState.intent,
        history,
        state: controlState,
      }),
      directReply: controlResolved.reply,
      controlAction: controlResolved.controlAction,
      controlValue: controlResolved.controlValue,
    };
  }

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

  // 点播旁路（新增，纯增量）。命中就短路下面所有 weather / music-control 流程，
  // 不动原 radio-engine / online-radio / applyChatIntentWithProgram / preference-learning。
  if (initialState.mode === "chat") {
    const playResolved = await resolvePlayRequest(message, program, history, nextFavorites);
    if (playResolved.handled) {
      const [memory, schedule] = await Promise.all([
        readMemory(),
        isOnlineRadioMode()
          ? ensureOnlineRadioProgram().then((result) => result.schedule)
          : ensureDailySchedule(),
      ]);
      const playState: ChatAgentState = {
        mode: "music-control",
        tool: "schedule",
        intent: { action: "none" },
        summary: playResolved.forcedDirectReply,
      };
      return {
        state: playState,
        program: playResolved.nextProgram,
        schedule,
        favorites: playResolved.nextFavorites,
        llmMessages: buildChatModelMessages({
          message,
          program: playResolved.nextProgram,
          memory,
          intent: playState.intent,
          history,
          state: playState,
        }),
        directReply: playResolved.forcedDirectReply,
        assistantMeta: playResolved.assistantMeta,
      };
    }
  }

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
    // 点播旁路（新增，纯增量）。原 9 个 action 仍走原链路；只有当
    // detectExplicitPlayIntent 也命中 play-* 时才短路。
    // 重要：原链路的 appendPreferenceEvent / applyOnlineChatIntent / favorite / download
    // 逻辑全部在下方继续跑，这里只判断是否走旁路。
    const playResolved = await resolvePlayRequest(message, program, history, nextFavorites);
    if (playResolved.handled) {
      const [memory, schedule] = await Promise.all([
        readMemory(),
        isOnlineRadioMode()
          ? ensureOnlineRadioProgram().then((result) => result.schedule)
          : ensureDailySchedule(),
      ]);
      const playState: ChatAgentState = {
        mode: "music-control",
        tool: "schedule",
        intent: { action: "none" },
        summary: playResolved.forcedDirectReply,
      };
      return {
        state: playState,
        program: playResolved.nextProgram,
        schedule,
        favorites: playResolved.nextFavorites,
        llmMessages: buildChatModelMessages({
          message,
          program: playResolved.nextProgram,
          memory,
          intent: playState.intent,
          history,
          state: playState,
        }),
        directReply: playResolved.forcedDirectReply,
        assistantMeta: playResolved.assistantMeta,
      };
    }

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

/* ============================================================
 * 点播旁路（纯增量，不影响原 9 个 action 的链路）
 * ============================================================ */

/**
 * 显式点播的 query 识别。三种 hit：
 *   - play-artist：播/放/来点/来首/想听/切到 + 纯歌手名（1-15 字）
 *   - play-song-by-artist：X 的 Y / 《Y》- X / 播 X Y
 *   - play-song：播/放/来一首/点一首/切到 + 歌名
 * 都不命中返回 null，调用方继续走原链路。
 */
function detectExplicitPlayIntent(
  message: string,
  history?: ChatMessage[],
): ChatIntent | null {
  const normalized = message
    .trim()
    .replace(/[，。！？、]/g, " ")
    .replace(/\s+/g, " ");
  if (!normalized) return null;

  // 0. "换一批" 关键词 + 上一条是 candidateList → 重搜同一歌手的 top N（去重之前展示过的）。
  // 无候选上下文时 fall through，原 9 个 action 的 "换一批/重新推荐" regenerate 接管。
  const pending = history ? lastPendingCandidates(history) : null;
  if (pending && isRefreshIntent(normalized)) {
    const artist = pending[0]?.artist;
    if (artist) {
      return {
        action: "play-artist",
        artist,
        refresh: true,
        mustPlayNow: true,
      };
    }
  }

  // 1. 上一条是 assistant with pendingCandidates → 当前 user 是在选歌
  if (pending) {
    const pick = matchPendingCandidate(normalized, pending);
    if (pick) {
      return {
        action: "play-song-by-artist",
        artist: pick.artist,
        title: pick.title,
        mustPlayNow: true,
      };
    }
  }

  // 2. 播/放/来点/来首/想听/切到 + 纯歌手名 → play-artist
  const bareArtist = normalized.match(
    /^(?:播|放|来点|来首|想听|切到)\s*([^\s的《》"\-]{2,15})$/,
  );
  if (bareArtist?.[1]) {
    return {
      action: "play-artist",
      artist: bareArtist[1].trim(),
      mustPlayNow: true,
    };
  }

  // 3. X 的 Y / 《Y》- X → play-song-by-artist
  const withTitle = normalized.match(
    /(?:播|放|来一首|点一首|切到)?\s*(.+?)\s*的\s*[《"]?(.+?)[》"]?$/,
  );
  if (withTitle?.[1] && withTitle[2]) {
    return {
      action: "play-song-by-artist",
      artist: withTitle[1].trim(),
      title: withTitle[2].trim(),
      mustPlayNow: true,
    };
  }
  const hyphenTitle = normalized.match(/[《"](.+?)[》"]\s*-\s*(.+)$/);
  if (hyphenTitle?.[1] && hyphenTitle[2]) {
    return {
      action: "play-song-by-artist",
      artist: hyphenTitle[2].trim(),
      title: hyphenTitle[1].trim(),
      mustPlayNow: true,
    };
  }

  // 4. 播/放/来一首/点一首/切到 + 歌名 → play-song
  const bareSong = normalized.match(
    /(?:播|放|来一首|点一首|切到)\s*[《"]?(.+?)[》"]?$/,
  );
  if (bareSong?.[1]) {
    return {
      action: "play-song",
      title: bareSong[1].trim(),
      mustPlayNow: true,
    };
  }

  return null;
}

/**
 * 倒着找 history 末尾最近 1 条 assistant 带 meta.pendingCandidates。
 * 超过 2 轮外的"上一条候选"不算——避免跳多句闲聊后又回头选歌时误匹配。
 */
function lastPendingCandidates(
  history: ChatMessage[],
): Array<{ artist: string; title: string }> | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "assistant") continue;
    const cands = m.meta?.pendingCandidates;
    if (cands && cands.length > 0) return cands;
    // 遇到 assistant 没候选就停，再往前的候选视为过期
    return null;
  }
  return null;
}

/**
 * "换一批" 类关键词识别。返回 true 表示 user 想对上一条候选列表重搜。
 * 必须配合 lastPendingCandidates(history) 命中一起用——无候选上下文时
 * 让原 9 个 action 的"换一批/重新推荐" regenerate 接管。
 */
function isRefreshIntent(normalized: string) {
  return (
    normalized === "换" ||
    normalized === "换一批" ||
    normalized === "换一下" ||
    normalized === "不要这几首" ||
    normalized === "再来点" ||
    normalized === "换其他" ||
    normalized === "还有吗" ||
    normalized === "别的" ||
    normalized === "换一批的" ||
    normalized === "换一批吧" ||
    normalized === "想换一批" ||
    normalized === "再换一批" ||
    normalized === "refresh"
  );
}

function stripQuotes(value: string) {
  return value.replace(/[《》""'']/g, "").trim();
}

function matchPendingCandidate(
  message: string,
  candidates: Array<{ artist: string; title: string }>,
): { artist: string; title: string } | null {
  const normalized = message.trim();
  if (!normalized) return null;

  // 序号："第 1 首" / "第 2 首" / "1" / "2" / "中间那首" / "就这首" / "最后一个"
  const indexMatch = normalized.match(/第\s*(\d+)\s*首/);
  if (indexMatch) {
    const idx = Number.parseInt(indexMatch[1], 10) - 1;
    if (idx >= 0 && idx < candidates.length) return candidates[idx];
    return null;
  }
  // 裸数字 1/2/3：直接当序号。限制 1-N，N=candidates.length，避免误吞 "5" 这种超界值
  const bareIndexMatch = normalized.match(/^(\d+)$/);
  if (bareIndexMatch) {
    const idx = Number.parseInt(bareIndexMatch[1], 10) - 1;
    if (idx >= 0 && idx < candidates.length) return candidates[idx];
    return null;
  }
  if (/^(?:就这首|这首|第一个|第一首)$/.test(normalized)) return candidates[0] ?? null;
  if (/^(?:最后一个|最后一首)$/.test(normalized)) return candidates[candidates.length - 1] ?? null;
  if (/^(?:中间那首|中间)$/.test(normalized)) {
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 2) return candidates[1];
    return candidates[Math.floor(candidates.length / 2)] ?? null;
  }

  // 歌名匹配（去掉书名号 / 引号后 includesNormalized）
  const clean = stripQuotes(normalized);
  if (!clean) return null;
  for (const c of candidates) {
    if (c.title === clean) return c;
    if (clean.includes(c.title) || c.title.includes(clean)) return c;
  }
  return null;
}

type PlayRequestResolution =
  | { handled: false }
  | {
      handled: true;
      nextProgram: RadioProgram;
      nextFavorites: string[];
      forcedDirectReply: string;
      assistantMeta?: ChatMessageMeta;
    };

async function resolvePlayRequest(
  message: string,
  program: RadioProgram,
  history: ChatMessage[] | undefined,
  nextFavorites: string[],
): Promise<PlayRequestResolution> {
  const intent = detectExplicitPlayIntent(message, history);
  if (!intent) return { handled: false };

  // refresh 模式：把上一轮 candidates 作为 excludeKeys 透传给 executor，
  // 避免重搜时返回用户已经看过的歌。
  let excludeKeys: Set<string> = new Set();
  let isRefresh = false;
  if (intent.refresh && history) {
    const prev = lastPendingCandidates(history);
    if (prev) {
      for (const c of prev) {
        excludeKeys.add(`${normalizeTitleKeyForExclude(c.artist)}::${normalizeTitleKeyForExclude(c.title)}`);
      }
      isRefresh = true;
    }
  }

  const result = await executePlayRequest(intent, program, excludeKeys);

  if (result.kind === "candidate-list") {
    if (result.empty) {
      const who = intent.artist || intent.title || "这个";
      if (isRefresh) {
        return {
          handled: true,
          nextProgram: program,
          nextFavorites,
          forcedDirectReply: `我这儿就这几首 ${who} 的歌了，你换个人试试？`,
        };
      }
      return {
        handled: true,
        nextProgram: program,
        nextFavorites,
        forcedDirectReply: `我这儿没搜到 ${who} 的歌，你换个歌手或歌名试试？`,
      };
    }
    const numbered = result.candidateList
      .map((c, i) => `${i + 1}.《${c.title}》`)
      .join("");
    const artist = intent.artist || result.candidateList[0]?.artist || "这位";
    const prefix = isRefresh
      ? `${artist} 的其他歌，刷新一下：`
      : `${artist} 的歌，你想听哪首？`;
    return {
      handled: true,
      nextProgram: program,
      nextFavorites,
      forcedDirectReply: `${prefix}${numbered}`,
      assistantMeta: { pendingCandidates: result.candidateList },
    };
  }

  // play-now
  return {
    handled: true,
    nextProgram: result.program,
    nextFavorites,
    forcedDirectReply: `收到，已经切到${result.played.artist}《${result.played.title}》。`,
  };
}

/**
 * 把候选 (artist, title) 转成 executor excludeKeys 用的标准化 key。
 * executor 内部 normalizeText 会做小写化 + 去空白 + 去符号，**这里必须复用同一套规则**，
 * 否则 key 不匹配，重搜会返回已展示过的歌。
 */
function normalizeTitleKeyForExclude(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()（）\[\]【】\-_.·,，/\\'"]/g, "");
}

/* ============================================================
 * 控件类旁路（暂停 / 继续 / 音量 / 重播）— 纯增量
 * ============================================================
 *
 * 跟 play-request 同层级：chat-agent 头部最优先短路。
 * 不写 preference_event / 不动 program / 不调 LLM / 不调 radio-engine。
 * 只构造 SSE type:"control" 帧让前端 audioRef 调。
 *
 * 注意：pause / resume / replay / set-volume（绝对值）由
 * radio-engine.resolveChatIntent 也能命中（resolveChatIntent 比 resolveControlIntent
 * 先跑），但**该路径会进 music-control 分支 + appendPreferenceEvent**，污染偏好流。
 * 所以 chat-agent 头部的 resolveControlIntent 必须是所有旁路里**最优先**——即使
 * resolveChatIntent 命中了 control-*，我们也在它之前先短路掉。
 */

type ControlResolution = {
  controlAction: "pause" | "resume" | "replay" | "volume-up" | "volume-down" | "set-volume";
  controlValue?: number;
  reply: string;
};

function normalizeControlText(value: string) {
  return value
    .trim()
    .replace(/[，。！？、]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function resolveControlIntent(message: string): ControlResolution | null {
  const normalized = normalizeControlText(message);
  if (!normalized) return null;

  // 暂停
  if (
    normalized === "暂停" ||
    normalized === "暂停一下" ||
    normalized === "停" ||
    normalized === "停一下" ||
    normalized === "别放了" ||
    normalized === "别唱了" ||
    normalized === "pause"
  ) {
    return { controlAction: "pause", reply: "暂停了。" };
  }
  // 继续
  if (
    normalized === "继续" ||
    normalized === "继续播" ||
    normalized === "接着放" ||
    normalized === "接着听" ||
    normalized === "恢复" ||
    normalized === "resume"
  ) {
    return { controlAction: "resume", reply: "继续播。" };
  }
  // 重播
  if (
    normalized === "重播" ||
    normalized === "重新放" ||
    normalized === "从头放" ||
    normalized === "再放一遍" ||
    normalized === "重来一遍" ||
    normalized === "再听一遍" ||
    normalized === "replay"
  ) {
    return { controlAction: "replay", reply: "从头再来。" };
  }
  // 音量绝对值："音量 70"
  const volumeMatch = normalized.match(/^音量\s*(\d{1,3})$/);
  if (volumeMatch) {
    const v = Math.max(0, Math.min(100, Number.parseInt(volumeMatch[1], 10)));
    return { controlAction: "set-volume", controlValue: v, reply: `音量调到 ${v}。` };
  }
  // 音量相对：大声点 / 响点 / 小声点
  if (
    /大声/.test(normalized) ||
    /响点/.test(normalized) ||
    /调高/.test(normalized) ||
    /音量大/.test(normalized) ||
    /音量加/.test(normalized) ||
    /声音大/.test(normalized) ||
    /声音响/.test(normalized)
  ) {
    return { controlAction: "volume-up", reply: "调大声点。" };
  }
  if (
    /小声/.test(normalized) ||
    /调低/.test(normalized) ||
    /音量小/.test(normalized) ||
    /音量减/.test(normalized) ||
    /声音小/.test(normalized) ||
    /声音轻/.test(normalized)
  ) {
    return { controlAction: "volume-down", reply: "调小声点。" };
  }
  return null;
}
