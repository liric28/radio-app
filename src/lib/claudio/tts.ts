import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import https from "node:https";

const CACHE_DIR = path.join(process.cwd(), "cache", "tts");
const VOLCENGINE_DEFAULT_ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";

fs.mkdirSync(CACHE_DIR, { recursive: true });

type TtsOptions = {
  provider?: string;
  role?: "station" | "caller";
  apiKey?: string;
  endpoint?: string;
  resourceId?: string;
  voiceType?: string;
  voiceId?: string;
  voice?: string;
  format?: string;
  sampleRate?: string | number;
  additions?: string;
};

function md5(text: string) {
  return crypto.createHash("md5").update(text).digest("hex");
}

function getVoiceForProvider(provider: string, options: TtsOptions = {}) {
  if (provider === "fish") return options.voiceId || process.env.FISH_VOICE_ID || "";
  if (provider === "minimax") return options.voiceType || process.env.MINIMAX_TTS_VOICE_TYPE || "Speech-02";
  if (provider === "volcengine") return options.voiceType || process.env.VOLCENGINE_TTS_VOICE_TYPE || "";
  return options.voice || process.env.KOKORO_VOICE || "";
}

function cachePath(text: string, provider: string, options: TtsOptions = {}) {
  const voice = getVoiceForProvider(provider, options);
  const role = options.role || "station";
  return path.join(CACHE_DIR, `${md5(`${role}:${provider}:${voice}:${text}`)}.mp3`);
}

export async function synthesizeClaudioSpeech(text: string, options: TtsOptions = {}) {
  const provider = options.provider || process.env.TTS_PROVIDER || "volcengine";
  const cached = cachePath(text, provider, options);
  if (fs.existsSync(cached)) return cached;

  if (provider === "volcengine") return synthesizeVolcengine(text, cached, options);
  if (provider === "minimax") return synthesizeMiniMax(text, cached, options);
  throw new Error(`Unsupported TTS provider: ${provider}`);
}

function buildVolcenginePayload(text: string, options: TtsOptions = {}) {
  const voiceType = options.voiceType || process.env.VOLCENGINE_TTS_VOICE_TYPE;
  if (!voiceType) {
    throw new Error("VOLCENGINE_TTS_VOICE_TYPE not set");
  }

  return {
    req_params: {
      text,
      speaker: voiceType,
      additions: options.additions || process.env.VOLCENGINE_TTS_ADDITIONS || JSON.stringify({
        disable_markdown_filter: true,
        enable_language_detector: true,
        enable_latex_tn: true,
        disable_default_bit_rate: true,
        max_length_to_filter_parenthesis: 0,
        cache_config: { text_type: 1, use_cache: true },
      }),
      audio_params: {
        format: options.format || process.env.VOLCENGINE_TTS_FORMAT || "mp3",
        sample_rate: Number(options.sampleRate || process.env.VOLCENGINE_TTS_SAMPLE_RATE || 24000),
      },
    },
  };
}

function extractJsonObjects(text: string) {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  const rest = depth > 0 && start !== -1 ? text.slice(start) : "";
  return { objects, rest };
}

async function synthesizeVolcengine(text: string, outPath: string, options: TtsOptions = {}) {
  const apiKey = options.apiKey || process.env.VOLCENGINE_TTS_API_KEY;
  const resourceId = options.resourceId || process.env.VOLCENGINE_TTS_RESOURCE_ID;
  if (!apiKey || !resourceId) {
    throw new Error("VOLCENGINE_TTS_API_KEY or VOLCENGINE_TTS_RESOURCE_ID not set");
  }

  const endpoint = options.endpoint || process.env.VOLCENGINE_TTS_ENDPOINT || VOLCENGINE_DEFAULT_ENDPOINT;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": resourceId,
      "X-Api-Request-Id": crypto.randomUUID(),
      Connection: "keep-alive",
    },
    body: JSON.stringify(buildVolcenginePayload(text, options)),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Volcengine TTS error ${response.status}: ${errorText}`);
  }

  const audioChunks: Buffer[] = [];
  let buffer = "";
  const decoder = new TextDecoder();
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Volcengine TTS returned empty stream");
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = value;
    buffer += decoder.decode(chunk, { stream: true });
    const parsed = extractJsonObjects(buffer);
    buffer = parsed.rest;
    for (const raw of parsed.objects) {
      const message = JSON.parse(raw) as { code?: number; message?: string; data?: string };
      if (message.code && message.code !== 20000000) {
        throw new Error(`Volcengine TTS response error ${message.code}: ${message.message || ""}`);
      }
      if (message.data) {
        audioChunks.push(Buffer.from(message.data, "base64"));
      }
    }
  }

  buffer += decoder.decode();
  const parsed = extractJsonObjects(buffer);
  for (const raw of parsed.objects) {
    const message = JSON.parse(raw) as { code?: number; message?: string; data?: string };
    if (message.code && message.code !== 20000000) {
      throw new Error(`Volcengine TTS response error ${message.code}: ${message.message || ""}`);
    }
    if (message.data) audioChunks.push(Buffer.from(message.data, "base64"));
  }

  if (!audioChunks.length) {
    throw new Error("Volcengine TTS returned no audio data");
  }

  fs.writeFileSync(outPath, Buffer.concat(audioChunks));
  return outPath;
}

async function synthesizeMiniMax(text: string, outPath: string, options: TtsOptions = {}) {
  const apiKey = options.apiKey || process.env.MINIMAX_API_KEY;
  const voiceType = options.voiceType || process.env.MINIMAX_TTS_VOICE_TYPE || "male-qn-qingse";
  if (!apiKey) {
    throw new Error("MINIMAX_API_KEY not set");
  }

  const payload = {
    model: "speech-2.8-hd",
    text,
    stream: false,
    voice_setting: {
      voice_id: voiceType,
      speed: 1,
      vol: 1,
      pitch: 0,
      emotion: "happy",
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: "mp3",
      channel: 1,
    },
  };

  return new Promise<string>((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = https.request(
      {
        hostname: "api.minimaxi.com",
        path: "/v1/t2a_v2",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          let errorText = "";
          response.on("data", (chunk) => {
            errorText += chunk;
          });
          response.on("end", () => reject(new Error(`MiniMax TTS error ${response.statusCode}: ${errorText}`)));
          return;
        }

        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString()) as {
              base_resp?: { status_code?: number; status_msg?: string };
              data?: { audio?: string };
            };
            if (result.base_resp && result.base_resp.status_code !== 0) {
              reject(new Error(`MiniMax TTS API error ${result.base_resp.status_code}: ${result.base_resp.status_msg}`));
              return;
            }
            const hexAudio = result.data?.audio;
            if (!hexAudio) {
              reject(new Error("MiniMax TTS returned no audio data"));
              return;
            }
            fs.writeFileSync(outPath, Buffer.from(hexAudio, "hex"));
            resolve(outPath);
          } catch (error) {
            reject(new Error(`MiniMax TTS parse error: ${(error as Error).message}`));
          }
        });
      },
    );

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}
