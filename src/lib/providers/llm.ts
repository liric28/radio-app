import type { RadioProgram, Song } from "@/lib/types";

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

/**
 * 预留真实 LLM 输出结构的占位类型，避免后续重构 API。
 */
export type ProgramDraft = Pick<
  RadioProgram,
  "hostIntro" | "explanation" | "controlsHint"
>;
