import type {
  ChatAgentState,
  ChatIntent,
  ChatMessage,
  RadioMemory,
  RadioProgram,
  Song,
} from "@/lib/types";

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
  void scene;
  void moods;
  void catalogSize;
  return 10;
}

const INTRO_TEMPLATES = [
  `这里是 {persona}。把 {currentArtist} 的《{currentTitle}》放在前面，不是因为煽情，而是因为 {scene} 更适合先用 {moodHint} 打底。下一首自然滑到 {nextArtist} 的《{nextTitle}》，让情绪过门更顺。`,
  `欢迎回到 {persona}。我选了 {currentArtist} 的《{currentTitle}》开场，原因是 {scene} 需要一点 {moodHint} 垫底。接下来的 {nextArtist}《{nextTitle}》，是顺着一个情绪弧度走的。`,
  `{persona} 时间。先上 {currentArtist} 的《{currentTitle}》，{scene} 的节奏里，{moodHint} 是最好的切入点。后面 {nextArtist}《{nextTitle}》，刚好接住这个情绪。`,
  `{currentArtist} 的《{currentTitle}》——这是 {scene} 最好的开场。{moodHint} 打底，情绪先落下来，再让 {nextArtist} 的《{nextTitle}》把氛围顺上去。`,
  `{persona} 回来了。《{currentTitle}》是今天的起点，{scene} 里 {moodHint} 能让人快速沉进去。然后是 {nextArtist} 的《{nextTitle}》，自然过渡，不打断。`,
  `今天的开场，我选 {currentArtist} 的《{currentTitle}》。{scene} 的基调，先用 {moodHint} 定住。《{nextTitle}》跟在后面，是同一个情绪方向的自然延伸。`,
  `{currentArtist}《{currentTitle}》，这首歌放在 {scene} 最合适。{moodHint} 是引子，把人带进去，之后 {nextArtist} 的《{nextTitle}》顺势把情绪展开。`,
  `{persona} 这里。先让 {currentArtist} 的《{currentTitle}》响起，{scene} 需要这种 {moodHint} 铺底。{nextArtist} 的《{nextTitle}》会在后面接上，保持连贯。`,
  `《{currentTitle}》，{currentArtist} 的声音打开 {scene}。我在这首歌后面藏了一个情绪钩子——{nextArtist} 的《{nextTitle}》。{moodHint} 先行，过渡就不生硬。`,
  `{persona} 的节目从这里开始。《{currentTitle}》对应 {scene}，先用 {moodHint} 建立氛围感，然后 {nextArtist} 的《{nextTitle}》把这种感觉延续下去，不割裂。`,
];

function fillIntro(template: string, input: ComposeIntroInput) {
  return template
    .replaceAll("{persona}", input.persona)
    .replaceAll("{currentArtist}", input.currentTrack.artist)
    .replaceAll("{currentTitle}", input.currentTrack.title)
    .replaceAll("{nextArtist}", input.nextTrack.artist)
    .replaceAll("{nextTitle}", input.nextTrack.title)
    .replaceAll("{scene}", input.scene)
    .replaceAll("{moodHint}", input.moodHint);
}

/**
 * 第一版先用本地规则模拟 DJ 串词，后续再替换为真实模型调用。
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

export function buildHermesDjMessages(input: ComposeDjReplyInput) {
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

/**
 * 用 AI 润色单首歌的推荐理由，保留 DJ 口吻。
 * 失败时退回模板句，不阻塞播放流程。
 */
// 真正的串行化信号灯，防止 Hermes 被 48 个并发请求打挂

export async function rewriteTrackReason(
  song: Song,
  scene: string,
): Promise<string> {
  try {
    const response = await fetch("http://127.0.0.1:8642/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "hermes",
        temperature: 0.8,
        max_tokens: 80,
        messages: [
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
      }),
    });
    if (!response.ok) {
      throw new Error(`Hermes HTTP ${response.status}`);
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (text) {
      logReasonRewrite("single.hermes.ok", {
        scene,
        trackId: song.id,
        artist: song.artist,
        title: song.title,
      });
      return text;
    }
    logReasonRewrite("single.hermes.empty", {
      scene,
      trackId: song.id,
      artist: song.artist,
      title: song.title,
    });
  } catch (error) {
    logReasonRewrite("single.hermes.fail", {
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
 * 批量生成推荐语。一次调用生成多条，5秒超时。
 * 专给 SSR 用，避免 48 个并发请求打挂 Hermes。
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
    provider: "hermes",
    sample: trackPreview,
  });

  if (reasonMap.size === 0) {
    try {
      const timeout2 = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Hermes batch timeout after 60000ms")), 60000),
      );
      const res = await Promise.race([
        fetch("http://127.0.0.1:8642/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "hermes",
            temperature: 0.8,
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
      if (!res.ok) {
        throw new Error(`Hermes HTTP ${res.status}`);
      }
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
        logReasonRewrite("batch.hermes.ok", {
          scene,
          count: tracks.length,
          generated: lines.length,
          mapped: reasonMap.size,
        });
      } else {
        logReasonRewrite("batch.hermes.empty", {
          scene,
          count: tracks.length,
        });
      }
    } catch (error) {
      logReasonRewrite("batch.hermes.fail", {
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
