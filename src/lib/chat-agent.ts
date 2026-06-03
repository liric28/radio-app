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
import { appendPreferenceEvent, preferenceTrackFromSong, readPreferenceInsights, type PreferenceInsights } from "@/lib/preference-learning";
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
  PendingCandidateHit,
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
  resolver: "rule" | "llm" | "mood-keyword";
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

async function inferOnlineFreeformIntent(
  message: string,
  program: RadioProgram,
  insights: PreferenceInsights,
): Promise<ChatIntent> {
  const nextTrack = program.queue[0];

  // 把 preference insights 浓缩成给 LLM 看的文本段落。
  // 关键：让 LLM 知道"用户在当前 scene 已经标黑什么 / 偏好什么 / 能量倾向"，
  // 这样 regenerate 不会傻乎乎地推用户已经标黑的标签。
  const currentSceneProfile = insights.sceneProfiles.find((p) => p.scene === program.scene);
  const avoidList = currentSceneProfile?.avoidSignals?.length
    ? currentSceneProfile.avoidSignals
    : insights.topTags.slice(0, 5); // 兜底：没 scene profile 时给全局 topTags
  const now = new Date();
  const hour = now.getHours();
  const dayOfWeek = now.getDay(); // 0=周日, 6=周六
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  // 6-10 早高峰, 11-14 午休, 15-17 下午, 18-22 晚高峰, 23-5 深夜
  const timeOfDay =
    hour >= 6 && hour < 11 ? "早高峰" :
    hour >= 11 && hour < 14 ? "午休" :
    hour >= 14 && hour < 17 ? "下午" :
    hour >= 17 && hour < 23 ? "晚间" :
    "深夜";
  const preferenceBlock = [
    `用户口味画像（基于 ${insights.totalEvents} 条学习事件）：`,
    `- 高频艺人: ${insights.topArtists.slice(0, 5).join("、") || "暂无"}`,
    `- 高频语言: ${insights.topLanguages.slice(0, 3).join("、") || "暂无"}`,
    `- 高频标签: ${insights.topTags.slice(0, 5).join("、") || "暂无"}`,
    `- 高频需求模式: ${insights.topRequestPatterns.slice(0, 5).join("、") || "暂无"}`,
    `- 当前时段(${program.scene})优先能量: ${currentSceneProfile?.preferredEnergy ?? "未知"}`,
    `- 应当避免: ${avoidList.slice(0, 5).join("、") || "暂无"}`,
  ].join("\n");

  const prompt = [
    "你是音乐电台首页的意图路由器。",
    "任务：判断用户这句话是不是在要求你改当前推荐 LIST。",
    "只输出一行 JSON，不要解释，不要 markdown。",
    '允许的 action 只有：none, regenerate, fresh, calmer, familiar, skip, favorite, download-current, scene-change。',
    "规则：",
    "- 用户在随口描述想听什么风格、语言、气氛、艺人、时段、强度时，通常输出 regenerate。",
    "- 只有明显是『更安静/更轻/更慢』才用 calmer。",
    "- 只有明显是『更熟/回忆/老歌』才用 familiar。",
    "- 只有明显是『换新一点/换个感觉/更刺激』才用 fresh。",
    "- 只有明显是下载当前歌才用 download-current。",
    "- 只有明显是收藏当前歌才用 favorite。",
    "- 只有明显是跳过当前歌才用 skip。",
    "- 只有明显是切到某个时段才用 scene-change，并给 targetPeriod: morning/daytime/evening/late-night。",
    "- 普通闲聊、吐槽、问候、问你是谁、非音乐问题输出 none。",
    "- **关键**：输出 regenerate/fresh/calmer/familiar/scene-change 时，**必须**根据用户口味画像 + 当前消息 + 实际时间生成 `messageHint` 字段（10-30 字中文），描述应该匹配的艺人/标签/能量/情绪倾向，避开『应当避免』列表。messageHint 会传给搜索端做种子。",
    "- 例子：用户说『今天有点累』 + avoidSignals=[『电子』] → regenerate, messageHint: 『安静、低能量、避开电子』",
    "- 例子：用户说『想家了』 + topTags=[『民谣』,『老歌』] → regenerate, messageHint: 『民谣、怀旧、慢节奏』",
    "- 例子：用户说『换点歌』 + 什么都没标 → regenerate, messageHint: null（或省略）",
    "- **时间敏感**：早高峰偏好清新提神、午休偏好舒缓解压、晚间偏好有温度、深夜偏好低能量不打扰；messageHint 必须反映实际时间（timeOfDay）而不是笼统的『当下』。",
    "- **周末感知**：周末和工作日的偏好通常不同（周末更愿尝试新东西），周末时 messageHint 可以适当放开探索。",
    preferenceBlock,
    `当前时段: ${program.scene}`,
    `实际时间: 周${["日","一","二","三","四","五","六"][dayOfWeek]} ${hour}:${String(now.getMinutes()).padStart(2, "0")}（${timeOfDay}${isWeekend ? "，周末" : ""}）`,
    `当前歌: ${program.currentTrack.artist} - ${program.currentTrack.title}`,
    `下一首: ${nextTrack ? `${nextTrack.artist} - ${nextTrack.title}` : "暂无"}`,
    `用户消息: ${message}`,
    '输出格式示例：{"action":"regenerate","targetPeriod":null,"messageHint":"安静、低能量、避开电子"}',
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
        messageHint:
          typeof parsed.messageHint === "string" && parsed.messageHint.trim()
            ? parsed.messageHint.trim()
            : undefined,
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

  // Avoid-current 旁路（chat + music-control 都判，太吵/太老/不喜欢 这类跟意图正交）
  // 必须在 point-of-no-return 之前最优先，命中后短路。
  const avoidResolved = resolveAvoidIntent(message, program.currentTrack);
  if (avoidResolved) {
    const trackSnapshot = preferenceTrackFromSong(program.currentTrack, program.scene);
    await appendPreferenceEvent({
      type: "avoid_signal",
      message,
      action: "avoid-current",
      scene: program.scene,
      track: trackSnapshot,
      reason: avoidResolved.reason,
    }).catch(() => null);
    const [, schedule] = await Promise.all([
      Promise.resolve(),
      isOnlineRadioMode()
        ? ensureOnlineRadioProgram().then((result) => result.schedule)
        : ensureDailySchedule(),
    ]);
    // 实际换歌：online 模式走 applyOnlineChatIntent（走智能优先 + 标黑）；local 模式走 skip
    let nextProgramAfterAvoid = program;
    if (isOnlineRadioMode()) {
      const avoidIntent: ChatIntent = {
        action: "avoid-current",
        messageHint: avoidResolved.reason,
      };
      const result = await applyOnlineChatIntent(avoidIntent, program, avoidResolved.reason);
      nextProgramAfterAvoid = result.program;
    } else {
      const skipResult = await applyChatIntentWithProgram({ action: "skip" }, program);
      nextProgramAfterAvoid = skipResult ?? program;
    }
    const avoidState: ChatAgentState = {
      mode: "music-control",
      tool: "schedule",
      intent: { action: "avoid-current" },
      summary: avoidResolved.reply,
    };
    const memory = await readMemory();
    return {
      state: avoidState,
      program: nextProgramAfterAvoid,
      schedule,
      favorites: await readFavorites(),
      llmMessages: buildChatModelMessages({
        message,
        program: nextProgramAfterAvoid,
        memory,
        intent: avoidState.intent,
        history,
        state: avoidState,
      }),
      directReply: avoidResolved.reply,
    };
  }

  if (initialState.mode === "chat" && isOnlineRadioMode()) {
    // Phase 9: 把 preference insights 喂给 LLM 路由器，让它能基于用户口味
    // 画像 + 当前 sceneProfile 输出精准的 messageHint。
    // 读失败时 fallback 到空 insights（initState 仍然是空对象，全是"暂无"）。
    let insights: PreferenceInsights;
    try {
      insights = await readPreferenceInsights();
    } catch {
      insights = {
        updatedAt: "",
        totalEvents: 0,
        topArtists: [],
        topLanguages: [],
        topTags: [],
        topRequestPatterns: [],
        sceneProfiles: [],
        recommendationSourceStats: [],
        recentIntentResolutions: [],
        recentEvents: [],
      };
    }
    const inferredIntent = await inferOnlineFreeformIntent(message, program, insights);
    if (inferredIntent.action !== "none") {
      initialState = {
        mode: "music-control",
        tool: "schedule",
        intent: inferredIntent,
        summary: "用户在用自然语言改首页推荐，已转成明确电台动作。",
      };
      intentResolution = { resolver: "llm" };
    } else {
      // Phase 9 兜底：LLM 路由器对 mood 表达偏 none，用 keyword fallback 补回 regenerate + messageHint。
      // 不命中继续走 none → 真 none 路径（chat 闲聊，DJ 自由应答）。
      const moodIntent = inferFromMoodKeywords(message, insights);
      if (moodIntent) {
        initialState = {
          mode: "music-control",
          tool: "schedule",
          intent: moodIntent,
          summary: "用户表达心情 / 风格偏好，keyword 兜底转成首页换一批。",
        };
        intentResolution = { resolver: "mood-keyword" };
      }
    }
  }
  let nextProgram = program;
  let nextState = initialState;
  let nextFavorites = await readFavorites();

/**
 * Similar 旁路（chat mode 才判，"再来点这种/类似的/和这首一样" 跟意图正交）
 * 命中后构造 messageHint = currentTrack 特征，让 applyOnlineChatIntent 走智能优先
 *
 * 反向回写：
 *   similar_request 事件已经写盘（+1.2 分），但**真正的反馈闭环靠 playback_completed/interrupted**。
 *   - 用户听完 80%+：playback_completed +1.5，跟 similar_request +1.2 累加，正向循环
 *   - 用户中途 skip：playback_interrupted -0.5~-2，跟 similar_request 抵消，模型能学到"这次不像"
 *   - 用户主动 avoid_signal（"太吵了"）：-1.5，**不**抹 similar_request（让模型看到"既要类似的又怕吵"是更精细的口味）
 *   所以这一路**不**做额外反向回写逻辑——现有 playback flow 已覆盖，避免重复扣分。
 */
  if (initialState.mode === "chat") {
    const similarResolved = resolveSimilarIntent(message, program.currentTrack);
    if (similarResolved) {
      const ct = program.currentTrack;
      const tagSeed = (ct.tags || []).slice(0, 3).filter(Boolean).join(",");
      const messageHint = `类似 ${ct.artist} 的 ${ct.title}，风格延续，标签：${tagSeed || ct.mood || "延续当前口味"}`;
      await appendPreferenceEvent({
        type: "similar_request",
        message,
        action: "similar",
        scene: program.scene,
        track: preferenceTrackFromSong(ct, program.scene),
        seed: messageHint,
      }).catch(() => null);
      const [, schedule] = await Promise.all([
        Promise.resolve(),
        isOnlineRadioMode()
          ? ensureOnlineRadioProgram().then((result) => result.schedule)
          : ensureDailySchedule(),
      ]);
      let nextProgramAfterSimilar = program;
      if (isOnlineRadioMode()) {
        const similarIntent: ChatIntent = {
          action: "similar",
          messageHint,
        };
        const result = await applyOnlineChatIntent(similarIntent, program, messageHint);
        nextProgramAfterSimilar = result.program;
      } else {
        // local 模式：fall back 到 regenerate（不传 messageHint，走原 9 个 action）
        const regenResult = await applyChatIntentWithProgram(
          { action: "regenerate" },
          program,
        );
        nextProgramAfterSimilar = regenResult ?? program;
      }
      const similarState: ChatAgentState = {
        mode: "music-control",
        tool: "schedule",
        intent: { action: "similar" },
        summary: similarResolved.reply,
      };
      const memory = await readMemory();
      return {
        state: similarState,
        program: nextProgramAfterSimilar,
        schedule,
        favorites: nextFavorites,
        llmMessages: buildChatModelMessages({
          message,
          program: nextProgramAfterSimilar,
          memory,
          intent: similarState.intent,
          history,
          state: similarState,
        }),
        directReply: similarResolved.reply,
      };
    }
  }

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
      ? (await applyOnlineChatIntent(
          initialState.intent,
          program,
          // Phase 9: LLM 路由器的智能 messageHint 优先于 user 原文。
          // 原文依然作为兜底——LLM 没填或填了空时回退到 user 原始消息。
          initialState.intent.messageHint?.trim() || message,
        )).program
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
 * 心情 / 风格 keyword 兜底（Phase 9，LLM 路由器判 none 时的纯增量 fallback）
 * ============================================================
 * 触发场景：LLM 路由器对"今天有点累"/"想家了"/"嗨一点" 这种 mood 表达偏 none，
 * 但这正是用户要"换首页推荐" 的明确信号。keyword 命中就转成 regenerate + messageHint，
 * 让 online-radio.ts 的 messageHint 智能优先路径生效。
 *
 * 纯增量：不动 LLM 路由器 prompt，不动 9 个 action，不动 radio-engine / online-radio。
 * ============================================================ */

const MOOD_KEYWORD_HINTS: Array<{
  keywords: string[]; // 任意一个命中即触发
  hint: string; // 喂给 online-radio.applyOnlineChatIntent 的 messageHint
  weight: number; // 多组同时命中时，weight 高者胜
}> = [
  // —— 情绪低落 / 疲惫 ——
  {
    keywords: ["累", "疲惫", "没精神", "提不起劲", "丧"],
    hint: "用户情绪低落、疲惫，需要柔和、不打扰、稍带治愈感的歌",
    weight: 5,
  },
  {
    keywords: ["想家", "思乡", "怀念", "回忆", "孤独", "寂寞", "一个人"],
    hint: "用户想家、孤独、怀旧，需要走心、有温度的中文慢歌",
    weight: 5,
  },
  {
    keywords: ["烦躁", "焦虑", "烦", "烦闷", "抑郁", "不开心", "难受"],
    hint: "用户烦躁、焦虑，需要舒缓、平静、不激昂的歌",
    weight: 5,
  },
  // —— 情绪上扬 / 燃 ——
  {
    keywords: ["嗨", "嗨一点", "嗨起来", "兴奋", "开心", "得劲", "起劲", "带劲", "躁起来", "燃起来", "热一点", "沸腾"],
    hint: "用户情绪上扬，要嗨一点，需要节奏强、有推力的歌",
    weight: 5,
  },
  {
    keywords: ["燃", "燃一点", "推起来", "推上来", "上头", "劲爆", "推力", "冲劲", "够劲", "带感", "嗨翻", "飞起"],
    hint: "用户想更燃、更有推力，需要节奏更快、能量更密集的歌",
    weight: 5,
  },
  {
    keywords: ["炸", "炸一点", "爆炸", "炸裂", "劲爆一点", "硬核", "暴力"],
    hint: "用户要炸、能量高、冲击力强，需要电子/摇滚/重型节拍的歌",
    weight: 5,
  },
  // —— 风格 / 速度 ——
  {
    keywords: ["慵懒", "慢", "慢一点", "慢节奏", "慢歌"],
    hint: "用户想要慵懒、慢节奏的歌，BPM 偏低",
    weight: 4,
  },
  {
    keywords: ["轻快", "轻盈", "清新", "明快", "舒服"],
    hint: "用户想要轻快、清新、舒服的歌",
    weight: 4,
  },
  {
    keywords: ["温柔", "软", "柔软的", "暖", "温暖", "治愈", "惬意"],
    hint: "用户想要温柔、治愈、暖的歌，节奏柔和",
    weight: 4,
  },
  {
    keywords: ["重一点", "厚重", "沉稳", "深沉", "有分量"],
    hint: "用户想要厚重、深沉、有分量的歌",
    weight: 4,
  },
  {
    keywords: ["安静", "静一点", "静一下", "静一静"],
    hint: "用户想要安静、平静的歌，弱打击感、人声为主",
    weight: 4,
  },
  // —— 时刻 / 场景 ——
  {
    keywords: ["夜深了", "深夜", "凌晨", "睡不着", "失眠"],
    hint: "深夜 / 失眠，需要低能量、安静、适合入眠的歌",
    weight: 3,
  },
  {
    keywords: ["早上", "早晨", "刚醒", "起床"],
    hint: "清晨 / 刚醒，需要清新、明亮、慢启发的歌",
    weight: 3,
  },
  {
    keywords: ["下班", "收工", "回家", "路上"],
    hint: "通勤 / 下班路上，需要舒缓、解压的歌",
    weight: 3,
  },
  {
    keywords: ["下雨", "雨天", "窗外在下雨"],
    hint: "下雨天，需要安静、走心、有氛围感的歌",
    weight: 3,
  },
  {
    keywords: ["开车", "自驾", "高速"],
    hint: "开车 / 路上，需要有节奏感、不能太安静的歌",
    weight: 3,
  },
  // —— 否定 / 喜好倾向（弱信号，主要是兜底）——
  {
    keywords: ["不想听"],
    hint: "用户对某类风格 / 标签 / 歌手明确排斥，需要避开",
    weight: 2,
  },
  {
    keywords: ["不要", "别放", "避开", "排斥", "不喜欢", "听腻", "腻了"],
    hint: "用户想避开某种风格 / 节奏 / 情绪",
    weight: 2,
  },
  // —— 浪漫 / 治愈 / 文艺 ——
  {
    keywords: ["浪漫", "罗曼蒂克", "甜蜜", "甜一点", "甜歌"],
    hint: "用户想听浪漫、甜蜜的歌，节奏舒缓、感情色彩浓",
    weight: 4,
  },
  {
    keywords: ["文艺", "诗意", "有故事", "走心", "动人"],
    hint: "用户想听文艺、走心、有故事感的歌",
    weight: 4,
  },
  {
    keywords: ["孤独", "寂寞", "一个人", "独处", "独自"],
    hint: "用户想要安静、独处氛围的歌，弱打击、人声主导",
    weight: 5,
  },
  {
    keywords: ["怀旧", "复古", "老歌", "8090", "千禧", "y2k"],
    hint: "用户想听怀旧、复古的歌，老歌/经典为主",
    weight: 4,
  },
  // —— 场景补充 ——
  {
    keywords: ["困", "想睡", "助眠", "催眠", "哄睡"],
    hint: "用户要入睡，需要低能量、慢节奏、不打扰的歌",
    weight: 3,
  },
  {
    keywords: ["开车", "自驾", "高速", "跑长途"],
    hint: "开车 / 路上，需要有节奏感、不能太安静的歌",
    weight: 3,
  },
  {
    keywords: ["跑步", "运动", "健身", "撸铁", "有氧"],
    hint: "运动场景，需要高能量、有节奏推力的歌",
    weight: 4,
  },
  {
    keywords: ["工作", "写代码", "专注", "干活", "学习"],
    hint: "工作 / 专注场景，需要低打扰、节奏稳定、不抢注意力的歌",
    weight: 3,
  },
  {
    keywords: ["吃饭", "聚餐", "朋友", "派对", "party"],
    hint: "聚餐 / 派对场景，需要热闹、有活力、有氛围的歌",
    weight: 3,
  },
];

/**
 * 心情 / 风格 keyword 兜底。返回 ChatIntent 形如 {action: "regenerate", messageHint: "..."}
 * 供 online-radio.applyOnlineChatIntent 走"LLM 智能优先"路径。
 * 不命中返回 null（调用方继续走 LLM 判 none → 真 none 路径）。
 */
function inferFromMoodKeywords(
  message: string,
  _insights: PreferenceInsights,
): ChatIntent | null {
  const normalized = message.toLowerCase().trim();
  if (!normalized) return null;

  // 多组同时命中：取 weight 最高的一组 hint
  let best: { hint: string; weight: number } | null = null;
  for (const group of MOOD_KEYWORD_HINTS) {
    if (group.keywords.some((kw) => normalized.includes(kw))) {
      if (!best || group.weight > best.weight) {
        best = { hint: group.hint, weight: group.weight };
      }
    }
  }
  if (!best) return null;

  return {
    action: "regenerate",
    messageHint: best.hint,
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
): PendingCandidateHit[] | null {
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
  candidates: PendingCandidateHit[],
): PendingCandidateHit | null {
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
 * 把候选 hit 的 artist/title 转成 executor excludeKeys 用的标准化 key。
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

type SimilarResolution = {
  handled: true;
  reply: string;
  similarTo: { artist: string; title: string };
  /** 反向回写 5 用：用户对 similar 推荐的"再换/换回"是否触发 */
  similarTurnId: string;
};

type AvoidResolution = {
  handled: true;
  reply: string;
  /** 标黑哪个 tag/artist/energy 段；messageHint 用 */
  reason: string;
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

/**
 * "再来点这种 / 类似的 / 和这首一样"识别。返回 SimilarResolution 表示触发 similar action。
 * 不命中返 null。
 *
 * 触发关键词（口语化，覆盖用户日常表达）：
 *   "再来点这种的" / "类似的" / "和这首一样" / "保持这种" / "继续这种" / "就这种" / "再来一首" / "多来点这种"
 *   "还有这种吗" / "类似的歌" / "同类型" / "类似风格"
 */
function resolveSimilarIntent(message: string, currentTrack: { artist: string; title: string } | null): SimilarResolution | null {
  if (!currentTrack) return null;
  const normalized = message
    .trim()
    .replace(/[，。！？、]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (!normalized) return null;

  const hit =
    /再来点这种/.test(normalized) ||
    /类似的/.test(normalized) ||
    /和这首一样/.test(normalized) ||
    /保持这种/.test(normalized) ||
    /继续这种/.test(normalized) ||
    /就这种/.test(normalized) ||
    /再来一首/.test(normalized) ||
    /多来点这种/.test(normalized) ||
    /还有这种吗/.test(normalized) ||
    /类似的歌/.test(normalized) ||
    /同类型/.test(normalized) ||
    /类似风格/.test(normalized) ||
    /^再来点$/.test(normalized) ||
    /^类似的$/.test(normalized);
  if (!hit) return null;

  const turnId = `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    handled: true,
    reply: `好，按《${currentTrack.title}》这种味道再来一首。`,
    similarTo: { artist: currentTrack.artist, title: currentTrack.title },
    similarTurnId: turnId,
  };
}

/**
 * "太吵了 / 太老了 / 太甜了 / 太闹了"识别。返回 AvoidResolution。
 * 命中后写一条 avoid_signal preference event，messageHint 标黑 currentTrack 的对应 tag/artist 段。
 *
 * 注意：必须有 currentTrack，否则无法判断"太 X 的是哪首"。无 currentTrack 时返 null。
 */
function resolveAvoidIntent(message: string, currentTrack: { artist: string; title: string; tags?: string[]; artist_id?: string } | null): AvoidResolution | null {
  if (!currentTrack) return null;
  const normalized = message
    .trim()
    .replace(/[，。！？、]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (!normalized) return null;

  // 否定型：太 + 形容词
  const tooPatterns: Array<{ regex: RegExp; reason: string }> = [
    { regex: /太吵/, reason: "用户觉得太吵，避开高能量、强节奏的歌" },
    { regex: /太闹/, reason: "用户觉得太闹，避开高能量、强节奏的歌" },
    { regex: /太重/, reason: "用户觉得太重，避开重金属/重型节拍" },
    { regex: /太躁/, reason: "用户觉得太躁，避开高能量、强节奏的歌" },
    { regex: /太老/, reason: "用户觉得太老，避开老歌、年代感太强的歌" },
    { regex: /太旧/, reason: "用户觉得太旧，避开老歌" },
    { regex: /太甜/, reason: "用户觉得太甜，避开甜蜜/小清新" },
    { regex: /太腻/, reason: "用户觉得太腻，避开情绪太浓的歌" },
    { regex: /太慢/, reason: "用户觉得太慢，避开慢节奏/慢歌" },
    { regex: /太柔/, reason: "用户觉得太柔，避开弱能量、人声主导" },
    { regex: /太安静/, reason: "用户觉得太安静，避开弱打击、低能量" },
    { regex: /太忧伤/, reason: "用户觉得太忧伤，避开悲伤/孤独/怀旧" },
    { regex: /太伤感/, reason: "用户觉得太伤感，避开悲伤/孤独" },
    { regex: /太嗨/, reason: "用户觉得太嗨，避开高能量、燃/炸的歌" },
    { regex: /太燃/, reason: "用户觉得太燃，避开燃/炸的歌" },
    { regex: /太摇滚/, reason: "用户觉得太摇滚，避开摇滚/重型" },
    { regex: /太电子/, reason: "用户觉得太电子，避开电子/合成器" },
  ];

  for (const p of tooPatterns) {
    if (p.regex.test(normalized)) {
      return {
        handled: true,
        reply: "好，这首不听了，给你换首不一样的。",
        reason: p.reason,
      };
    }
  }

  // 显式不要：跳过这首 / 换掉这首 / 不喜欢这首
  if (
    /跳过这首/.test(normalized) ||
    /换掉这首/.test(normalized) ||
    /不喜欢这首/.test(normalized) ||
    /不喜欢当前/.test(normalized) ||
    /这首要换/.test(normalized) ||
    /这首不行/.test(normalized)
  ) {
    return {
      handled: true,
      reply: "收到，跳过这首。",
      reason: "用户明确不要当前曲，标黑当前曲的整体风格",
    };
  }

  return null;
}
