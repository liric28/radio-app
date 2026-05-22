import { ensureDailySchedule } from "@/lib/daily-schedule";
import { readMemory } from "@/lib/memory";
import {
  buildRuleBasedDjReply,
  composeDjReply,
  describeAgentState,
} from "@/lib/providers/llm";
import { applyChatIntentWithProgram, resolveChatIntent } from "@/lib/radio-engine";
import { isWeatherQuestion, readWeatherSnapshot } from "@/lib/weather";
import type {
  ChatAgentState,
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
  previewReply: string;
  finalizeReply: () => Promise<string>;
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
    nextProgram = (await applyChatIntentWithProgram(initialState.intent, program)) ?? program;
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

  const [memory, schedule] = await Promise.all([readMemory(), ensureDailySchedule()]);
  const previewReply = buildRuleBasedDjReply({
    message,
    program: nextProgram,
    memory,
    intent: nextState.intent,
    history,
    state: nextState,
  });

  return {
    state: nextState,
    program: nextProgram,
    schedule,
    previewReply,
    finalizeReply: () =>
      composeDjReply({
        message,
        program: nextProgram,
        memory,
        intent: nextState.intent,
        history,
        state: nextState,
      }),
  };
}
