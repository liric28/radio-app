/**
 * Hermes LLM 封装层。所有跟本地 LLM 服务（http://127.0.0.1:8642）的交互都在这里。
 *
 * 函数分类：
 *   推荐语生成：
 *     - rewriteTrackReason         单首调一次 LLM（个别润色，~1s）
 *     - batchRewriteTrackReasons   多首一次性调用（schedule 阶段批量，~7s 一段）
 *     - buildFallbackTrackReason   LLM 失败时的本地模板兜底
 *
 *   DJ 串词 & 摘要：
 *     - composeHostIntro           节目开场串词（用本地模板，不调 LLM，<1ms）
 *     - summarizeReasons           推荐理由清单截断（不调 LLM）
 *
 *   聊天回复：
 *     - buildRuleBasedDjReply      纯规则生成 DJ 回复（fallback）
 *     - buildHermesDjMessages      把 program/memory/intent 装配成 Hermes 消息列表
 *     - describeAgentState         把 agent 执行结果压成一句话给模型
 *
 *   推荐数量：
 *     - recommendBlockTrackCount   每段歌曲数（场景基线 + 情绪 + ±2 抖动）
 *
 * 设计原则：
 *   - 所有 LLM 调用都有 try/catch + 本地兜底，绝不阻塞主流程
 *   - 失败要 logReasonRewrite 打 console，方便后端排查
 *   - Hermes 不能并发太多（约 8 个就开始卡），尽量批量；schedule 生成时单次一段
 */
import type {
  ChatAgentState,
  ChatIntent,
  ChatMessage,
  RadioMemory,
  RadioProgram,
  Song,
} from "@/lib/types";
import { requestChatCompletion } from "@/lib/providers/chat-llm";

type ComposeIntroInput = {
  scene: string;
  persona: string;
  currentTrack: Song;
  nextTrack: Song;
  moodHint: string;
};

function logReasonRewrite(event: string, meta: Record<string, unknown>) {
  console.info(`[reason-rewrite] ${event}`, meta);
}

function buildFallbackTrackReason(song: Song, scene: string) {
  const seed = song.reasonSeed.trim();

  if (seed) {
    return seed.replace(/^它/, "这首");
  }

  if (scene.includes("晨")) return "这首拿来开场，醒得比较自然。";
  if (scene.includes("白天")) return "这首挂着不打扰，能把节奏托住。";
  if (scene.includes("傍晚")) return "这首一出来，天色就慢慢松下来了。";
  if (scene.includes("深夜")) return "这首放在这会儿，情绪会沉得更顺一点。";

  return `这首先摆在这里，气口是对的。`;
}

/**
 * 让 AI 根据场景和情绪标签推荐每段适合的歌曲数量。
 * 返回数字，失败时退回 10。
 */
export async function recommendBlockTrackCount(
  scene: string,
  moods: string[],
  catalogSize: number,
): Promise<number> {
  const base = (() => {
    if (scene.includes("晨")) return 6;
    if (scene.includes("白天")) return 12;
    if (scene.includes("傍晚")) return 9;
    if (scene.includes("深夜")) return 7;
    return 10;
  })();

  const moodAdjust = Math.min(moods.length, 3) - 1;
  const jitter = Math.floor(Math.random() * 5) - 2;
  const raw = base + moodAdjust + jitter;

  const minCount = 4;
  const maxPerBlock = Math.max(minCount, Math.floor(catalogSize / 4));
  return Math.min(Math.max(raw, minCount), maxPerBlock);
}

