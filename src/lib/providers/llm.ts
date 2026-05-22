import type { ChatIntent, ChatMessage, RadioMemory, RadioProgram, Song } from "@/lib/types";
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
};

export function buildRuleBasedDjReply({ message, program, memory, intent }: ComposeDjReplyInput) {
  const normalized = message.trim().toLowerCase();
  const nextTrack = program.queue[0];

  if (!normalized) {
    return "你先给我一句明确一点的话，我再顺着这条情绪线继续排歌。";
  }

  if (
    intent?.action === "calmer" ||
    normalized.includes("安静") ||
    normalized.includes("calm") ||
    normalized.includes("轻") ||
    normalized.includes("慢")
  ) {
    return `收到，我会把这条线往更低照度的方向压一点。现在这首先留住 ${program.currentTrack.mood} 的底色，下一首尽量往 ${nextTrack?.title ?? "更安静的段落"} 过渡。`;
  }

  if (
    intent?.action === "familiar" ||
    normalized.includes("熟") ||
    normalized.includes("回忆") ||
    normalized.includes("老歌") ||
    normalized.includes("familiar")
  ) {
    return `明白，你现在要的是熟悉感，不是刺激感。我会优先从你最近反应更稳的歌里挑，先让 ${program.currentTrack.artist} 这首站住，再把后面收回到你更常听的脉络。`;
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
      return `收到，我直接把你点到的这首推上来。先把现在这段收住，接下来就切到更贴你刚才那句情绪的落点。`;
    }

    return `可以切，但我不想硬断情绪。现在这首播完就把你带到 ${nextTrack?.artist ?? "下一段"}，这样节目流不会突然塌掉。`;
  }

  return `收到。你现在这句更像是在给我校准频道，不是在点歌。我会继续围着“${program.scene}”这条场景线走，保留 ${program.currentTrack.artist} 的质感，同时参考你最近“${memory.lastAction}”之后留下的偏好。`;
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
  const systemPrompt = [
    "你是 Claudio FM 的私人 DJ。",
    "你要用自然中文短回复，像真人电台主持，不要列表，不要解释自己是 AI。",
    "回复控制在 60 到 120 个中文字符。",
    "只能围绕用户现有曲库和当前节目说话，不要编造不存在的歌名、艺人或功能。",
    "如果用户在调情绪或切歌，要先接住情绪，再顺势说明你会怎么调整。",
  ].join("\n");
  const contextPrompt = [
    `当前场景：${input.program.scene}`,
    `当前节目：${input.program.segmentTitle}`,
    `当前歌曲：${input.program.currentTrack.artist} - ${input.program.currentTrack.title}`,
    `当前歌曲情绪：${input.program.currentTrack.mood}`,
    `下一首候选：${nextTrack ? `${nextTrack.artist} - ${nextTrack.title}` : "暂无"}`,
    `当前能量标签：${input.program.energyLabel}`,
    `记忆摘要：${input.program.memorySummary}`,
    `最近动作：${input.memory.lastAction}`,
    `系统识别的控制意图：${input.intent?.action ?? "none"}`,
    `用户刚说：${input.message}`,
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
 * 预留真实 LLM 输出结构的占位类型，避免后续重构 API。
 */
export type ProgramDraft = Pick<
  RadioProgram,
  "hostIntro" | "explanation" | "controlsHint"
>;
