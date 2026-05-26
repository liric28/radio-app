type ChatMessagePayload = {
  role: string;
  content: string;
};

const DEFAULT_PROVIDER = process.env.LLM_PROVIDER || "minimax";
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL || "https://api.minimax.chat";
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || "abab6.5s-chat";

export function buildChatLlmRequest(messages: ChatMessagePayload[]) {
  const provider = DEFAULT_PROVIDER;
  if (provider === "deepseek") {
    if (!process.env.DEEPSEEK_API_KEY) {
      throw new Error("DEEPSEEK_API_KEY not set");
    }
    return {
      provider,
      url: `${(process.env.DEEPSEEK_BASE_URL || DEEPSEEK_BASE_URL).replace(/\/+$/, "")}/chat/completions`,
      headers: {
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: {
        model: process.env.DEEPSEEK_MODEL || DEEPSEEK_MODEL,
        messages,
        max_tokens: 512,
        stream: true,
      },
    };
  }

  if (provider === "minimax") {
    if (!process.env.MINIMAX_API_KEY) {
      throw new Error("MINIMAX_API_KEY not set");
    }
    return {
      provider,
      url: `${(process.env.MINIMAX_BASE_URL || MINIMAX_BASE_URL).replace(/\/+$/, "")}/chat/completions`,
      headers: {
        Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: {
        model: process.env.MINIMAX_MODEL || MINIMAX_MODEL,
        messages,
        max_tokens: 512,
        stream: true,
      },
    };
  }

  throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
}

export async function requestChatCompletion(messages: ChatMessagePayload[], maxTokens = 512) {
  const request = buildChatLlmRequest(messages);
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({
      ...request.body,
      stream: false,
      max_tokens: maxTokens,
      messages,
    }),
  });

  if (!response.ok) {
    throw new Error(`${request.provider} HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() || "";
}