const INTRO_TEMPLATES = [
  `先来一首 {currentArtist} 的《{currentTitle}》，早上出门这个点，{moodHint} 刚好把节奏带起来。后面接 {nextArtist} 的《{nextTitle}》，顺着往下走就行。`,
  `早上好。《{currentTitle}》先上，{currentArtist} 的声音配 {moodHint} 正合适，后面 {nextArtist} 的《{nextTitle}》慢慢把情绪展开。`,
  `《{currentTitle}》开场，{currentArtist} 的歌配{moodHint}，这个点先把气口定住。后面还有 {nextArtist} 的《{nextTitle}》。`,
  `{currentArtist} 的《{currentTitle}》，早上听着正合适。{moodHint} 先打底，后面 {nextArtist} 的《{nextTitle}》把节奏顺下来。`,
  `《{currentTitle}》先播，{currentArtist} 的声音配上 {moodHint}，正好衬这个点。后面 {nextArtist} 的《{nextTitle}》，不打断。`,
  `早上好，先来 {currentArtist} 的《{currentTitle}》。{moodHint} 开路，后面 {nextArtist} 的《{nextTitle}》自然接上。`,
  `{currentArtist}《{currentTitle}》，早上这个时间先上这首，{moodHint} 垫着，后面 {nextArtist} 的《{nextTitle}》顺势推过去。`,
  `先听 {currentArtist} 的《{currentTitle}》，{moodHint} 把氛围定好，后面 {nextArtist} 的《{nextTitle}》接着走。`,
  `《{currentTitle}》响起，{currentArtist} 的声音配 {moodHint}，早上最适合这样的开场，后面 {nextArtist} 的《{nextTitle}》把情绪收住。`,
  `{currentArtist} 的《{currentTitle}》，{moodHint} 先铺一层，后面 {nextArtist} 的《{nextTitle}》自然跟上来，不割裂。`,
];

function fillIntro(template: string, input: ComposeIntroInput) {
  return template
    .replaceAll("{currentArtist}", input.currentTrack.artist)
    .replaceAll("{currentTitle}", input.currentTrack.title)
    .replaceAll("{nextArtist}", input.nextTrack.artist)
    .replaceAll("{nextTitle}", input.nextTrack.title)
    .replaceAll("{moodHint}", input.moodHint);
}

/**
 * 节目开场串词。**不调 LLM**，10 个本地模板里随机一个，<1ms 返回。
 *
 * 模板里有 {persona} {currentArtist} {currentTitle} {nextArtist} {nextTitle}
 * {scene} {moodHint} 七个占位符，fillIntro 直接做字符串替换。
 *
 * 不上 LLM 的原因：开场串词不能等 1s，会拖慢首屏 / 切歌响应；
 * 模板已经够自然，不会让用户觉得生硬。如果以后要做"个性化欢迎"再换成 Hermes。
 */
export async function composeHostIntro(input: ComposeIntroInput) {
  const template = INTRO_TEMPLATES[Math.floor(Math.random() * INTRO_TEMPLATES.length)];
  return fillIntro(template, input);
}

/**
 * 统一整理推荐理由输出，保持前后端字段稳定。
 */
export async function summarizeReasons(reasons: string[]) {
  return reasons.slice(0, 3);
}

type ComposeDjReplyInput = {
  message: string;
  program: RadioProgram;
  memory: RadioMemory;
  intent?: ChatIntent;
  history?: ChatMessage[];
  state?: ChatAgentState;
};

/**
 * 把 agent 的执行结果压成一句模型可消费的人话摘要，避免提示词继续说系统腔。
 */
export function describeAgentState({
  message,
  beforeProgram,
  afterProgram,
  state,
}: {
  message: string;
  beforeProgram: RadioProgram;
  afterProgram: RadioProgram;
  state: ChatAgentState;
}) {
  if (state.mode === "weather" && state.weather) {
    return `用户问的是天气；天气结果是 ${state.weather.locationLabel} ${state.weather.conditionText} ${state.weather.temperatureC} 度。`;
  }

  if (state.mode === "music-control") {
    const currentChanged = beforeProgram.currentTrack.id !== afterProgram.currentTrack.id;
    const nextTrack = afterProgram.queue[0];
    const changeText =
      state.intent.action === "favorite"
        ? `这首已经替你收进喜欢里了。`
        : state.intent.action === "download-current"
          ? `这首我已经按你这句去处理下载了。`
          : state.intent.action === "regenerate"
            ? `我刚按这句话重刷了一轮队列，新的头一首已经顶上来了。`
            : currentChanged
              ? `当前歌已切到 ${afterProgram.currentTrack.artist}《${afterProgram.currentTrack.title}》。`
              : "当前歌没切，但后面的队列已经改了。";
    const nextText = nextTrack
      ? `接下来会跟到 ${nextTrack.artist}《${nextTrack.title}》。`
      : "暂时没有明确下一首。";
    return `用户消息是“${message}”；这是在调电台。${changeText}${nextText}`;
  }

  return "用户在正常聊天，先自然接话，不要解释系统。";
}

