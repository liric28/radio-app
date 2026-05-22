"use client";

import { type CSSProperties, type KeyboardEvent, type MouseEvent, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { DotmHex1 } from "@/components/ui/dotm-hex-1";
import { DotmHex10 } from "@/components/ui/dotm-hex-10";
import { DotmSquare15 } from "@/components/ui/dotm-square-15";
import { DotmSquare18 } from "@/components/ui/dotm-square-18";
import { DotmCircular8 } from "@/components/ui/dotm-circular-8";
import styles from "@/app/page.module.css";
import type {
  ChatAgentMode,
  ChatAgentTool,
  ChatIntent,
  ChatMessage,
  DailySchedule,
  RadioProgram,
  WeatherSnapshot,
} from "@/lib/types";

type RadioResponse = {
  ok: boolean;
  program: RadioProgram;
  schedule?: DailySchedule;
};

type ChatResponse = {
  ok: boolean;
  reply: ChatMessage;
  intent?: ChatIntent;
  mode?: ChatAgentMode;
  tool?: ChatAgentTool;
  program?: RadioProgram;
  schedule?: DailySchedule;
  weather?: WeatherSnapshot | null;
  pending?: boolean;
  jobId?: string;
  message?: string;
};

type FeedbackAction = "skip" | "fresh" | "calmer" | "familiar";

const actionLabels: Record<FeedbackAction, string> = {
  skip: "SKIP",
  fresh: "SWITCH",
  calmer: "CALMER",
  familiar: "FAMILIAR",
};

type PlayerShellProps = {
  initialProgram: RadioProgram;
  initialSchedule: DailySchedule;
  initialWeather: WeatherSnapshot | null;
};

const dotGlyphs: Record<string, string[]> = {
  A: [
    "001100",
    "010010",
    "100001",
    "111111",
    "100001",
    "100001",
    "100001",
  ],
  C: [
    "011110",
    "100001",
    "100000",
    "100000",
    "100000",
    "100001",
    "011110",
  ],
  D: [
    "111100",
    "100010",
    "100001",
    "100001",
    "100001",
    "100010",
    "111100",
  ],
  I: [
    "111111",
    "001100",
    "001100",
    "001100",
    "001100",
    "001100",
    "111111",
  ],
  L: [
    "100000",
    "100000",
    "100000",
    "100000",
    "100000",
    "100000",
    "111111",
  ],
  O: [
    "011110",
    "100001",
    "100001",
    "100001",
    "100001",
    "100001",
    "011110",
  ],
  U: [
    "100001",
    "100001",
    "100001",
    "100001",
    "100001",
    "100001",
    "011110",
  ],
  0: [
    "011110",
    "100001",
    "100011",
    "100101",
    "101001",
    "110001",
    "011110",
  ],
  1: [
    "001100",
    "010100",
    "100100",
    "000100",
    "000100",
    "000100",
    "111111",
  ],
  2: [
    "011110",
    "100001",
    "000001",
    "000110",
    "011000",
    "100000",
    "111111",
  ],
  3: [
    "111110",
    "000001",
    "000001",
    "011110",
    "000001",
    "000001",
    "111110",
  ],
  4: [
    "000110",
    "001010",
    "010010",
    "100010",
    "111111",
    "000010",
    "000010",
  ],
  5: [
    "111111",
    "100000",
    "100000",
    "111110",
    "000001",
    "000001",
    "111110",
  ],
  6: [
    "011110",
    "100000",
    "100000",
    "111110",
    "100001",
    "100001",
    "011110",
  ],
  7: [
    "111111",
    "000001",
    "000010",
    "000100",
    "001000",
    "010000",
    "100000",
  ],
  8: [
    "011110",
    "100001",
    "100001",
    "011110",
    "100001",
    "100001",
    "011110",
  ],
  9: [
    "011110",
    "100001",
    "100001",
    "011111",
    "000001",
    "000001",
    "011110",
  ],
  " ": [
    "0000",
    "0000",
    "0000",
    "0000",
    "0000",
    "0000",
    "0000",
  ],
};

function DotMatrixText({
  text,
  className,
  cellClassName,
}: {
  text: string;
  className: string;
  cellClassName: string;
}) {
  return (
    <div className={className} aria-label={text}>
      {text.toUpperCase().split("").map((char, charIndex) => {
        const glyph = dotGlyphs[char] ?? dotGlyphs[" "];
        const columnCount = glyph[0]?.length ?? 1;

        return (
          <span
            key={`${char}-${charIndex}`}
            className={styles.dotGlyph}
            style={
              {
                gridTemplateColumns: `repeat(${columnCount}, var(--dot-size, 6px))`,
              } as CSSProperties
            }
          >
            {glyph.flatMap((row, rowIndex) =>
              row.split("").map((bit, colIndex) => (
                <i
                  key={`${charIndex}-${rowIndex}-${colIndex}`}
                  className={`${cellClassName} ${bit === "1" ? styles.dotOn : styles.dotOff}`}
                />
              )),
            )}
          </span>
        );
      })}
    </div>
  );
}

/**
 * 按参考图组织成单列电台面板，主视图优先展示时间、控制和 DJ 对话。
 */
/**
 * Radio player shell — single-column station panel, prioritizes clock, controls and DJ info.
 */

export function PlayerShell({ initialProgram, initialSchedule, initialWeather }: PlayerShellProps) {
  const waveformBars = [0.18, 0.56, 0.32, 0.8, 0.28, 0.66, 0.22, 0.74];
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [program, setProgram] = useState<RadioProgram>(initialProgram);
  const [schedule, setSchedule] = useState<DailySchedule>(initialSchedule);
  const [weather, setWeather] = useState<WeatherSnapshot | null>(initialWeather);
  const [chatInput, setChatInput] = useState<string>("");
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([
    {
      id: "assistant-intro",
      role: "assistant",
      content: initialProgram.hostIntro,
    },
  ]);
  const [isChatSending, setIsChatSending] = useState<boolean>(false);
  const chatPollTimerRef = useRef<number | null>(null);
  const [history, setHistory] = useState<RadioProgram[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [volume, setVolume] = useState<number>(0.82);
  const [libraryPath, setLibraryPath] = useState<string>(
    "/Users/lipan/Music/Music/Media/Music",
  );
  const [libraryLimit, setLibraryLimit] = useState<string>("300");
  const [, startTransition] = useTransition();
  const [activeLabel, setActiveLabel] = useState<string>("ON AIR");
  const [pointerGlow, setPointerGlow] = useState({ x: 50, y: 18, active: false });
  const [loaderVariant, setLoaderVariant] = useState<"hex1" | "hex10" | "square15" | "square18" | "circular8">("circular8");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const shouldResumePlaybackRef = useRef<boolean>(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const latestDjMessage = chatHistory[chatHistory.length - 1];
  const currentBlockPeriod = schedule.currentBlockPeriod;
  const currentTrackIndex = schedule.currentTrackIndex;
  const now = new Date();
  const currentClock = `${String(now.getHours()).padStart(2, "0")} ${String(
    now.getMinutes(),
  ).padStart(2, "0")}`;
  const dayLabel = now.toLocaleDateString("en-US", { weekday: "long" });
  const dateLabel = now
    .toLocaleDateString("en-US", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    })
    .replace(/ /g, " · ")
    .toUpperCase();
  const audioSource = useMemo(() => {
    if (!program.currentTrack.sourcePath) {
      return "";
    }

    return `/api/audio?path=${encodeURIComponent(program.currentTrack.sourcePath)}`;
  }, [program.currentTrack.sourcePath]);

  // Audio source change handler
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.pause();
    audio.load();
    const shouldResume = shouldResumePlaybackRef.current;
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);

    if (!shouldResume) return;

    const tryResumePlayback = async () => {
      try {
        await audio.play();
      } catch {
        setError("自动续播失败。");
      } finally {
        shouldResumePlaybackRef.current = false;
      }
    };

    void tryResumePlayback();
  }, [audioSource]);

  /**
   * 将 UI 音量同步到实际 audio 元素。
   */
  useEffect(() => {
    if (!audioRef.current) return;
    audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    return () => {
      if (chatPollTimerRef.current) {
        window.clearTimeout(chatPollTimerRef.current);
      }
    };
  }, []);

  function formatTime(seconds: number) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.floor(seconds % 60);
    return `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function requestProgram(
    url: string,
    options?: RequestInit,
    nextLabel?: string,
    keepPlaying = false,
    rememberCurrent = true,
  ) {
    setError(null);
    if (nextLabel) setActiveLabel(nextLabel);
    shouldResumePlaybackRef.current = keepPlaying;
    const previousProgram = program;

    startTransition(async () => {
      try {
        const response = await fetch(url, options);
        const payload = (await response.json()) as RadioResponse;
        if (!response.ok || !payload.ok) {
          throw new Error("节目更新失败");
        }
        if (rememberCurrent) {
          setHistory((currentHistory) => [
            previousProgram,
            ...currentHistory,
          ].slice(0, 24));
        }
        setProgram(payload.program);
        if (payload.schedule) {
          setSchedule(payload.schedule);
        }
        setChatHistory((currentHistory) => {
          const nextIntro: ChatMessage = {
            id: `assistant-program-${Date.now()}`,
            role: "assistant",
            content: payload.program.hostIntro,
          };

          return [...currentHistory, nextIntro].slice(-12);
        });
      } catch (fetchError) {
        shouldResumePlaybackRef.current = false;
        setError(fetchError instanceof Error ? fetchError.message : "请求失败");
      }
    });
  }

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audioSource || !audio) {
      setError("请先从本地目录读取曲库。");
      return;
    }
    setError(null);

    if (audio.paused) {
      try {
        shouldResumePlaybackRef.current = false;
        await audio.play();
        setIsPlaying(true);
        setActiveLabel("ON AIR");
      } catch {
        setError("浏览器没有成功拉起音频播放。");
      }
      return;
    }

    audio.pause();
    shouldResumePlaybackRef.current = false;
    setIsPlaying(false);
    setActiveLabel("PAUSED");
  }

  /**
   * 停止播放并把进度归零。
   */
  function stopPlayback() {
    const audio = audioRef.current;
    if (!audio) return;

    audio.pause();
    audio.currentTime = 0;
    setCurrentTime(0);
    setIsPlaying(false);
    shouldResumePlaybackRef.current = false;
    setActiveLabel("STOPPED");
  }

  /**
   * 回到上一首，优先用前端历史，避免再向后端随机取一首。
   */
  function playPreviousTrack() {
    const previousProgram = history[0];

    if (!previousProgram) {
      setError("还没有上一首记录。");
      return;
    }

    setError(null);
    setActiveLabel("PREV");
    shouldResumePlaybackRef.current = isPlaying;
    setHistory((currentHistory) => currentHistory.slice(1));
    setProgram(previousProgram);
  }

  /**
   * 从头重播当前曲目。
   */
  async function replayCurrentTrack() {
    const audio = audioRef.current;
    if (!audio) return;

    audio.currentTime = 0;
    setCurrentTime(0);
    setError(null);

    if (audio.paused) {
      try {
        await audio.play();
        setIsPlaying(true);
      } catch {
        setError("重播失败。");
      }
    }
  }

  function playNextTrack() {
    requestProgram(
      "/api/next-track",
      { method: "POST", headers: { "Content-Type": "application/json" } },
      "NEXT",
      true,
    );
  }

  function sendFeedback(action: FeedbackAction) {
    requestProgram(
      "/api/feedback",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      },
      actionLabels[action],
      isPlaying,
    );
  }

  function selectQueueTrack(trackId: string) {
    requestProgram(
      "/api/select-track",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId }),
      },
      "LIVE",
      isPlaying,
    );
  }

  function importLocalLibrary() {
    requestProgram(
      "/api/import-library",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: libraryPath,
          limit: Number.parseInt(libraryLimit, 10) || undefined,
          mode: "replace",
        }),
      },
      "SYNCING",
      isPlaying,
    );
  }

  async function sendChatMessage() {
    const message = chatInput.trim();

    if (!message || isChatSending) {
      return;
    }

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: message,
    };
    const nextHistory = [...chatHistory, userMessage].slice(-12);

    // 空占位符 + 流式更新
    const placeholderId = `assistant-${Date.now()}`;
    const placeholder: ChatMessage = { id: placeholderId, role: "assistant", content: "" };

    setChatInput("");
    setIsChatSending(true);
    setError(null);
    setActiveLabel("DJ LIVE");
    setChatHistory([...nextHistory, placeholder]);

    // 音乐控制走原有 agent
    const musicKeywords = ["切歌", "换歌", "下一首", "skip", "安静", "calm", "熟悉", "familiar", "fresh", "燥", "燥一点"];
    const isMusicControl = musicKeywords.some((k) => message.toLowerCase().includes(k.toLowerCase()));
    if (isMusicControl) {
      const legacyRes = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, program, history: nextHistory }),
      });
      const legacy = (await legacyRes.json()) as ChatResponse;
      if (legacy.program) {
        setHistory((currentHistory) => [program, ...currentHistory].slice(0, 24));
        setProgram(legacy.program);
      }
      if (legacy.schedule) setSchedule(legacy.schedule);
    }

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          history: nextHistory.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || "Claudio 暂时没有接住这句话");
      }

      // SSE 流式接收，逐字更新占位符
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      let done = false;
      while (!done) {
        const { value, done: d } = await reader.read();
        done = d;
        if (!value) continue;

        const text = decoder.decode(value, { stream: !done });
        const lines = text.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "END" || data === "START") continue;
          if (!data) continue;

          let char: string;
          try {
            char = JSON.parse(data);
          } catch {
            continue;
          }

          setChatHistory((prev) =>
            prev.map((m) =>
              m.id === placeholderId ? { ...m, content: m.content + char } : m,
            ),
          );
        }
      }
    } catch (chatError) {
      setError(chatError instanceof Error ? chatError.message : "Claudio 掉线了");
      setChatHistory((prev) => prev.filter((m) => m.id !== placeholderId));
    } finally {
      setIsChatSending(false);
    }
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void sendChatMessage();
    }
  }

  function handlePanelPointerMove(event: MouseEvent<HTMLElement>) {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    setPointerGlow({ x, y, active: true });
  }

  return (
    <main className={`${styles.page} ${theme === "light" ? styles.pageLight : styles.pageDark}`}>
      <section
        ref={panelRef}
        className={`${styles.panel} ${theme === "light" ? styles.panelLight : styles.panelDark} ${
          pointerGlow.active ? styles.panelGlowActive : ""
        }`}
        style={
          {
            "--mx": `${pointerGlow.x}%`,
            "--my": `${pointerGlow.y}%`,
          } as CSSProperties
        }
        onMouseMove={handlePanelPointerMove}
        onMouseLeave={() =>
          setPointerGlow((currentGlow) => ({ ...currentGlow, active: false }))
        }
      >
        <header className={styles.topbar}>
          <div className={styles.brand}>
            <div className={styles.avatar} />
            <DotMatrixText
              text="Claudio"
              className={styles.dotWord}
              cellClassName={styles.brandDot}
            />
          </div>
          <div className={styles.topActions}>
            <button type="button" className={styles.topGhost}>
              LOGIN
            </button>
            <div className={styles.themeToggle}>
              <button
                type="button"
                className={theme === "dark" ? styles.themeActive : styles.themeIdle}
                onClick={() => setTheme("dark")}
              >
                DARK
              </button>
              <button
                type="button"
                className={theme === "light" ? styles.themeActive : styles.themeIdle}
                onClick={() => setTheme("light")}
              >
                LIGHT
              </button>
            </div>
          </div>
        </header>

        <section className={styles.clockStage}>
          <div className={styles.dotGrid} />
          <div className={styles.clockWrap}>
            {weather ? (
              <aside className={styles.weatherBadge}>
                <strong>{weather.temperatureC}°</strong>
                <span>{weather.conditionText}</span>
              </aside>
            ) : null}
            <DotMatrixText
              text={currentClock}
              className={styles.dotClock}
              cellClassName={styles.clockDot}
            />
            <div className={styles.clockMeta} onClick={() => setLoaderVariant(v => v === "hex1" ? "hex10" : v === "hex10" ? "square15" : v === "square15" ? "square18" : v === "square18" ? "circular8" : "hex1")}>
              <strong>{dayLabel}</strong>
              <span>{dateLabel}</span>
              <em className={styles.onAir}>
                <i /> {activeLabel}
              </em>
              {loaderVariant === "hex1"
                ? <DotmHex1 dotSize={5} bloom color="#54d88c" />
                : loaderVariant === "hex10"
                ? <DotmHex10 dotSize={5} bloom color="#54d88c" />
                : loaderVariant === "square15"
                ? <DotmSquare15 dotSize={5} bloom color="#54d88c" />
                : loaderVariant === "square18"
                ? <DotmSquare18 dotSize={5} bloom color="#54d88c" />
                : <DotmCircular8 dotSize={5} bloom color="#54d88c" />}
            </div>
          </div>
        </section>

        <section className={styles.controlDeck}>
          <div className={styles.nowCard}>
            <div className={styles.miniWave}>
              {waveformBars.map((height, index) => (
                <span
                  key={`${height}-${index}`}
                  className={`${styles.miniBar} ${isPlaying ? styles.miniBarActive : ""}`}
                  style={
                    {
                      "--bar-height": `${height}`,
                      "--bar-delay": `${index * 100}ms`,
                    } as CSSProperties
                  }
                />
              ))}
            </div>
            <div>
              <strong>
                {program.currentTrack.title} · {program.currentTrack.artist}
              </strong>
              <p>PLAYING</p>
            </div>
          </div>

          <div className={styles.transport}>
            <button type="button" className={styles.roundButton} onClick={playPreviousTrack}>
              ⏮
            </button>
            <button type="button" className={styles.roundButton} onClick={() => void togglePlayback()}>
              {isPlaying ? "❚❚" : "▶"}
            </button>
            <button type="button" className={styles.roundButton} onClick={playNextTrack}>
              ⏭
            </button>
            <button type="button" className={styles.roundButton} onClick={stopPlayback}>
              ■
            </button>
            <button type="button" className={styles.chipButton} onClick={() => sendFeedback("fresh")}>
              HIDE
            </button>
            <button type="button" className={styles.chipButton} onClick={() => sendFeedback("familiar")}>
              FAV
            </button>
            <div className={styles.volumeCluster}>
              <span>VOL</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={volume}
                className={styles.volumeSlider}
                onChange={(event) => setVolume(Number(event.target.value))}
              />
            </div>
          </div>

          <div className={styles.timelineSection}>
            <span>{formatTime(currentTime)}</span>
            <div className={styles.timelineTrack}>
              <span
                className={styles.timelineFill}
                style={{
                  width: duration > 0 ? `${Math.min(100, (currentTime / duration) * 100)}%` : "0%",
                }}
              />
            </div>
            <span>{duration > 0 ? formatTime(duration) : "--:--"}</span>
          </div>
        </section>

        <section className={styles.queueHeader}>
          <span>TODAY</span>
          <span>{schedule.blocks.reduce((sum, block) => sum + block.tracks.length, 0)} TRACKS</span>
        </section>

        <section className={styles.liveStrip}>
          <div className={styles.liveTitle}>
            <i />
            <span>Claudio</span>
          </div>
          <span className={styles.liveBadge}>LIVE</span>
        </section>

        <section className={styles.djPanel}>
          <p className={styles.serverLine}>Connected to Claudio server</p>
          <div className={styles.djBubble}>
            <div className={styles.djAvatar} />
            <div className={styles.djContent}>
              <p className={styles.djTag}>CLAUDIO</p>
              <p className={styles.djSpeech}>{latestDjMessage?.content ?? program.hostIntro}</p>
              <div className={styles.replayRow}>
                <span>{formatTime(currentTime)}</span>
                <button type="button" className={styles.replayButton} onClick={() => void replayCurrentTrack()}>
                  ▶ REPLAY
                </button>
              </div>
            </div>
          </div>

          <div className={styles.chatLog}>
            {chatHistory.slice(-4).map((message) => (
              <div
                key={message.id}
                className={`${styles.chatLine} ${
                  message.role === "assistant" ? styles.chatLineAssistant : styles.chatLineUser
                }`}
              >
                <span className={styles.chatRole}>
                  {message.role === "assistant" ? "DJ" : "YOU"}
                </span>
                {message.content ? (
                  <p>{message.content}</p>
                ) : (
                  <p className={styles.djTyping}>
                    <span /><span /><span />
                  </p>
                )}
              </div>
            ))}
          </div>

          <section className={styles.inputDock}>
            <input
              className={styles.djInput}
              placeholder="Say something to the DJ..."
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              onKeyDown={handleInputKeyDown}
            />
            <button type="button" className={styles.iconButton} onClick={importLocalLibrary}>
              ⌁
            </button>
            <button
              type="button"
              className={styles.sendButton}
              onClick={() => void sendChatMessage()}
              disabled={isChatSending}
            >
              ↑
            </button>
          </section>

          <p className={styles.nowPlayingText}>
            Now playing: {program.currentTrack.title} · {program.currentTrack.artist}
          </p>

          <div className={styles.queueList}>
            {program.queue.map((track) => (
              <button
                key={track.id}
                type="button"
                className={styles.queueRow}
                onClick={() => selectQueueTrack(track.id)}
              >
                <div>
                  <strong>{track.title}</strong>
                  <p>{track.artist}</p>
                </div>
                <span>{track.reason}</span>
              </button>
            ))}
          </div>

          <div className={styles.scheduleBlocks}>
            {schedule.blocks.map((block) => (
              <section key={block.period} className={styles.scheduleBlock}>
                <div className={styles.scheduleBlockHeader}>
                  <strong>{block.scene}</strong>
                  <span>{block.tracks.length} 首</span>
                </div>
                <div className={styles.scheduleTrackList}>
                  {block.tracks.slice(0, 6).map((track, index) => (
                    <div
                      key={track.id}
                      className={`${styles.scheduleTrackRow} ${
                        block.period === currentBlockPeriod && index === currentTrackIndex
                          ? styles.scheduleTrackRowActive
                          : ""
                      }`}
                    >
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <p>
                        {track.title} · {track.artist}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </section>

        <footer className={styles.footerBar}>
          <span>CLAUDIO FM</span>
          <span>CONNECTED.</span>
        </footer>

        {error ? <p className={styles.error}>{error}</p> : null}

        <details className={styles.utilityDetails}>
          <summary className={styles.utilitySummary}>展开调试与导入工具</summary>
          <div className={styles.utilityGrid}>
            <article className={styles.utilityCard}>
              <p className={styles.utilityTitle}>读取本地音乐库</p>
              <div className={styles.libraryForm}>
                <input
                  className={styles.libraryInput}
                  value={libraryPath}
                  onChange={(event) => setLibraryPath(event.target.value)}
                  placeholder="本地音乐目录"
                />
                <input
                  className={styles.libraryLimit}
                  value={libraryLimit}
                  onChange={(event) => setLibraryLimit(event.target.value)}
                  placeholder="扫描数量上限"
                />
              </div>
              <button type="button" className={styles.utilityPrimary} onClick={importLocalLibrary}>
                从本地目录读取
              </button>
            </article>
          </div>
        </details>

        <audio
          ref={audioRef}
          preload="none"
          src={audioSource}
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime || 0)}
          onEnded={() => {
            setIsPlaying(false);
            setCurrentTime(0);
            playNextTrack();
          }}
          onPause={() => setIsPlaying(false)}
          onPlay={() => setIsPlaying(true)}
        />
      </section>
    </main>
  );
}
