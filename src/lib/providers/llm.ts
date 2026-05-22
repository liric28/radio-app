import type {
  ChatAgentState,
  ChatIntent,
  ChatMessage,
  RadioMemory,
  RadioProgram,
  Song,
} from "@/lib/types";
import { isMinimaxEnabled, requestMinimaxChat } from "@/lib/providers/minimax";

type ComposeIntroInput = {
  scene: string;
  persona: string;
  currentTrack: Song;
  nextTrack: Song;
  moodHint: string;
};

/**
 * 让 AI 根据场景和情绪标签推荐每段适合的歌曲数量。
 * 返回数字，失败时退回 10。
 */
export async function recommendBlockTrackCount(
  scene: string,
  moods: string[],
  catalogSize: number,
): Promise<number> {
  if (!isMinimaxEnabled()) return 10;

  const prompt = [
    `场景：${scene}`,
    `情绪：${moods.join(" / ")}`,
    `曲库总量：${catalogSize} 首`,
    "",
    "根据这个场景的时长和情绪密度，推荐合适的歌曲数量（只输出一个数字，不要任何解释）。",
  ].join("\n");

  try {
    const raw = await requestMinimaxChat({
      messages: [
        {
          role: "system",
          content:
            "你是一个节目策划助手。用户给你场景和情绪标签，你只输出一个数字表示推荐歌曲数量。只回复数字，不要任何文字、标点或解释。",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 5,
    });
    const parsed = parseInt(raw.replace(/[^0-9]/g, ""), 10);
    return isNaN(parsed) ? 10 : Math.max(3, Math.min(parsed, 20));
  } catch {
    return 10;
  }
}

/**
 * 第一版先用本地规则模拟 DJ 串词，后续再替换为真实模型调用。
 */
export async function composeHostIntro(input: ComposeIntroInput) {
  return `这里是 ${input.persona}。现在把 ${input.currentTrack.artist} 的《${input.currentTrack.title}》放在前面，不是为了煽情，而是因为 ${input.scene} 更适合先用 ${input.moodHint} 打底，下一首会顺着滑到 ${input.nextTrack.artist} 的《${input.nextTrack.title}》，让情绪过门更自然。`;
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
    const changeText = currentChanged
      ? `当前歌已切到 ${afterProgram.currentTrack.artist}《${afterProgram.currentTrack.title}》。`
      : "当前歌没切，但后面的队列已经改了。";
    const nextText = nextTrack
      ? `接下来会跟到 ${nextTrack.artist}《${nextTrack.title}》。`
      : "暂时没有明确下一首。";
    return `用户消息是“${message}”；这是在调电台。${changeText}${nextText}`;
  }

  return "用户在正常聊天，先自然接话，不要解释系统。";
}

export function buildRuleBasedDjReply({
  message,
  program,
  memory,
  intent,
  state,
}: ComposeDjReplyInput) {
  const normalized = message.trim().toLowerCase();

  if (!normalized) {
    return "你先说句人话给我，我接着聊。";
  }

  if (state?.mode === "weather" && state.weather) {
    return `今天${state.weather.locationLabel}${state.weather.conditionText}，现在差不多${state.weather.temperatureC}度。`;
  }

  if (
    intent?.action === "calmer" ||
    normalized.includes("安静") ||
    normalized.includes("calm") ||
    normalized.includes("轻") ||
    normalized.includes("慢")
  ) {
    return `行，我收一点，不给你炸耳朵。先把这首稳住，后面那首我也往 softer 那边带。`;
  }

  if (
    intent?.action === "familiar" ||
    normalized.includes("熟") ||
    normalized.includes("回忆") ||
    normalized.includes("老歌") ||
    normalized.includes("familiar")
  ) {
    return `懂，给你往熟的那边靠，不整陌生的。后面我先留中文线，别一下拐太猛。`;
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
      return "行，就这首，我给你顶上来。";
    }

    return `好，切。我不拖，下一首直接上。`;
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
 * DJ 对话优先走真实模型；未配置时退回本地规则，保证输入框始终可用。
 */
export async function composeDjReply(input: ComposeDjReplyInput) {
  if (!isMinimaxEnabled()) {
    return buildRuleBasedDjReply(input);
  }

  const history = (input.history ?? []).slice(-6);
  const nextTrack = input.program.queue[0];
  const agentSummary =
    input.state?.mode === "weather" && input.state.weather
      ? `工具结果：${input.state.weather.locationLabel} ${input.state.weather.conditionText} ${input.state.weather.temperatureC} 度。`
      : input.state?.summary ?? "这句先按自然聊天处理。";
  const systemPrompt = [
    "你是 Claudio。像我现在聊天这样回：自然、随意、直接，有人味。",
    "优先像朋友一样接话。允许闲聊、吐槽、跑题，不要每句都拉回音乐。",
    "如果 agent 已经替你做了天气查询或歌单动作，只顺着结果说话，不要解释后台流程。",
    "禁止出现这些表达：校准频道、场景线、系统识别、根据你的偏好、你这句更像是在、我会围着、我正在为你。",
    "不要复述设定，不要总结任务，不要像 AI 助手，不要像客服，不要自我介绍。",
    "多用自然口语短句，像即时聊天，不要列表。",
    "回复控制在 10 到 70 个中文字符，宁可短一点。",
    "只有在相关时才提当前歌或下一首，而且最多提一首。",
    "如果用户在问外部事实，先直接给结论，再补一嘴自然口气，不要编。",
    "如果用户在调情绪或切歌，先接住情绪，再很轻地带一句结果，不要长解释。",
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

  const messages = [
    { role: "system" as const, content: systemPrompt },
    ...history.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    { role: "user" as const, content: contextPrompt },
  ];

  try {
    return await requestMinimaxChat({
      messages,
      temperature: 0.9,
    });
  } catch {
    return buildRuleBasedDjReply(input);
  }
}

/**
 * 用 AI 润色单首歌的推荐理由，保留 DJ 口吻。
 * 失败时退回模板句，不阻塞播放流程。
 */
// 真正的串行化信号灯，防止 Hermes 被 48 个并发请求打挂

export async function rewriteTrackReason(
  song: Song,
  scene: string,
): Promise<string> {
  if (isMinimaxEnabled()) {
    const systemPrompt =
      "你是独立音乐电台 DJ。只输出一句话推荐语，12-25字，自然口语，像 DJ 随口说的一句介绍歌的话。不要 markdown，不要列表，不要解释。";

    const userPrompt = `${scene}｜${song.mood}｜${song.reasonSeed}`;

    try {
      return await requestMinimaxChat({
        messages: [
          { role: "system" as const, content: systemPrompt },
          { role: "user" as const, content: userPrompt },
        ],
        temperature: 0.8,
        max_tokens: 50,
      });
    } catch {
      // fall through to fallback
    }
  }

  return `${scene}里保留${song.mood}质感，${song.reasonSeed}`;
}

/**
 * 批量生成推荐语。一次调用生成多条，5秒超时。
 * 专给 SSR 用，避免 48 个并发请求打挂 Hermes。
 */
export async function batchRewriteTrackReasons(
  tracks: Song[],
  scene: string,
): Promise<Map<string, string>> {
  const reasonMap = new Map<string, string>();

  // 补全缺失的 fallback（先用 batchRewriteTrackReasons 尝试 Minimax，失败后 Hermes）
  try {
    const userPrompt = tracks
      .map(
        (t, i) =>
          `${i + 1}. ${scene}｜${t.mood}｜${t.reasonSeed}`,
      )
      .join("\n");

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("batch timeout")), 30000),
    );
    const result = await Promise.race([
      requestMinimaxChat({
        messages: [
          {
            role: "system",
            content:
              "你是独立音乐电台 DJ。每行只输出一句推荐语，12-25字，自然口语，像 DJ 随口说的介绍歌的话。不要 markdown，不要列表，不要解释。",
          },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.8,
        max_tokens: 200,
      }),
      timeout,
    ]);
    const lines = result.split("\n").filter(Boolean);
    tracks.forEach((t, i) => {
      if (lines[i])
        reasonMap.set(t.id, lines[i].replace(/^\d+[\.\)、]\s*/, ""));
    });
  } catch {
    // Minimax 失败，尝试 Hermes 批量生成
    try {
      const timeout2 = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Hermes batch timeout")), 60000),
      );
      const res = await Promise.race([
        fetch("http://127.0.0.1:8642/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "hermes",
            messages: [
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
            max_tokens: 512,
          }),
        }),
        timeout2,
      ]) as Response;
      const data = (await (res as Response).json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (text) {
        const lines = text.split("\n").filter(Boolean);
        tracks.forEach((t, i) => {
          if (lines[i])
            reasonMap.set(t.id, lines[i].replace(/^\d+[\.\)、]\s*/, ""));
        });
      }
    } catch {
      // Hermes 也失败
    }
  }

  // SSR 直接用模板，避免 Hermes 大 context 阻塞首屏
  // 客户端 PlayerShell 可在 useEffect 里调用 AI 润色 API 替换模板
  tracks.forEach((t) => {
    reasonMap.set(t.id, `${scene}里保留${t.mood}质感，${t.reasonSeed}`);
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