/**
 * 纯规则 DJ 回复生成（Hermes fallback / 离线模式 / 不想等 LLM 的场景）。
 *
 * 按 intent.action 和 message 关键词分支，每条意图都有手写的 DJ 口语化回复。
 * 优势：0ms 返回、零成本、风格稳定
 * 劣势：套路化，问相同的话总是同一句
 *
 * 当前架构里走 SSE Hermes 流式回复，这个函数只作为兜底。
 */
export function buildRuleBasedDjReply({
  message,
  program,
  intent,
  state,
}: ComposeDjReplyInput) {
  const normalized = message.trim().toLowerCase();
  const nextTrack = program.queue[0];

  if (!normalized) {
    return "你先说句人话给我，我接着聊。";
  }

  if (state?.mode === "weather" && state.weather) {
    return `今天${state.weather.locationLabel}${state.weather.conditionText}，现在差不多${state.weather.temperatureC}度。`;
  }

  if (
    intent?.action === "favorite" ||
    normalized.includes("收藏") ||
    normalized.includes("喜欢这首")
  ) {
    return "行，这首我给你收进喜欢里。";
  }

  if (
    intent?.action === "download-current" ||
    normalized === "下载" ||
    normalized === "下下来" ||
    normalized === "存一下" ||
    normalized === "保存一下" ||
    normalized.includes("下载这首") ||
    normalized.includes("把这首下下来")
  ) {
    return "行，这首我给你往本地收。";
  }

  if (
    intent?.action === "regenerate" ||
    normalized.includes("推荐一批") ||
    normalized.includes("来一轮") ||
    normalized.includes("换一轮") ||
    normalized.includes("换一批") ||
    normalized.includes("重新推荐")
  ) {
    return nextTrack
      ? `这轮我重排好了。先上${program.currentTrack.artist}《${program.currentTrack.title}》，后面接${nextTrack.artist}《${nextTrack.title}》。`
      : `这轮我重排好了。先上${program.currentTrack.artist}《${program.currentTrack.title}》。`;
  }

  if (
    intent?.action === "calmer" ||
    normalized.includes("安静") ||
    normalized.includes("calm") ||
    normalized.includes("轻") ||
    normalized.includes("慢")
  ) {
    return nextTrack
      ? `行，我收一点。先放${program.currentTrack.artist}《${program.currentTrack.title}》，后面接${nextTrack.artist}《${nextTrack.title}》。`
      : `行，我收一点。先放${program.currentTrack.artist}《${program.currentTrack.title}》。`;
  }

  if (
    intent?.action === "familiar" ||
    normalized.includes("熟") ||
    normalized.includes("回忆") ||
    normalized.includes("老歌") ||
    normalized.includes("familiar")
  ) {
    return nextTrack
      ? `懂，我往熟的那边收了。先是${program.currentTrack.artist}《${program.currentTrack.title}》，后面接${nextTrack.artist}《${nextTrack.title}》。`
      : `懂，我往熟的那边收了。先是${program.currentTrack.artist}《${program.currentTrack.title}》。`;
  }

  if (
    intent?.action === "skip" ||
    intent?.action === "select-track" ||
    normalized.includes("切歌") ||
    normalized.includes("下一首") ||
    normalized.includes("换") ||
    normalized.includes("skip")
  ) {
    if (intent?.action === "select-track") {
      return `行，就这首。现在是${program.currentTrack.artist}《${program.currentTrack.title}》。`;
    }

    return nextTrack
      ? `好，切了。现在是${program.currentTrack.artist}《${program.currentTrack.title}》，后面接${nextTrack.artist}《${nextTrack.title}》。`
      : `好，切了。现在是${program.currentTrack.artist}《${program.currentTrack.title}》。`;
  }

  if (
    normalized.includes("在干嘛") ||
    normalized.includes("干啥") ||
    normalized.includes("干嘛")
  ) {
    return `在听着你这句，也在盯着后面几首别掉味。你说。`;
  }

  if (
    normalized.includes("哈哈") ||
    normalized.includes("笑死") ||
    normalized.includes("草") ||
    normalized.includes("6")
  ) {
    return "你这一笑我就知道刚才那句有点东西了。";
  }

  if (normalized.includes("你")) {
    return "我在，这句我接住了。你继续说。";
  }

  const artist = program.currentTrack.artist;
  const title = program.currentTrack.title;
  return `${artist} 这首《${title}》还挂着呢。你要闲聊也行，要我动后面的歌也行。`;
}

