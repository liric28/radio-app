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
export async function rewriteTrackReason(
  song: Song,
  scene: string,
): Promise<string> {
  if (!isMinimaxEnabled()) {
    return `${scene}里保留${song.mood}质感，${song.reasonSeed}`;
  }

  const systemPrompt = [
    "你是一个独立音乐电台的 DJ 推荐语润色助手。",
    "输入：场景名 + 歌曲的氛围标签(mood) + 原始推荐种子(reasonSeed)",
    "输出：一句话推荐语，12-25字，自然口语，像 DJ 在介绍歌。",
    "禁止：列表、解释性语言、套话。不要出现 mood/seed/标签 等系统词汇。",
  ].join("\n");

  const userPrompt = [
    `场景：${scene}`,
    `氛围标签：${song.mood}`,
    `原始推荐种子：${song.reasonSeed}`,
  ].join("\n");

  try {
    return await requestMinimaxChat({
      messages: [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: userPrompt },
      ],
      temperature: 0.85,
    });
  } catch {
    return `${scene}里保留${song.mood}质感，${song.reasonSeed}`;
  }
}

/**
 * 预留真实 LLM 输出结构的占位类型，避免后续重构 API。
 */
export type ProgramDraft = Pick<
  RadioProgram,
  "hostIntro" | "explanation" | "controlsHint"
>;
