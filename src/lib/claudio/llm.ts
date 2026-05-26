type ClaudioLlmResponse = {
  title: string;
  say: string;
  play: string[];
  segments: Array<Record<string, unknown>>;
  intros: string[];
  reason: string;
  mode?: string;
};

const DEFAULT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 120000);
const DEFAULT_PROVIDER = process.env.LLM_PROVIDER || "deepseek";
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const DEEPSEEK_REASONING_EFFORT = process.env.DEEPSEEK_REASONING_EFFORT || "";
const DEEPSEEK_THINKING = process.env.DEEPSEEK_THINKING || "";
const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL || "https://api.minimax.chat";
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || "abab6.5s-chat";

type GenerateJsonOptions = {
  provider?: string;
  model?: string;
  timeoutMs?: number;
};

export async function generateClaudioJson(prompt: string, options: GenerateJsonOptions = {}) {
  const provider = options.provider || DEFAULT_PROVIDER;
  if (provider === "deepseek") return callDeepSeek(prompt, options);
  if (provider === "minimax") return callMiniMax(prompt, options);
  throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
}

async function callDeepSeek(prompt: string, options: GenerateJsonOptions) {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY not set");
  }

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({
    baseURL: process.env.DEEPSEEK_BASE_URL || DEEPSEEK_BASE_URL,
    apiKey: process.env.DEEPSEEK_API_KEY,
  });
  const model = options.model || process.env.DEEPSEEK_MODEL || DEEPSEEK_MODEL;
  const request = {
    model,
    messages: [
      { role: "system", content: "You are Claudio FM. Return strict JSON only." },
      { role: "user", content: prompt },
    ],
    stream: false,
  } as Record<string, unknown>;
  if (DEEPSEEK_THINKING) request.thinking = { type: DEEPSEEK_THINKING };
  if (DEEPSEEK_REASONING_EFFORT) request.reasoning_effort = DEEPSEEK_REASONING_EFFORT;

  const completion = await withTimeout(
    client.chat.completions.create(request as never),
    options.timeoutMs || DEFAULT_TIMEOUT_MS,
    `DeepSeek request timed out after ${Math.round((options.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s`,
  );
  const raw = (completion as { choices?: Array<{ message?: { content?: string | null } }> }).choices?.[0]?.message?.content?.trim() || "";
  return parseResponse(raw);
}

async function callMiniMax(prompt: string, options: GenerateJsonOptions) {
  if (!process.env.MINIMAX_API_KEY) {
    throw new Error("MINIMAX_API_KEY not set");
  }

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({
    baseURL: process.env.MINIMAX_BASE_URL || MINIMAX_BASE_URL,
    apiKey: process.env.MINIMAX_API_KEY,
  });
  const model = options.model || process.env.MINIMAX_MODEL || MINIMAX_MODEL;
  const completion = await withTimeout(
    client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "You are Claudio FM. Return strict JSON only." },
        { role: "user", content: prompt },
      ],
      stream: false,
    } as never),
    options.timeoutMs || DEFAULT_TIMEOUT_MS,
    `MiniMax request timed out after ${Math.round((options.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s`,
  );
  const raw = (completion as { choices?: Array<{ message?: { content?: string | null } }> }).choices?.[0]?.message?.content?.trim() || "";
  return parseResponse(raw);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function parseResponse(raw: string): ClaudioLlmResponse {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Partial<ClaudioLlmResponse>;
      return {
        title: parsed.title || "",
        say: parsed.say || "",
        play: Array.isArray(parsed.play) ? parsed.play : [],
        segments: Array.isArray(parsed.segments) ? parsed.segments : [],
        intros: Array.isArray(parsed.intros) ? parsed.intros : [],
        reason: parsed.reason || "",
        mode: parsed.mode || "",
      };
    } catch {
      // fall through
    }
  }
  return { title: "", say: raw || "Okay.", play: [], segments: [], intros: [], reason: "", mode: "" };
}