/**
 * 把当前节目状态 / 用户消息 / agent 执行结果装配成 Hermes 的 messages 数组。
 *
 * 装配内容：
 *   - system：Claudio DJ 人设 + 风格规则 + 当前节目快照
 *   - assistant（可选）：agent 的执行摘要（"已经把歌切到 X"），让模型不重复说
 *   - history：最近 6 条聊天上下文（user/assistant 交替）
 *   - user：本轮消息
 *
 * 输出消息给 /api/agent route 拿去喂 Hermes /v1/chat/completions（开 stream=true）。
 * 整段是"提示词工程"：人设硬约束在 system 里，agent 工具结果用 assistant 角色"假装"
 * Claudio 自己已经做完，让模型只负责自然语气回话，不用再"推理"该不该切歌。
 */
export function buildChatModelMessages(input: ComposeDjReplyInput) {
  const history = (input.history ?? []).slice(-6);
  const nextTrack = input.program.queue[0];
  const agentSummary =
    input.state?.mode === "weather" && input.state.weather
      ? `工具结果：${input.state.weather.locationLabel} ${input.state.weather.conditionText} ${input.state.weather.temperatureC} 度。`
      : input.state?.summary ?? "这句先按自然聊天处理。";
  const systemPrompt = [
    "你是 Claudio，一个独立音乐电台的 DJ。",
    "像朋友一样聊天：自然、随意、直接，有人味。",
    "优先先接住用户那句，再顺手回应结果，不要解释后台流程。",
    "允许闲聊、吐槽、跑题，不要每句都拉回音乐。",
    "如果已经改了歌单或切了歌，只轻轻带一句结果，不要长解释。",
    "如果是在问天气，先直接给结论，再补一句自然口气。",
    "不要像 AI 助手，不要像客服，不要自我介绍。",
    "不要说“好的我来帮你”“根据你的偏好”“系统识别到”。",
    "不要列表，尽量用自然短句。",
    "回复控制在 10 到 70 个中文字符，宁可短一点。",
    "只有相关时才提当前歌或下一首，而且最多提一首。",
  ].join("\n");
  const contextPrompt = [
    "背景信息，只在相关时才用：",
    `当前歌：${input.program.currentTrack.artist} - ${input.program.currentTrack.title}`,
    `下一首：${nextTrack ? `${nextTrack.artist} - ${nextTrack.title}` : "暂无"}`,
    `当前时段：${input.program.scene}`,
    `最近动作：${input.memory.lastAction}`,
    `控制意图：${input.intent?.action ?? "none"}`,
    `agent 判断：${input.state?.mode ?? "chat"}`,
    agentSummary,
    `用户消息：${input.message}`,
  ].join("\n");

  return [
    { role: "system" as const, content: systemPrompt },
    ...history.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    { role: "user" as const, content: contextPrompt },
  ];
}

export const buildHermesDjMessages = buildChatModelMessages;

/**
 * 单首歌的推荐语润色（DJ 口吻，12-25 字，无引号无列表）。
 *
 * 调用者：rewrite-reasons API（懒加载润色当前 block）、daily-schedule hydrate 时缺字段也会走
 *
 * 失败路径：HTTP 非 2xx / 内容为空 / 网络异常
 *   → logReasonRewrite 打日志 → 返回 buildFallbackTrackReason（本地模板）
 *
 * 性能：单调用 ~1s。**不要批量并发调这个**，会把 Hermes 打挂——
 *      批量场景必须走 batchRewriteTrackReasons。
 */
