type MinimaxChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type MinimaxChatOptions = {
  messages: MinimaxChatMessage[];
  temperature?: number;
};

type MinimaxChoice = {
  message?: {
    content?: string;
  };
};

type MinimaxResponse = {
  choices?: MinimaxChoice[];
  error?: {
    message?: string;
  };
};

function stripReasoningBlocks(content: string) {
  return content.replace(/<think>[\s\S]*?<\/think>\s*/gi, "").trim();
}

function getMinimaxConfig() {
  const apiKey = process.env.MINIMAX_API_KEY;
  const baseUrl = process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/v1";
  const model = process.env.MINIMAX_MODEL;

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/$/, ""),
    model,
  };
}

export function isMinimaxEnabled() {
  const { apiKey, model } = getMinimaxConfig();
  return Boolean(apiKey && model);
}

/**
 * 走 MiniMax 的 OpenAI 兼容接口，保持后续切换模型供应商时改动最小。
 */
export async function requestMinimaxChat({
  messages,
  temperature = 0.8,
}: MinimaxChatOptions) {
  const { apiKey, baseUrl, model } = getMinimaxConfig();

  if (!apiKey || !model) {
    throw new Error("MiniMax 未配置，请设置 MINIMAX_API_KEY 和 MINIMAX_MODEL");
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature,
      messages,
    }),
  });

  const payload = (await response.json()) as MinimaxResponse;

  if (!response.ok) {
    throw new Error(payload.error?.message || "MiniMax 请求失败");
  }

  const content = stripReasoningBlocks(
    payload.choices?.[0]?.message?.content?.trim() || "",
  );

  if (!content) {
    throw new Error("MiniMax 没有返回可用内容");
  }

  return content;
}