export async function rewriteTrackReason(
  song: Song,
  scene: string,
): Promise<string> {
  try {
    const text = await requestChatCompletion(
      [
        {
          role: "system",
          content:
            "你是独立音乐电台 DJ。只输出一句推荐语，12-25字，自然口语，像 DJ 随口介绍这首歌。不要列表，不要解释，不要引号。",
        },
        {
          role: "user",
          content: `场景：${scene}\n氛围：${song.mood}\n种子：${song.reasonSeed}`,
        },
      ],
      80,
    );
    if (text) {
      logReasonRewrite("single.provider.ok", {
        scene,
        trackId: song.id,
        artist: song.artist,
        title: song.title,
      });
      return text;
    }
    logReasonRewrite("single.provider.empty", {
      scene,
      trackId: song.id,
      artist: song.artist,
      title: song.title,
    });
  } catch (error) {
    logReasonRewrite("single.provider.fail", {
      scene,
      trackId: song.id,
      artist: song.artist,
      title: song.title,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logReasonRewrite("single.fallback", {
    scene,
    trackId: song.id,
    artist: song.artist,
    title: song.title,
    seed: song.reasonSeed,
  });
  return buildFallbackTrackReason(song, scene);
}

/**
 * 批量推荐语生成：一次 LLM 调用生成 N 条推荐语，60s 超时。
 *
 * 提示词形式：
 *   user message 是"1. 场景:X 氛围:Y 种子:Z / 2. ... / 3. ..."编号清单
 *   system message 要求每行一句，按序号顺序输出
 *
 * 解析：拿到 content 后按 \n 切，前缀 "1. " 这种序号去掉，按 index 对回 track.id
 *
 * 容错：
 *   - 超时 / 非 2xx / 解析失败 → 留空 map（调用方会用 reasonSeed 占位）
 *   - 模型返回行数比 tracks 少 → 缺的行用 reasonSeed
 *
 * 用法约束：
 *   - schedule 生成阶段每段调一次（4 段 * ~10 首 = 一段 7s，串行 4 段 ~30s）
 *   - 当前已改成懒加载，只在切到段时调一次（见 rewrite-reasons route）
 *   - **不能并发**多个 batchRewrite 调用，Hermes 不抗多路并发
 */
export async function batchRewriteTrackReasons(
  tracks: Song[],
  scene: string,
): Promise<Map<string, string>> {
  const reasonMap = new Map<string, string>();
  const trackPreview = tracks.slice(0, 3).map((track) => `${track.artist} - ${track.title}`);

  logReasonRewrite("batch.start", {
    scene,
    count: tracks.length,
    provider: process.env.LLM_PROVIDER || "minimax",
    sample: trackPreview,
  });

  if (reasonMap.size === 0) {
    try {
      const timeout2 = new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("LLM batch timeout after 60000ms")), 60000),
      );
      const text = await Promise.race([
        requestChatCompletion(
          [
            {
              role: "system",
              content:
                "你是独立音乐电台 DJ 推荐语助手。按序号每行输出一句推荐语，12-25字，自然口语，像 DJ 在介绍歌。禁止列表、解释。",
            },
            {
              role: "user",
              content: tracks
                .map(
                  (t, i) =>
                    `${i + 1}. 场景：${scene}，氛围：${t.mood}，种子：${t.reasonSeed}`,
                )
                .join("\n"),
            },
          ],
          512,
        ),
        timeout2,
      ]);
      if (text) {
        const lines = text.split("\n").filter(Boolean);
        tracks.forEach((t, i) => {
          if (lines[i])
            reasonMap.set(t.id, lines[i].replace(/^\d+[\.\)、]\s*/, ""));
        });
        logReasonRewrite("batch.provider.ok", {
          scene,
          count: tracks.length,
          generated: lines.length,
          mapped: reasonMap.size,
        });
      } else {
        logReasonRewrite("batch.provider.empty", {
          scene,
          count: tracks.length,
        });
      }
    } catch (error) {
      logReasonRewrite("batch.provider.fail", {
        scene,
        count: tracks.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (reasonMap.size > 0 && reasonMap.size < tracks.length) {
    logReasonRewrite("batch.partial", {
      scene,
      count: tracks.length,
      mapped: reasonMap.size,
      fallbackCount: tracks.length - reasonMap.size,
    });
  }

  tracks.forEach((t) => {
    if (!reasonMap.has(t.id)) {
      logReasonRewrite("batch.fallback", {
        scene,
        trackId: t.id,
        artist: t.artist,
        title: t.title,
        seed: t.reasonSeed,
      });
      reasonMap.set(t.id, buildFallbackTrackReason(t, scene));
    }
  });

  return reasonMap;
}

/**
 * 预留真实 LLM 输出结构的占位类型，避免后续重构 API。
 */
export type ProgramDraft = Pick<
  RadioProgram,
  "hostIntro" | "explanation" | "controlsHint"
>;
