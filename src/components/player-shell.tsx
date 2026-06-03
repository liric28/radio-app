"use client";

import { type CSSProperties, type KeyboardEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { Doto } from "next/font/google";
import { DotmHex1 } from "@/components/ui/dotm-hex-1";
import { DotmHex10 } from "@/components/ui/dotm-hex-10";
import { DotmSquare15 } from "@/components/ui/dotm-square-15";
import { DotmSquare18 } from "@/components/ui/dotm-square-18";
import { DotmCircular8 } from "@/components/ui/dotm-circular-8";
import { ClaudioLiveShell } from "@/components/claudio-live-shell";
import {
  PointerMatrixField,
  type PointerMatrixFieldHandle,
} from "@/components/pointer-matrix-field";
import styles from "@/app/page.module.css";
import type { MusicSearchHit, MusicSearchSource } from "@/lib/music-search";
import { buildTrackLabel } from "@/lib/track-labels";
import type {
  ChatMessage,
  DailySchedule,
  RadioProgram,
  Song,
  WeatherSnapshot,
} from "@/lib/types";

const claudioPixelFont = Doto({
  subsets: ["latin"],
  weight: ["400", "600"],
});

type RadioResponse = {
  ok: boolean;
  program: RadioProgram;
  schedule?: DailySchedule;
};

type PreferenceInsights = {
  updatedAt: string;
  totalEvents: number;
  recentEvents: Array<{
    ts: string;
    type: string;
    scene: string;
    trackLabel: string;
    action: string;
    playbackRatio: number | null;
  }>;
  topArtists: string[];
  topLanguages: string[];
  topTags: string[];
  topRequestPatterns: string[];
  sceneProfiles: Array<{
    scene: string;
    topArtists: string[];
    topLanguages: string[];
    topTags: string[];
    avoidSignals: string[];
    preferredEnergy: number | null;
  }>;
  recommendationSourceStats: Array<{
    label: string;
    generated: number;
    completed: number;
    interrupted: number;
    favorite: number;
    download: number;
    completionRate: number;
  }>;
  recentIntentResolutions: Array<{
    ts: string;
    message: string;
    action: string;
    resolver: string;
    scene: string;
  }>;
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

type SearchPlaybackResponse = {
  ok: boolean;
  url?: string;
  error?: string;
};

type NeteaseViewer = {
  valid: boolean;
  userId: number | null;
  nickname: string;
  avatarUrl: string;
};

function toPreferenceTrack(track: Song, scene?: string) {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    language: track.language,
    energy: track.energy,
    tags: track.tags,
    source: track.source,
    scene,
  };
}

function toMusicSearchHit(track: Song): MusicSearchHit | null {
  const context = track.downloadContext;
  if (!context?.raw) return null;
  return {
    source: context.source,
    title: track.title,
    artist: track.artist,
    duration: context.duration,
    payable: context.payable,
    downloadable: context.downloadable,
    albumName: context.albumName,
    imageUrl: context.imageUrl,
    raw: context.raw as MusicSearchHit["raw"],
  };
}

function createThinkTagStripper() {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  let pending = "";
  let insideThink = false;

  return {
    push(chunk: string) {
      pending += chunk;
      let output = "";

      while (pending) {
        if (insideThink) {
          const closeIndex = pending.indexOf(CLOSE);
          if (closeIndex === -1) {
            pending = pending.slice(Math.max(0, pending.length - (CLOSE.length - 1)));
            return output;
          }
          pending = pending.slice(closeIndex + CLOSE.length);
          insideThink = false;
          continue;
        }

        const openIndex = pending.indexOf(OPEN);
        if (openIndex === -1) {
          const safeLength = Math.max(0, pending.length - (OPEN.length - 1));
          output += pending.slice(0, safeLength);
          pending = pending.slice(safeLength);
          return output;
        }

        output += pending.slice(0, openIndex);
        pending = pending.slice(openIndex + OPEN.length);
        insideThink = true;
      }

      return output;
    },
    flush() {
      if (insideThink) return "";
      const output = pending;
      pending = "";
      return output;
    },
  };
}

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
  E: [
    "111111",
    "100000",
    "100000",
    "111110",
    "100000",
    "100000",
    "111111",
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
  V: [
    "100001",
    "100001",
    "100001",
    "100001",
    "010010",
    "010010",
    "001100",
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

type SearchPanelInlineProps = {
  source: MusicSearchSource;
  onSourceChange: (source: MusicSearchSource) => void;
  searchFn: (
    keyword: string,
    source: MusicSearchSource,
    page: number,
  ) => Promise<MusicSearchHit[]>;
  playFn: (hit: MusicSearchHit) => Promise<void>;
  playingKey: string | null;
  downloadFn: (hit: MusicSearchHit) => Promise<void>;
};

const SEARCH_PAGE_SIZE = 20;

function formatClockTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function SearchPanelInline({
  source,
  onSourceChange,
  searchFn,
  playFn,
  playingKey,
  downloadFn,
}: SearchPanelInlineProps) {
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<MusicSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextPage, setNextPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);

  async function runSearch(
    nextKeyword: string,
    nextSource: MusicSearchSource,
    page = 1,
    append = false,
  ) {
    /**
     * 搜索主流程兼容“首屏搜索”和“滚动续页”两种模式。
     * - append=false：重置旧结果，从第 1 页开始搜
     * - append=true：把下一页结果去重后接到列表尾部
     */
    const trimmedKeyword = nextKeyword.trim();
    if (!trimmedKeyword) {
      setResults([]);
      setError(null);
      setHasMore(false);
      setNextPage(1);
      return;
    }

    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      setResults([]);
      setHasMore(false);
      setNextPage(1);
    }
    setError(null);
    setSuccessMessage(null);
    try {
      const hits = await searchFn(trimmedKeyword, nextSource, page);
      setResults((current) => {
        if (!append) return hits;
        const merged = [...current];
        const seen = new Set(current.map(createSearchHitKey));
        for (const hit of hits) {
          const key = createSearchHitKey(hit);
          if (!seen.has(key)) {
            merged.push(hit);
            seen.add(key);
          }
        }
        return merged;
      });
      setHasMore(hits.length === SEARCH_PAGE_SIZE);
      setNextPage(page + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (append) {
        setLoadingMore(false);
      } else {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setResults([]);
    setError(null);
    setSuccessMessage(null);
    setHasMore(false);
    setNextPage(1);
  }, [source]);

  useEffect(() => {
    const container = resultsRef.current;
    if (!container) return;

    // 固定 5 条高度的滚动容器，接近底部时自动请求下一页。
    const handleScroll = () => {
      if (loading || loadingMore || !hasMore) return;
      const remain = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (remain > 72) return;
      void runSearch(keyword, source, nextPage, true);
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, [hasMore, keyword, loading, loadingMore, nextPage, source]);

  async function handleSearch() {
    await runSearch(keyword, source);
  }

  async function handleSourceChange(nextSource: MusicSearchSource) {
    onSourceChange(nextSource);
    if (!keyword.trim()) return;
    await runSearch(keyword, nextSource);
  }

  async function handleDownload(hit: MusicSearchHit) {
    setDownloadingId(`${hit.source}-${hit.title}-${hit.artist}`);
    setError(null);
    setSuccessMessage(null);
    try {
      await downloadFn(hit);
      setSuccessMessage(`已下载入库：${hit.title} · ${hit.artist}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownloadingId(null);
    }
  }

  async function handlePlay(hit: MusicSearchHit) {
    // 搜索结果支持直接试听，不会改 program/schedule，只是临时接管主播放器的 audioSource。
    setError(null);
    setSuccessMessage(null);
    try {
      await playFn(hit);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className={styles.searchPanel}>
      <div className={styles.searchSourceRow}>
        {(["kugou", "qq", "netease"] as MusicSearchSource[]).map((item) => (
          <button
            key={item}
            type="button"
            className={`${styles.searchSourceChip} ${source === item ? styles.searchSourceChipActive : ""}`}
            onClick={() => void handleSourceChange(item)}
          >
            {item === "kugou" ? "酷狗" : item === "qq" ? "QQ 音乐" : "网易云"}
          </button>
        ))}
      </div>
      <div className={styles.searchControls}>
        <input
          ref={inputRef}
          className={styles.searchInput}
          placeholder="搜索歌名或歌手..."
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void handleSearch()}
        />
        <button
          type="button"
          className={styles.searchSubmit}
          onClick={() => void handleSearch()}
          disabled={loading}
        >
          {loading ? "搜索中..." : "搜索"}
        </button>
      </div>
      <p className={styles.searchHint}>搜索结果支持直接下载入库。</p>
      {successMessage && <p className={styles.searchSuccess}>{successMessage}</p>}
      {error && <p className={styles.searchError}>{error}</p>}
      <div ref={resultsRef} className={styles.searchResults}>
        {results.map((hit, index) => (
          <div
            key={`${hit.source}-${hit.title}-${hit.artist}-${index}`}
            className={styles.searchResultCard}
            onClick={() => void handlePlay(hit)}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                void handlePlay(hit);
              }
            }}
          >
            <div className={styles.searchResultText}>
              <p className={styles.searchResultTitle}>{hit.title}</p>
              <p className={styles.searchResultMeta}>
                {hit.artist || "未知歌手"} · {formatClockTime(hit.duration)}
              </p>
            </div>
            <div className={styles.searchActions}>
              <button
                type="button"
                className={styles.searchPlay}
                onClick={(event) => {
                  event.stopPropagation();
                  void handlePlay(hit);
                }}
              >
                {playingKey === createSearchHitKey(hit) ? "播放中" : "▶ 播放"}
              </button>
              {hit.downloadable ? (
                <button
                  type="button"
                  className={styles.searchDownload}
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDownload(hit);
                  }}
                  disabled={downloadingId === `${hit.source}-${hit.title}-${hit.artist}`}
                >
                  {downloadingId === `${hit.source}-${hit.title}-${hit.artist}` ? "下载中..." : "↓ 下载"}
                </button>
              ) : (
                <span className={styles.searchPaid}>暂不可下</span>
              )}
            </div>
          </div>
        ))}
        {!loading && results.length === 0 && !error && (
          <p className={styles.searchEmpty}>
            {source === "kugou" ? "输入关键词搜索当前来源歌曲" : "输入关键词搜索当前来源歌曲"}
          </p>
        )}
        {loadingMore && <p className={styles.searchLoadingMore}>继续加载中...</p>}
        {!loading && !loadingMore && results.length > 0 && !hasMore && (
          <p className={styles.searchListEnd}>没有更多结果了</p>
        )}
      </div>
    </div>
  );
}

function createSearchHitKey(hit: MusicSearchHit) {
  if (hit.source === "kugou") {
    const raw = hit.raw as { audioId?: number; hash?: string };
    return `${hit.source}-${String(raw.audioId ?? raw.hash ?? hit.title)}`;
  }
  if (hit.source === "qq") {
    const raw = hit.raw as { songmid?: string };
    return `${hit.source}-${String(raw.songmid ?? hit.title)}`;
  }
  const raw = hit.raw as { songId?: number };
  return `${hit.source}-${String(raw.songId ?? hit.title)}`;
}

function normalizeSearchText(value: string) {
  return value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()（）\[\]【】\-_.·,，/\\'"]/g, "");
}

function isSameTrackLabel(left: { title: string; artist: string }, right: { title: string; artist: string }) {
  return (
    normalizeSearchText(left.title) === normalizeSearchText(right.title) &&
    normalizeSearchText(left.artist) === normalizeSearchText(right.artist)
  );
}

function scoreCandidateHit(hit: MusicSearchHit, artist: string, title: string) {
  const normalizedArtist = normalizeSearchText(artist);
  const normalizedTitle = normalizeSearchText(title);
  const hitArtist = normalizeSearchText(hit.artist);
  const hitTitle = normalizeSearchText(hit.title);

  let score = 0;
  if (hitTitle === normalizedTitle) score += 20;
  else if (hitTitle.includes(normalizedTitle) || normalizedTitle.includes(hitTitle)) score += 8;

  if (hitArtist === normalizedArtist) score += 20;
  else if (hitArtist.includes(normalizedArtist) || normalizedArtist.includes(hitArtist)) score += 8;

  if (/live|伴奏|纯音乐|dj|remix/i.test(`${hit.title} ${hit.albumName || ""}`)) score -= 4;
  return score;
}

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

function openPopupWindow(url: string, name: string, width: number, height: number) {
  if (typeof window === "undefined") return;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
  window.open(
    url,
    name,
    `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`,
  );
}

/**
 * 按参考图组织成单列电台面板，主视图优先展示时间、控制和 DJ 对话。
 */
/**
 * Radio player shell — single-column station panel, prioritizes clock, controls and DJ info.
 */

export function PlayerShell({ initialProgram, initialSchedule, initialWeather }: PlayerShellProps) {
  const [waveformBars, setWaveformBars] = useState([0.24, 0.68, 0.36, 0.82]);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [program, setProgram] = useState<RadioProgram>(initialProgram);
  const [schedule, setSchedule] = useState<DailySchedule>(initialSchedule);
  const [weather, setWeather] = useState<WeatherSnapshot | null>(initialWeather);
  const [chatInput, setChatInput] = useState<string>("");
  /**
   * 聊天记录持久化（localStorage）。
   *
   * 背景：当前聊天模型是无状态推理 API，"对话连续性"完全靠前端每次把 history 数组
   * 一起发过去。chatHistory 原本只在 React useState 里，刷新/报错就丢光，
   * 下次发消息时 history 是空的 → 模型“失忆”。
   *
   * 为什么读 localStorage 必须放在 useEffect 里、不能在 useState 初始化里：
   *   useState 初始化函数在 SSR 时跑（window 不存在 → 返回 intro），CSR 首屏
   *   再跑一次（拿 localStorage → 返回累积历史）。两次结果不一致 → React 报
   *   hydration mismatch（SSR 渲染的 djSpeech 是 hostIntro，CSR 是上次的最后一条）。
   *   放到 useEffect 里，首屏始终用 intro 渲染（与 SSR 一致），挂载后再恢复历史。
   *
   * 时序：
   *   1. SSR：useState 初始 = [intro]；DOM 输出 intro 文案
   *   2. CSR hydrate：useState 初始 = [intro]；DOM 与 SSR 一致 → 无 mismatch
   *   3. mount 后 effect-A 跑：读 localStorage
   *        ├─ 有历史 → setChatHistory(parsed) → 触发 re-render，DOM 切到旧历史
   *        └─ 无历史 → 留着 intro
   *      effect-A 结尾把 chatHydratedRef 翻成 true
   *   4. effect-B（写入）在 mount 时也跑了一次，但 hydratedRef 是 false → 直接 return，
   *      不写 localStorage（关键：否则就会把 intro 立刻覆盖掉旧的累积历史）
   *   5. 之后任何 setChatHistory → effect-B 看到 hydratedRef=true → 正常写 localStorage
   *
   * 门闸 chatHydratedRef 用 ref 而不是 state：
   *   状态变化会触发额外 render；这里只是 effect 之间的 sentinel，没必要驱动 UI。
   */
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);

  /**
   * 挂载后读 localStorage 恢复历史。
   * hydratedRef 是个门闸：只有恢复尝试完成后，下面的写入 effect 才允许把 chatHistory
   * 写回 localStorage——否则 mount 时写入 effect 立刻跑会把 intro 写进去覆盖累积的旧历史。
   */
  const chatHydratedRef = useRef<boolean>(false);
  useEffect(() => {
    if (typeof window === "undefined") {
      chatHydratedRef.current = true;
      return;
    }
    try {
      const stored = window.localStorage.getItem("radio.chatHistory");
      if (stored) {
        const parsed = JSON.parse(stored) as ChatMessage[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          setChatHistory(parsed);
        }
      }
    } catch {
      // JSON 损坏 / 权限不足，忽略
    }
    chatHydratedRef.current = true;
  }, []);

  /**
   * chatHistory 持久化到 localStorage。
   * 写失败（隐私模式 / 满了）静默忽略——不能因此挂掉聊天。
   * 挂载首跑时 hydratedRef 还是 false，直接返回，让恢复 effect 先把旧历史读进来。
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!chatHydratedRef.current) return;
    try {
      window.localStorage.setItem("radio.chatHistory", JSON.stringify(chatHistory));
    } catch {
      // 配额超 / 隐私模式 等
    }
  }, [chatHistory]);
  const [isChatSending, setIsChatSending] = useState<boolean>(false);
  const chatPollTimerRef = useRef<number | null>(null);
  /**
   * 正在进行的聊天请求 AbortController。
   * 用户在等待回复时再次点发送 → abort 当前请求，开启新请求。
   */
  const chatAbortRef = useRef<AbortController | null>(null);
  /**
   * 发送键长按检测。长按 ≥ 1s 触发清空聊天历史。
   *
   * - timerRef：onPointerDown 启动的 setTimeout 句柄，松开/移出时 clear
   * - triggeredRef：长按成功触发的标记。
   *   onClick 在 pointerUp 后还会跑一次，需要靠这个标记跳过那次"假的发送"。
   */
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef<boolean>(false);
  const [history, setHistory] = useState<RadioProgram[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [volume, setVolume] = useState<number>(0.82);
  const [libraryPath, setLibraryPath] = useState<string>(
    process.env.NEXT_PUBLIC_DEFAULT_AUDIO_ROOT ?? "",
  );
  const [libraryLimit, setLibraryLimit] = useState<string>("300");
  const [activeLabel, setActiveLabel] = useState<string>("ON AIR");
  const [clockDisplayMode, setClockDisplayMode] = useState<"dot" | "pixel">("pixel");
  const [loaderVariant, setLoaderVariant] = useState<"hex1" | "hex10" | "square15" | "square18" | "circular8">("circular8");
  const [neteaseViewer, setNeteaseViewer] = useState<NeteaseViewer | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackRecoveryKeyRef = useRef<string | null>(null);
  /**
   * 自动播放开关。
   *
   * 链路：把它设为 true → 紧接着 setProgram(新 program) → currentTrack.sourcePath 变
   *      → audioSource useMemo 重算 → audioSource useEffect 触发
   *      → pause / load 后判断本 ref，true 才 .play()
   *
   * 谁会把它设为 true：
   *   - regenerateSchedule()：点 ⌁，新歌单第一首自动播
   *   - 聊天 SSE state 事件里 currentTrack.id 变化时：切时段/换歌自动播
   *   - 其它走 requestProgram 的按钮：next/previous/select 等按 keepPlaying 参数传
   *
   * 浏览器自动播放策略：首次未交互时 .play() 会被拒绝。
   * 上面这些路径都是用户主动点击/发消息触发的，权限会延续，没问题。
   */
  const shouldResumePlaybackRef = useRef<boolean>(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const matrixFieldRef = useRef<PointerMatrixFieldHandle | null>(null);
  /**
   * chatLog 容器 ref：发消息后只滚 chatLog 自身的 scrollTop 到底，
   * **不能用 anchor.scrollIntoView**——那样会把整个 page 也带着滚，
   * 输入框被推出视口外，用户没法继续输入。
   * 直接操作容器 scrollTop 只滚溢出区，page 不动。
   */
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  /**
   * queueOverlay（LIST 按钮弹出的内联卡片组）ref：点 LIST 后 scrollIntoView，
   * 让用户能立刻看到刚展开的歌单——否则在长聊天页里展开了也看不见。
   */
  const queueOverlayRef = useRef<HTMLDivElement | null>(null);
  const latestDjMessage = chatHistory[chatHistory.length - 1];
  // 流式中的 assistant 气泡 id：用于在内容末尾追加 loading 指示
  const streamingMessageId =
    isChatSending && latestDjMessage?.role === "assistant" ? latestDjMessage.id : null;
  /**
   * LIST 按钮 toggle：在聊天流和输入框之间插入"当前段歌单卡片"。
   * 默认折叠避免占地，点 LIST 才展开——视觉上等同于一条"系统插播的歌单消息"。
   */
  const [showQueueList, setShowQueueList] = useState<boolean>(true);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [preferenceInsights, setPreferenceInsights] = useState<PreferenceInsights | null>(null);

  useEffect(() => {
    fetch("/api/favorites")
      .then((r) => r.json())
      .then((ids) => setFavorites(ids as string[]))
      .catch(() => null);
  }, []);

  useEffect(() => {
    fetch("/api/preference-insights", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (payload?.ok && payload.data) {
          setPreferenceInsights(payload.data as PreferenceInsights);
        }
      })
      .catch(() => null);
  }, [program.currentTrack.id]);
  const [showClaudioLivePanel, setShowClaudioLivePanel] = useState<boolean>(false);
  /**
   * 顶部搜索按钮触发的"网络歌曲搜索"弹层。
   * 搜索酷狗免费曲库，下载入库后自动进入当日节目单。
   */
  const [showSearchModal, setShowSearchModal] = useState<boolean>(false);
  const [searchSource, setSearchSource] = useState<MusicSearchSource>("qq");
  const [searchPreview, setSearchPreview] = useState<{
    key: string;
    title: string;
    artist: string;
    url: string;
  } | null>(null);
  const [resolvedProgramStreamUrl, setResolvedProgramStreamUrl] = useState<string>("");
  const currentQueueTracks = useMemo(
    () => [program.currentTrack, ...program.queue],
    [program.currentTrack, program.queue],
  );

  function sendPreferenceEvent(payload: Record<string, unknown>) {
    void fetch("/api/preference-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
  }

  function renderNeteaseAvatar() {
    if (!neteaseViewer?.avatarUrl) return null;
    return (
      <span
        className={styles.avatarImage}
        style={{ backgroundImage: `url("${neteaseViewer.avatarUrl.replace(/"/g, '\\"')}")` }}
        aria-hidden="true"
      />
    );
  }

  function handleOpenNeteaseLogin() {
    openPopupWindow("/api/netease-login", "netease-login", 420, 520);
  }

  function handleToggleClaudioLive() {
    setShowClaudioLivePanel((value) => !value);
  }

  useEffect(() => {
    if (!showSearchModal) return;

    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setShowSearchModal(false);
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [showSearchModal]);

  useEffect(() => {
    let cancelled = false;

    async function refreshNeteaseViewer() {
      try {
        const response = await fetch("/api/netease-login?mode=status", {
          cache: "no-store",
        });
        const data = (await response.json()) as Partial<NeteaseViewer>;
        if (cancelled) return;
        if (response.ok && data.valid) {
          setNeteaseViewer({
            valid: true,
            userId: typeof data.userId === "number" ? data.userId : null,
            nickname: typeof data.nickname === "string" ? data.nickname : "",
            avatarUrl: typeof data.avatarUrl === "string" ? data.avatarUrl : "",
          });
          return;
        }
        setNeteaseViewer(null);
      } catch {
        if (!cancelled) setNeteaseViewer(null);
      }
    }

    void refreshNeteaseViewer();

    const handleFocus = () => {
      void refreshNeteaseViewer();
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleFocus);

    const handleMessage = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.data === "netease-login-success") {
        void refreshNeteaseViewer();
      }
    };
    window.addEventListener("message", handleMessage);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleFocus);
      window.removeEventListener("message", handleMessage);
    };
  }, []);

  /**
   * 发消息后滚到聊天最底——只滚 chatLog 容器自身 scrollTop，不滚 page，输入框保留可见。
   *
   * 必须监听整个 chatHistory（不是 .length）——
   *   发消息时 chatHistory length +1（新 user/placeholder），effect 跑滚到底 ✓
   *   流式 token 累积时 length 不变但 content 增长，scrollHeight 持续撑大；
   *   如果只监听 length，流式期间 effect 不跑 → scrollTop 卡在"消息追加那一刻"的位置
   *   → 后续 token 把内容推下去看不见，用户看着像"卡在中间"。
   *
   * 监听 chatHistory（每次 setChatHistory 都触发，包括流式 30ms batch flush）让滚动持续贴底。
   * 每次都直接 scrollTop = scrollHeight，即时不动画，不会被相邻 setState 打断。
   */
  useEffect(() => {
    const node = chatLogRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [chatHistory]);

  /**
   * LIST 切到打开时滚动到 queueOverlay，让用户看到刚展开的歌单。
   * 关闭时不滚——用户点 LIST 关掉就行。block: "center" 让卡片整体居中可视区。
   */
  useEffect(() => {
    if (!showQueueList) return;
    queueOverlayRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [showQueueList]);
  const now = new Date();
  const currentClock = `${String(now.getHours()).padStart(2, "0")} ${String(
    now.getMinutes(),
  ).padStart(2, "0")}`;
  const dayLabel = now.toLocaleDateString("en-US", { weekday: "long" });
  const dateParts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).formatToParts(now);
  const dayPart = dateParts.find((part) => part.type === "day")?.value ?? "";
  const monthPart = dateParts.find((part) => part.type === "month")?.value ?? "";
  const yearPart = dateParts.find((part) => part.type === "year")?.value ?? "";
  const dateLabel = `${dayPart} · ${monthPart} · ${yearPart}`.toUpperCase();
  const audioSource = useMemo(() => {
    if (searchPreview?.url) {
      return searchPreview.url;
    }
    if (program.currentTrack.sourcePath) {
      return `/api/audio?path=${encodeURIComponent(program.currentTrack.sourcePath || "")}&libraryRoot=${encodeURIComponent(program.currentTrack.libraryRoot || "")}`;
    }
    if (program.currentTrack.downloadContext) {
      return resolvedProgramStreamUrl;
    }
    return "";
  }, [
    program.currentTrack.downloadContext,
    program.currentTrack.libraryRoot,
    program.currentTrack.sourcePath,
    resolvedProgramStreamUrl,
    searchPreview?.url,
  ]);

  const visibleTrack = searchPreview
    ? { title: searchPreview.title, artist: searchPreview.artist }
    : program.currentTrack;

  function clearSearchPreview() {
    setSearchPreview(null);
  }

  useEffect(() => {
    if (searchPreview?.url) return;
    if (program.currentTrack.sourcePath) {
      console.info("[Audio] local-track", {
        trackId: program.currentTrack.id,
        title: program.currentTrack.title,
        artist: program.currentTrack.artist,
        sourcePath: program.currentTrack.sourcePath,
        libraryRoot: program.currentTrack.libraryRoot || "",
      });
      setResolvedProgramStreamUrl("");
      return;
    }
    const hit = toMusicSearchHit(program.currentTrack);
    if (!hit) {
      console.info("[Audio] no-online-context", {
        trackId: program.currentTrack.id,
        title: program.currentTrack.title,
        artist: program.currentTrack.artist,
      });
      setResolvedProgramStreamUrl("");
      return;
    }

    let cancelled = false;
    setResolvedProgramStreamUrl("");
    console.info("[Audio] resolving-program-stream", {
      trackId: program.currentTrack.id,
      title: hit.title,
      artist: hit.artist,
      source: hit.source,
    });

    void (async () => {
      try {
        const response = await fetch("/api/song-playback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(hit),
        });
        const payload = (await response.json()) as SearchPlaybackResponse;
        if (cancelled) return;
        if (!response.ok || !payload.ok || !payload.url) {
          console.error("[Audio] resolve-program-stream.failed", {
            trackId: program.currentTrack.id,
            title: hit.title,
            artist: hit.artist,
            source: hit.source,
            status: response.status,
            payload,
          });
          setError(payload.error ?? "当前歌曲没有可播放直链");
          return;
        }
        console.info("[Audio] resolve-program-stream.ok", {
          trackId: program.currentTrack.id,
          title: hit.title,
          artist: hit.artist,
          source: hit.source,
          url: payload.url,
        });
        setResolvedProgramStreamUrl(payload.url);
      } catch (error) {
        if (!cancelled) {
          console.error("[Audio] resolve-program-stream.error", {
            trackId: program.currentTrack.id,
            title: hit.title,
            artist: hit.artist,
            source: hit.source,
            error: error instanceof Error ? error.message : String(error),
          });
          setError("当前歌曲播放地址解析失败。");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    program.currentTrack.artist,
    program.currentTrack.downloadContext,
    program.currentTrack.id,
    program.currentTrack.sourcePath,
    program.currentTrack.title,
    searchPreview?.url,
  ]);

  useEffect(() => {
    console.info("[Audio] source-updated", {
      trackId: program.currentTrack.id,
      title: program.currentTrack.title,
      artist: program.currentTrack.artist,
      hasSearchPreview: Boolean(searchPreview?.url),
      resolvedProgramStreamUrl,
      finalAudioSource: audioSource,
    });
  }, [
    audioSource,
    program.currentTrack.artist,
    program.currentTrack.id,
    program.currentTrack.title,
    resolvedProgramStreamUrl,
    searchPreview?.url,
  ]);

  async function recoverCurrentTrackPlayback() {
    const hit = toMusicSearchHit(program.currentTrack);
    if (!hit) return false;

    const recoveryKey = `${program.currentTrack.id}:${program.currentTrack.title}:${program.currentTrack.artist}`;
    if (playbackRecoveryKeyRef.current === recoveryKey) {
      return false;
    }
    playbackRecoveryKeyRef.current = recoveryKey;

    try {
      const response = await fetch("/api/song-playback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hit),
      });
      const payload = (await response.json()) as SearchPlaybackResponse;
      if (!response.ok || !payload.ok || !payload.url) {
        return false;
      }

      shouldResumePlaybackRef.current = true;
      setProgram((currentProgram) => {
        if (currentProgram.currentTrack.id !== program.currentTrack.id) {
          return currentProgram;
        }
        return {
          ...currentProgram,
          currentTrack: {
            ...currentProgram.currentTrack,
            streamUrl: payload.url,
          },
        };
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * audioSource 切换处理（自动播放链路的"消费端"）。
   *
   * 触发：program.currentTrack.sourcePath 变化 → audioSource useMemo 变 → 本 effect 跑
   *
   * 行为：
   *   1. pause() + load() 重置 audio 元素到新源
   *   2. 清零 UI 时间显示（isPlaying / currentTime / duration）
   *   3. 看 shouldResumePlaybackRef.current —— true 才 .play()，否则停留在暂停状态
   *   4. 不管 play 成不成功，最后把 ref 重置为 false，避免下次源切换误触发
   *
   * 这是整个"自动播放"机制的唯一出口，所有 setProgram(...) 是否会续播都汇聚到这里。
   */
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.pause();
    audio.load();
    const shouldResume = shouldResumePlaybackRef.current;
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    playbackRecoveryKeyRef.current = null;

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
    if (!isPlaying) {
      setWaveformBars([0.24, 0.68, 0.36, 0.82]);
      return;
    }

    const pickHeights = () => ([
      0.18 + Math.random() * 0.2,
      0.46 + Math.random() * 0.34,
      0.22 + Math.random() * 0.24,
      0.58 + Math.random() * 0.34,
    ]);

    setWaveformBars(pickHeights());
    const timer = window.setInterval(() => {
      setWaveformBars(pickHeights());
    }, 180);

    return () => window.clearInterval(timer);
  }, [isPlaying]);

  /**
   * 组件卸载时清掉 chatPollTimerRef 上挂的 setTimeout，防止内存泄漏。
   * 注：当前代码里 chatPollTimerRef 似乎没有写入点，留作保险（旧轮询机制残留）。
   * 后续如果确认彻底不用，可以连同 ref 一起删。
   */
  useEffect(() => {
    return () => {
      if (chatPollTimerRef.current) {
        window.clearTimeout(chatPollTimerRef.current);
      }
    };
  }, []);

  /**
   * 当前 block 的推荐语润色器（懒加载，不阻塞首屏）。
   *
   * 触发时机（依赖项变化即触发）：
   *   - schedule.currentBlockPeriod 变化：切到新时段，润色新时段
   *   - program.scene 变化：场景文案变了，重新润色
   *   - program.currentTrack.id 变化：点 ⌁ 重新生成了歌单（关键），
   *     此时 schedule 里所有 reason 都是 reasonSeed 占位，必须重新润色当前段
   *
   * 调 /api/rewrite-reasons 拿一段的 DJ 风格推荐语，
   * 回来后 setSchedule / setProgram 把对应 track 的 reason 替换掉。
   * 其他三段保持 reasonSeed 占位，等用户切到那段时再触发润色。
   */
  useEffect(() => {
    if (schedule.currentBlockPeriod === "online") return;
    // 用 SSR 的 currentBlockPeriod 找当前 block（而非实时 hours）
    const activePeriod = schedule.currentBlockPeriod;
    const currentBlock = schedule.blocks.find((b) => b.period === activePeriod);
    if (!currentBlock) return;

    const blockTrackIds = new Set(currentBlock.tracks.map((t) => t.id));
    const blockTracks = [program.currentTrack, ...program.queue].filter(
      (t) => t && blockTrackIds.has(t.id),
    );
    if (!blockTracks.length) return;

    fetch("/api/rewrite-reasons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tracks: blockTracks.map((t) => ({ id: t.id, mood: t.mood, reasonSeed: t.reasonSeed ?? "" })),
        scene: program.scene,
      }),
    })
      .then((r) => r.json())
      .then((data: { reasons?: Record<string, string> }) => {
        if (!data.reasons) return;
        const reasons = data.reasons;
        // 更新当前 block 的推荐语
        setSchedule((prev) => ({
          ...prev,
          blocks: prev.blocks.map((block) =>
            block.period === activePeriod
              ? {
                  ...block,
                  tracks: block.tracks.map((t) => ({
                    ...t,
                    reason: reasons[t.id] ?? t.reason,
                  })),
                }
              : block,
          ),
        }));
        setProgram((prev) => ({
          ...prev,
          currentTrack: { ...prev.currentTrack, reason: reasons[prev.currentTrack.id] ?? prev.currentTrack.reason },
          queue: prev.queue.map((t) => ({ ...t, reason: reasons[t.id] ?? t.reason })),
        }));
      })
      .catch(() => {});
  }, [program.scene, schedule.currentBlockPeriod, program.currentTrack.id]);

  function formatTime(seconds: number) {
    return formatClockTime(seconds);
  }

  /**
   * 通用的"改变当前节目"请求器。所有按钮（除聊天）都走这里。
   *
   * 用途：next / previous / select / feedback / regenerate / import library
   * 这些动作都会让服务端产出新的 program（可能附带新 schedule），
   * 本函数统一处理"发请求 → 拿响应 → 更 state → 续播控制"。
   *
   * 参数：
   *   - url / options：fetch 标准参数（一般 POST + body）
   *   - nextLabel：右上角状态标签（"NEXT" / "REFRESHING" / "LIVE" 等）
   *   - keepPlaying：是否在新歌出来后自动续播
   *       ↳ true 时设 shouldResumePlaybackRef = true（详见 ref 定义处的注释）
   *       ↳ 失败时强制改回 false，避免错误状态下乱播
   *   - rememberCurrent：是否把当前 program 推入 history（影响 previous 能不能回退）
   *
   * 副作用顺序：
   *   1. clear error / set label / 记录 previousProgram
   *   2. 45s 超时 AbortController 兜底（防模型请求卡死）
   *   3. fetch + 解析；非 2xx 或 payload.ok=false → throw
   *   4. 入栈 history → setProgram → setSchedule(可选) → 追加 hostIntro 到 chat
   *   5. 异常：复位 resume flag + setError；finally 清 timeout
   */
  async function requestProgram(
    url: string,
    options?: RequestInit,
    nextLabel?: string,
    keepPlaying = false,
    rememberCurrent = true,
  ) {
    // 正式节目切换前先退出搜索试听态，避免 preview 远程流继续占着播放器。
    clearSearchPreview();
    sendPreferenceEvent({
      type: "playback_interrupted",
      action: nextLabel || url,
      scene: program.scene,
      track: toPreferenceTrack(program.currentTrack, program.scene),
      playbackSeconds: currentTime,
      playbackRatio: duration > 0 ? currentTime / duration : 0,
    });
    setError(null);
    if (nextLabel) setActiveLabel(nextLabel);
    shouldResumePlaybackRef.current = keepPlaying;
    const previousProgram = program;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45_000);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
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
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ===== 统一播放器动作层 =====
  // 聊天 SSE control 帧 + 后续要加的"上一首/下一首/收藏/下载"按钮全部走这一层。
  // 现在这一层只暴露 pause / resume / replay / 音量 4 组给聊天；
  // 现有按钮 onClick 暂不重构，等后续扩展时一并把 onClick 改成 playerActionsRef.current.xxx()。
  // togglePlayback 内部改为调 pause / resume，确保按钮行为和聊天行为走完全同一份代码。
  async function pauseAudio() {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    shouldResumePlaybackRef.current = false;
    setIsPlaying(false);
    setActiveLabel("PAUSED");
  }
  async function resumeAudio() {
    const audio = audioRef.current;
    if (!audioSource || !audio) {
      setError("当前歌曲还在解析播放地址，请稍后再试。");
      return;
    }
    setError(null);
    try {
      shouldResumePlaybackRef.current = false;
      await audio.play();
      setIsPlaying(true);
      setActiveLabel("ON AIR");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`播放失败：${msg}`);
    }
  }
  function replayAudio() {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    if (audio.paused) void audio.play().catch(() => null);
  }
  function volumeUp() {
    setVolume((v) => Math.min(1, v + 0.1));
  }
  function volumeDown() {
    setVolume((v) => Math.max(0, v - 0.1));
  }
  function setVolumeTo(value01: number) {
    setVolume(Math.max(0, Math.min(1, value01)));
  }
  const playerActionsRef = useRef({
    pause: pauseAudio,
    resume: resumeAudio,
    replay: replayAudio,
    volumeUp,
    volumeDown,
    setVolumeTo,
  });
  playerActionsRef.current = {
    pause: pauseAudio,
    resume: resumeAudio,
    replay: replayAudio,
    volumeUp,
    volumeDown,
    setVolumeTo,
  };

  /**
   * 统一执行页内 agent：先判断意图，再调用对应工具，最后把回复上下文交给文案层。
   */
  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audioSource || !audio) {
      setError("当前歌曲还在解析播放地址，请稍后再试。");
      return;
    }
    if (audio.paused) {
      await resumeAudio();
    } else {
      pauseAudio();
    }
  }

  /**
   * 停止播放并把进度归零。
   */
  function stopPlayback() {
    const audio = audioRef.current;
    if (!audio) return;

    audio.pause();
    audio.currentTime = 0;
    clearSearchPreview();
    setCurrentTime(0);
    setIsPlaying(false);
    shouldResumePlaybackRef.current = false;
    setActiveLabel("STOPPED");
  }

  /**
   * 回到上一首。
   *
   * 设计取舍：纯前端 history 栈，不打后端。
   *   - history 由 requestProgram 在每次切歌前 unshift 进 program 快照（上限 24）
   *   - 这里取 history[0] 直接 setProgram 还原；同时把 history 头部弹掉
   *   - keepPlaying = isPlaying：原来在播就续播，原来暂停就保持暂停
   *
   * 不走 requestProgram → 不会再触发后端推荐算法，避免"上一首"变成"另一首随机"。
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
    clearSearchPreview();
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
    sendPreferenceEvent({
      type: "replay",
      action: "replay-current",
      scene: program.scene,
      track: toPreferenceTrack(program.currentTrack, program.scene),
    });

    if (audio.paused) {
      try {
        await audio.play();
        setIsPlaying(true);
      } catch {
        setError("重播失败。");
      }
    }
  }

  /**
   * 下一首：让后端按今天的 schedule + 反馈记忆推下一首。
   * keepPlaying=true：next 按钮天然意味着"继续听"，所以恒续播。
   */
  function playNextTrack() {
    requestProgram(
      "/api/next-track",
      { method: "POST", headers: { "Content-Type": "application/json" } },
      "NEXT",
      true,
    );
  }

  /**
   * 反馈按钮（SKIP / FRESH / CALMER / FAMILIAR）。
   *
   * 后端 /api/feedback 做两件事：
   *   1. 更新 memory.feedbackBias（影响后续打分排序）
   *   2. 直接产出下一首 program 返回
   *
   * keepPlaying=isPlaying：在播就续播，暂停就保持暂停（尊重当前状态）。
   */
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

  function toggleFavorite() {
    const track = program.currentTrack;
    if (!track?.id) return;
    const trackLabel = buildTrackLabel(track.title, track.artist);
    const isFav = favorites.includes(trackLabel);
    const action = isFav ? "remove" : "add";
    setFavorites((prev) =>
      action === "add" ? [...prev, trackLabel] : prev.filter((id) => id !== trackLabel)
    );
    void fetch("/api/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: track.title, artist: track.artist, action }),
    }).catch(() => null);
    if (action === "add") {
      sendPreferenceEvent({
        type: "favorite",
        action: "favorite-button",
        scene: program.scene,
        track: toPreferenceTrack(track, program.scene),
      });
    }
  }

  /**
   * 点 queue 列表里某一首 → 跳到那首播。
   *
   * 后端 /api/select-track 会把 schedule.currentTrackIndex 移到目标 track，
   * 然后 buildRadioProgram 重建 program。keepPlaying=isPlaying。
   */
  /**
   * @param forcePlay true 时无视当前 isPlaying，切完直接开播；false 时沿用旧语义（暂停就保持暂停）。
   *                  LIST 弹出列表里点曲目希望"点了就放"，传 true；其他保留旧行为传默认 false。
   */
  function selectQueueTrack(trackId: string, forcePlay: boolean = false) {
    requestProgram(
      "/api/select-track",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId }),
      },
      "LIVE",
      forcePlay || isPlaying,
    );
  }

  /**
   * 输入框旁边 ⌁ 按钮：重新生成今天的四段歌单。
   *
   * 全链路：
   *   1. POST /api/regenerate-schedule（详见该 route 注释）
   *   2. requestProgram 收到 { program, schedule } → setProgram + setSchedule
   *   3. UI 立刻刷新（TRACKS 数字、四段列表、Now Playing、queue）
   *   4. program.currentTrack.id 变了 → 上面那个 useEffect 自动触发，
   *      后台异步润色当前段的推荐语（不阻塞）
   *
   * 注意：keepPlaying=true，新歌单出来后无论之前是否在播，
   *      当前段第一首都会自动开播（按用户要求"自动播放"）。
   */
  function regenerateSchedule() {
    requestProgram(
      "/api/regenerate-schedule",
      {
        method: "POST",
      },
      "REFRESHING",
      true,
    );
  }

  /**
   * 底部"读取本地曲库"按钮：从用户填的目录路径全量导入 mp3，替换 songs.json。
   *
   * mode:"replace" → 后端清掉旧曲库再写新的（带 limit 参数限制条数防卡爆）。
   * 完成后会自动重新生成 schedule，requestProgram 拿到新的 program。
   * 谨慎：会覆盖手动调过的歌单。
   */
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

  /**
   * 顶部"⌕"按钮：搜索多来源曲库并下载入库。
   *
   * page/limit 由前端显式控制：
   *   - 首搜传 page=1
   *   - 搜索列表滚动触底时继续传 page=2/3/4...
   */
  async function searchSongsFromSource(
    keyword: string,
    source: MusicSearchSource,
    page: number,
  ) {
    const response = await fetch(
      `/api/song-search?keyword=${encodeURIComponent(keyword)}&source=${encodeURIComponent(source)}&page=${page}&limit=${SEARCH_PAGE_SIZE}`,
    );
    const payload = (await response.json()) as { success: boolean; data?: unknown[]; error?: string };
    if (!payload.success) throw new Error(payload.error ?? "搜索失败");
    return payload.data as MusicSearchHit[];
  }

  async function playSearchSong(hit: MusicSearchHit) {
    /**
     * 搜索试听链路：
     * 1. POST /api/song-playback 解析来源对应的真实可播直链
     * 2. 把返回 url 填进 searchPreview
     * 3. audioSource useMemo 优先使用 searchPreview.url
     * 4. shouldResumePlaybackRef=true，沿用现有自动播放 effect 开播
     *
     * 试听不是 setProgram，不会污染今天的 schedule。
     * 用户点上一首/下一首/反馈/重生成时，requestProgram 会先 clearSearchPreview 退出试听态。
     */
    const response = await fetch("/api/song-playback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(hit),
    });
    const payload = (await response.json()) as { ok: boolean; url?: string; error?: string };
    if (!response.ok || !payload.ok || !payload.url) {
      throw new Error(payload.error ?? "播放失败");
    }

    shouldResumePlaybackRef.current = true;
    setSearchPreview({
      key: createSearchHitKey(hit),
      title: hit.title,
      artist: hit.artist,
      url: payload.url,
    });
    setActiveLabel("PREVIEW");
  }

  async function playPendingCandidate(candidate: { artist: string; title: string }) {
    setError(null);

    const queries = [`${candidate.artist} ${candidate.title}`, candidate.title];
    let bestHit: MusicSearchHit | null = null;

    for (const query of queries) {
      const hits = await searchSongsFromSource(query, "qq", 1);
      const ranked = hits
        .map((hit) => ({ hit, score: scoreCandidateHit(hit, candidate.artist, candidate.title) }))
        .sort((a, b) => b.score - a.score);
      if (ranked[0] && ranked[0].score > 0) {
        bestHit = ranked[0].hit;
        break;
      }
    }

    if (!bestHit) {
      throw new Error(`QQ 没搜到 ${candidate.artist}《${candidate.title}》`);
    }

    await playSearchSong(bestHit);
  }

  async function downloadSong(hit: MusicSearchHit) {
    /**
     * 下载成功后走“正式入库”链路：
     *   搜索结果 -> /api/song-download -> songs.json / schedule / program 一起刷新。
     * 跟试听的区别是：下载会真正改电台当前节目，试听只临时抢占 audioSource。
     */
    setError(null);
    setActiveLabel("SYNCING");
    const previousProgram = program;
    shouldResumePlaybackRef.current = isPlaying;

    const response = await fetch("/api/song-download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(hit),
    });

    const payload = (await response.json()) as RadioResponse & {
      error?: string;
      code?: string;
    };
    if (!response.ok || !payload.ok) {
      shouldResumePlaybackRef.current = false;
      throw new Error(payload.error ?? `下载失败 (${payload.code ?? "unknown"})`);
    }

    setHistory((currentHistory) => [previousProgram, ...currentHistory].slice(0, 24));
    setProgram(payload.program);
    if (payload.schedule) {
      setSchedule(payload.schedule);
    }
    setChatHistory((currentHistory) => {
      const nextIntro: ChatMessage = {
        id: `assistant-download-${Date.now()}`,
        role: "assistant",
        content: payload.program.hostIntro,
      };

      return [...currentHistory, nextIntro].slice(-12);
    });
  }

  /**
   * 聊天发送 / 流式接收主流程。
   *
   * 全链路：
   *   1. 取输入框文本，空则忽略
   *   2. 中止上一条还在进行中的请求（chatAbortRef.abort()）
   *      → 旧请求会在 catch 里捕获 AbortError，悄悄清掉占位符
   *   3. 在 chatHistory 尾部追加 user 消息 + 空 assistant 占位符
   *   4. POST /api/agent（SSE 流），signal 绑定本次 controller
   *   5. 服务端先吐一条 type:"state" 事件（program / schedule / weather 变更）
   *      → 如果 currentTrack.id 变了，设 shouldResumePlaybackRef = true（自动续播新轨）
   *   6. 然后开始吐模型的 token（choices[0].delta.content）
   *      → 每个 token 累加到 pendingContent，30ms 内合并 setChatHistory 一次
   *      → 关键优化：避免每个字符都触发整个 PlayerShell 重渲染
   *   7. 流结束（[DONE] 或 reader.done）→ flushPending 收尾，避免最后一段 token 被吞
   *   8. 一条 token 都没收到 → 写个默认兜底文案
   *
   * 取消 / 重发：
   *   - 用户在 isChatSending 时再点发送 → 顶部 abort + 重新进入本函数
   *   - 旧请求 fetch reject AbortError → catch 分支识别后只清占位符，不报错
   *
   * 视觉反馈：
   *   - streamingMessageId（组件顶部计算）= 最新 assistant 消息 id（仅 isChatSending 时）
   *   - 该气泡末尾会渲染 DotmHex10 mini loader 表示"还在流式中"
   *   - 发送按钮在 isChatSending 时也变成同款 loader
   */
  /**
   * 防同步重入锁——只防一次事件循环里被触发两次（双 fire / Enter+click 同时来）。
   * 不能用 isChatSending state（异步、且会 batch 滞后），必须 ref。
   * setTimeout 0 在同步事件处理结束的下一 microtask 释放，所以后续异步"中止重发"
   * （用户在等回复时再点发送）仍能正常工作。
   */
  const sendLockRef = useRef<boolean>(false);

  async function sendChatMessage(overrideMessage?: string) {
    if (sendLockRef.current) return;
    sendLockRef.current = true;
    setTimeout(() => {
      sendLockRef.current = false;
    }, 0);

    const message = (overrideMessage ?? chatInput).trim();
    if (!message) return;

    // 如果有正在进行的请求 → 中止它，让新消息立刻发出去
    // 旧请求的 try/catch 会捕获 AbortError，不影响新流程
    chatAbortRef.current?.abort();
    const controller = new AbortController();
    chatAbortRef.current = controller;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: message,
    };
    const nextHistory = [...chatHistory, userMessage].slice(-12);

    // 空占位符 + 流式更新
    const placeholderId = `assistant-${Date.now()}`;
    const placeholder: ChatMessage = { id: placeholderId, role: "assistant", content: "" };

    if (!overrideMessage) {
      setChatInput("");
    }
    setIsChatSending(true);
    setError(null);
    setActiveLabel("DJ LIVE");
    setChatHistory([...nextHistory, placeholder]);

    // 流式 token 批量提交：N 毫秒内的所有 token 合并成一次 setState
    // 避免每个字符触发整个 PlayerShell 重渲染
    //
    // 调优参考（常见流式模型 30-60 tokens/s ≈ 间隔 15-30ms）：
    //   - 10ms：几乎一个 token 一次 setState，批量优化基本无效，但视觉最丝滑
    //   - 30-50ms：平均合并 1-3 个 token，渲染次数减半到 1/3，体感仍实时（推荐区间）
    //   - 100ms+：明显"一段段"，但最省 CPU
    // 当前值偏视觉流畅，若有性能问题可调大。
    let pendingContent = "";
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const thinkStripper = createThinkTagStripper();
    const flushPending = () => {
      if (!pendingContent) return;
      const buf = pendingContent;
      pendingContent = "";
      setChatHistory((prev) =>
        prev.map((m) =>
          m.id === placeholderId ? { ...m, content: m.content + buf } : m,
        ),
      );
    };
    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushPending();
      }, 30);
    };

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          program,
          history: nextHistory,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || "Claudio 暂时没有接住这句话");
      }

      // SSE 流式接收，逐字更新占位符
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      let done = false;
      let sseBuffer = "";
      let receivedContent = false;

      while (!done) {
        const { value, done: streamDone } = await reader.read();
        done = streamDone;
        if (!value) continue;

        sseBuffer += decoder.decode(value, { stream: !done });
        const events = sseBuffer.split("\n\n");
        sseBuffer = events.pop() ?? "";

        for (const event of events) {
          const lines = event.split("\n");

          for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
            if (!data) continue;
            if (data === "[DONE]") {
              done = true;
              break;
            }

          try {
            const chunk = JSON.parse(data);
            if (chunk.type === "state") {
              if (chunk.program) {
                setHistory((currentHistory) => [program, ...currentHistory].slice(0, 24));
                // 聊天触发的歌曲/时段切换：自动续播新轨
                // 仅在 currentTrack.id 变化时才设 resume，避免 weather 等无关回复也强制开播
                if (chunk.program.currentTrack?.id !== program.currentTrack.id) {
                  shouldResumePlaybackRef.current = true;
                }
                setProgram(chunk.program);
              }
              if (chunk.schedule) setSchedule(chunk.schedule);
              if (Array.isArray(chunk.favorites)) setFavorites(chunk.favorites as string[]);
              if ("weather" in chunk) setWeather(chunk.weather);
              continue;
            }
            // 新增：directReply 整段（点播候选提问/真点播等不走 LLM 的场景）
            // 一次性把 content 和 meta 都写进 placeholder。
            // 原 LLM 流式 token 透传路径不带 type:"assistant"，继续走下面 choices 解析。
            if (chunk.type === "assistant" && chunk.meta) {
              setChatHistory((prev) =>
                prev.map((m) =>
                  m.id === placeholderId
                    ? {
                        ...m,
                        meta: {
                          ...(m.meta ?? {}),
                          pendingCandidates: chunk.meta?.pendingCandidates ?? m.meta?.pendingCandidates,
                        },
                      }
                    : m,
                ),
              );
            }
            // 新增：聊天触发的控件指令（暂停 / 继续 / 音量 / 重播）。
            // 走 playerActionsRef 统一动作层，跟按钮 onClick 完全同一份实现。
            if (chunk.type === "control" && chunk.action) {
              const actions = playerActionsRef.current;
              switch (chunk.action) {
                case "pause":
                  void actions.pause();
                  break;
                case "resume":
                  void actions.resume();
                  break;
                case "replay":
                  actions.replay();
                  break;
                case "volume-up":
                  actions.volumeUp();
                  break;
                case "volume-down":
                  actions.volumeDown();
                  break;
                case "set-volume":
                  if (typeof chunk.value === "number") {
                    actions.setVolumeTo(chunk.value / 100);
                  }
                  break;
              }
              continue;
            }
            let content = chunk.choices?.[0]?.delta?.content;
            // 某些模型可能把 content 包装成对象，尝试提取 text 字段
            if (typeof content === "object" && content !== null) {
              content = (content as { text?: string }).text ?? String(content);
            }
            if (typeof content === "string" && content) {
              const cleaned = thinkStripper.push(content);
              if (cleaned) {
                receivedContent = true;
                pendingContent += cleaned;
                scheduleFlush();
              }
            }
          } catch {
            // ignore parse errors
          }
        }

          if (done) {
            break;
          }
        }
      }

      // 流结束后立即清掉残留 pending，避免最后一段 token 被吞
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pendingContent += thinkStripper.flush();
      flushPending();

      if (!receivedContent) {
        setChatHistory((prev) =>
          prev.map((m) =>
            m.id === placeholderId ? { ...m, content: "嗯，我切过去了。" } : m,
          ),
        );
      }
    } catch (chatError) {
      // 用户主动 abort（点了第二次发送）不算错误，悄悄丢掉占位符就行
      if (chatError instanceof DOMException && chatError.name === "AbortError") {
        if (flushTimer) clearTimeout(flushTimer);
        setChatHistory((prev) => prev.filter((m) => m.id !== placeholderId));
        return;
      }
      setError(chatError instanceof Error ? chatError.message : "Claudio 掉线了");
      setChatHistory((prev) => prev.filter((m) => m.id !== placeholderId));
    } finally {
      // 只有当前 controller 就是 ref 里的那个才清掉（防止覆盖到后来的新请求）
      if (chatAbortRef.current === controller) {
        chatAbortRef.current = null;
      }
      setIsChatSending(false);
    }
  }

  /**
   * 清空聊天历史 = 给当前模型开新会话。
   *
   * 为什么这俩等价：
   *   模型本身无状态，所谓"会话"完全靠客户端每次把 history 数组发过去。
   *   清掉 chatHistory → 下次 sendChatMessage 拼 nextHistory 时只剩开场白 + 新消息，
   *   模型看到的 context 就是新的，前文统统不存在 = 等于新会话。
   *
   * 副作用顺序：
   *   1. abort 当前进行中的请求（chatAbortRef）→ 防旧响应回来污染新历史
   *   2. setChatHistory([])：清空历史，UI 会回退到默认 hostIntro 空态气泡
   *   3. useEffect 跟着把 localStorage["radio.chatHistory"] 也覆盖成空数组
   *   4. 状态标签闪 "CLEARED" 给用户视觉反馈
   *
   * 触发入口：发送键长按 ≥ 1s（见下面 handleSendPointerDown / End / Click）
   *
   * 改成"全清"（连开场白也删）的话：把 setChatHistory([intro]) → setChatHistory([])
   */
  function clearChatHistory() {
    chatAbortRef.current?.abort();
    setChatHistory([]);
    setActiveLabel("CLEARED");
  }

  /**
   * 发送键长按检测，3 个 handler 协作。
   *
   * 时序：
   *   按下 → handleSendPointerDown 启动 1s setTimeout
   *     ├─ 1s 内松手 → handleSendPointerEnd 清 timer → click 走正常发送
   *     └─ 1s 到 → timer 回调：triggeredRef=true + clearChatHistory()
   *               → 用户松手 → click 触发 → handleSendClick 看到 triggeredRef
   *               → 重置 ref + return（吞掉这次"假发送"）
   *
   * 为啥需要 triggeredRef：浏览器对长按依然会触发 pointerup → click 事件序列，
   * 不能让长按清空之后还顺手发出去一条消息，所以用标记吞掉这次 click。
   *
   * 鼠标移出/取消 pointerLeave / pointerCancel 也走 handleSendPointerEnd，
   * 避免按住后拖出按钮范围还误触发清空。
   */
  function handleSendPointerDown() {
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      clearChatHistory();
    }, 1000);
  }

  /**
   * 松开/移出/取消：清掉计时器；未达 1s 即视为普通点击。
   */
  function handleSendPointerEnd() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  /**
   * 发送键 click：长按成功的话跳过本次发送，仅清状态标记。
   */
  function handleSendClick() {
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false;
      return;
    }
    void sendChatMessage();
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void sendChatMessage();
    }
  }

  /**
   * 鼠标在面板内移动时，把指针坐标喂给背景点阵层。
   * 点阵层自己做补间和回弹，不走 React state。
   * 手机上 skip 避免持续 requestAnimationFrame 发烫。
   */
  function handlePanelPointerMove(event: MouseEvent<HTMLElement>) {
    if (navigator.maxTouchPoints > 0) return;

    const node = panelRef.current;
    if (!node) return;

    const target = event.target as HTMLElement | null;
    const inDjPanel = target?.closest(`.${styles.djPanel}`) !== null;
    if (inDjPanel) {
      matrixFieldRef.current?.clearPointer();
      return;
    }

    const rect = node.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    matrixFieldRef.current?.setPointer(x, y);
  }

  /**
   * 全局点击光圈：鼠标点哪儿 → 该点 spawn 一个临时 div，CSS 动画扩散 + 淡出
   * 600ms 后自动 remove。直接操 DOM 不走 React state，避免每次点击重渲染。
   *
   * 排除掉 textarea / input 内的点击，避免在文本输入时干扰光标定位。
   */
  function handlePanelClick(event: MouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement | null;
    if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;

    const node = panelRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const ripple = document.createElement("span");
    ripple.className = styles.clickRipple;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    node.appendChild(ripple);

    setTimeout(() => ripple.remove(), 700);
  }

  return (
    <main className={`${styles.page} ${theme === "light" ? styles.pageLight : styles.pageDark}`}>
      <section
        ref={panelRef}
        className={`${styles.panel} ${theme === "light" ? styles.panelLight : styles.panelDark}`}
        onMouseMove={handlePanelPointerMove}
        onMouseLeave={() => matrixFieldRef.current?.clearPointer()}
        onClick={handlePanelClick}
      >
        <PointerMatrixField
          ref={matrixFieldRef}
          className={`${styles.panelMatrix} ${theme === "light" ? styles.panelMatrixLight : styles.panelMatrixDark}`}
          theme={theme}
        />
        <div className={styles.panelContent}>
          {/*
           * 网易云已登录时，用头像图片替换默认渐变头像。
           * 没拿到 avatarUrl 时保持原样，避免登录接口异常把 UI 变空。
           */}
          <header className={styles.topbar}>
          <div className={styles.brand}>
            <div className={styles.avatar}>
              {renderNeteaseAvatar()}
            </div>
            <span className={`${styles.brandTitle} ${claudioPixelFont.className}`}>
              Claudio
            </span>
          </div>
          <div className={styles.topActions}>
            <button
              type="button"
              className={styles.topGhost}
              onClick={() => {
                if (neteaseViewer?.valid) {
                  fetch("/api/netease-login?mode=logout", { cache: "no-store" })
                    .then(() => {
                      setNeteaseViewer(null);
                      if (window.opener) window.opener.location.reload();
                    });
                } else {
                  openPopupWindow("/api/netease-login", "netease-login", 420, 520);
                }
              }}
            >
              {neteaseViewer?.valid ? "LOGOUT" : "LOGIN"}
            </button>
            <div className={styles.themeToggle}>
              <button
                type="button"
                className={theme === "dark" ? styles.themeActive : styles.themeIdle}
                onClick={() => {
                  setTheme("dark");
                  localStorage.setItem("radio.theme", "dark");
                  const evt = new CustomEvent("claudio-theme-change", { detail: "dark" });
                  console.log("[home] dispatching dark event");
                  window.dispatchEvent(evt);
                  // 广播给同一 origin 的其他页面（包括 /claudio-live）
                  try { new BroadcastChannel("claudio-theme").postMessage("dark"); } catch {}
                }}
                aria-label="Dark mode"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" style={{transform:'scale(1.2)',display:'block'}}>
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                </svg>
              </button>
              <button
                type="button"
                className={theme === "light" ? styles.themeActive : styles.themeIdle}
                onClick={() => {
                  setTheme("light");
                  localStorage.setItem("radio.theme", "light");
                  const evt = new CustomEvent("claudio-theme-change", { detail: "light" });
                  console.log("[home] dispatching light event");
                  window.dispatchEvent(evt);
                  try { new BroadcastChannel("claudio-theme").postMessage("light"); } catch {}
                }}
                aria-label="Light mode"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{transform:'scale(1.2)',display:'block'}}>
                  <circle cx="12" cy="12" r="5"/>
                  <line x1="12" y1="1" x2="12" y2="3"/>
                  <line x1="12" y1="21" x2="12" y2="23"/>
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                  <line x1="1" y1="12" x2="3" y2="12"/>
                  <line x1="21" y1="12" x2="23" y2="12"/>
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                </svg>
              </button>
            </div>
            <button
              type="button"
              className={styles.searchBtn}
              onClick={() => setShowSearchModal(true)}
              title="搜索歌曲"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{transform:'scale(1.2)',display:'block'}}>
                <circle cx="11" cy="11" r="8"/>
                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
            </button>
          </div>
        </header>

        <section className={styles.clockStage}>
          <div className={styles.clockWrap}>
            <div className={styles.clockDisplayButton}>
              {clockDisplayMode === "pixel"
                ? (
                    <div className={`${styles.pixelClock} ${claudioPixelFont.className}`} aria-hidden="true" suppressHydrationWarning>
                      {currentClock}
                    </div>
                  )
                : (
                    <DotMatrixText
                      text={currentClock}
                      className={styles.dotClock}
                      cellClassName={styles.clockDot}
                    />
                  )}
            </div>
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
                      "--bar-delay": `${index * 60}ms`,
                    } as CSSProperties
                  }
                />
              ))}
            </div>
            <div className={styles.trackMeta}>
              <span className={styles.trackTitle}>{visibleTrack.title}</span>
              <span className={styles.trackArtist}>{visibleTrack.artist}</span>
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
            <button type="button" className={styles.roundIconBtn} onClick={() => setShowQueueList((value) => !value)} aria-expanded={showQueueList} aria-label="切换当前段歌单显示">
              LIST
            </button>
            <button
              type="button"
              className={`${styles.roundIconBtn} ${favorites.includes(buildTrackLabel(program.currentTrack?.title ?? "", program.currentTrack?.artist ?? "")) ? styles.favActive : ""}`}
              onClick={toggleFavorite}
              aria-label="收藏当前歌曲"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill={favorites.includes(buildTrackLabel(program.currentTrack?.title ?? "", program.currentTrack?.artist ?? "")) ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
              </svg>
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

        <button
          type="button"
          className={styles.queueHeader}
          onClick={() => setShowQueueList((value) => !value)}
          aria-expanded={showQueueList}
          aria-controls="queue-list-overlay"
        >
          <span>QUEUE</span>
          {weather && (
            <div className={styles.weatherInHeader}>
              <span>{weather.conditionText}</span>
              <span className={styles.weatherTemp}>{weather.temperatureC}°</span>
            </div>
          )}
          <span>{currentQueueTracks.length} TRACKS</span>
        </button>

        {showQueueList && (
          <div
            id="queue-list-overlay"
            className={styles.queueListOverlay}
            ref={queueOverlayRef}
            role="list"
            aria-label="当前推荐队列"
          >
            {currentQueueTracks.map((track, index) => {
              const isActive = index === 0;
              return (
                <button
                  key={track.id}
                  type="button"
                  role="listitem"
                  className={`${styles.queueListRow} ${isActive ? styles.queueListRowActive : ""}`}
                  onClick={() => selectQueueTrack(track.id, true)}
                >
                  <span className={styles.queueListRowIndex}>
                    {isActive ? "▶" : index + 1}
                  </span>
                  <span className={styles.queueListRowTitle}>{track.title}</span>
                  <span className={styles.queueListRowArtist}>{track.artist}</span>
                </button>
              );
            })}
          </div>
        )}

        <section className={styles.liveStrip}>
          <div className={styles.liveTitle}>
            <i />
            <span className={`${styles.liveStripTitleText} ${claudioPixelFont.className}`}>
              Claudio
            </span>
          </div>
          <button
            type="button"
            className={styles.liveBadgeButton}
            onClick={handleToggleClaudioLive}
            aria-expanded={showClaudioLivePanel}
            aria-controls="claudio-live-panel"
          >
            <span className={`${styles.liveBadgeText} ${claudioPixelFont.className}`}>
              LIVE
            </span>
          </button>
        </section>

        <section
          id="claudio-live-panel"
          className={`${styles.claudioLiveInline} ${showClaudioLivePanel ? styles.claudioLiveInlineOpen : ""}`}
          aria-hidden={!showClaudioLivePanel}
        >
          {showClaudioLivePanel ? <ClaudioLiveShell theme={theme} /> : null}
        </section>

        <section className={styles.djPanel}>
          <div className={styles.chatLog} ref={chatLogRef}>
            {chatHistory.length === 0 && (
              <div className={`${styles.chatLine} ${styles.chatLineAssistant}`}>
                <div className={styles.avatar}>
                  <img
                    src="/claudio.jpg"
                    alt="Claudio"
                    style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
                  />
                </div>
                <p className={styles.chatBubbleWithLabel}>
                  <span className={styles.chatBubbleLabel}>CLAUDIO</span>
                  {program.hostIntro}
                </p>
              </div>
            )}
            {chatHistory.map((message) => (
              <div key={message.id}>
              <div
                className={`${styles.chatLine} ${
                  message.role === "assistant" ? styles.chatLineAssistant : styles.chatLineUser
                }`}
              >
                {message.role === "assistant" ? (
                  <>
                    <div className={styles.avatar}>
                      <img
                        src="/claudio.jpg"
                        alt="Claudio"
                        style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
                      />
                    </div>
                    <div className={styles.chatBubbleWithLabel}>
                      <span className={styles.chatBubbleLabel}>CLAUDIO</span>
                      {message.content || <DotmHex10 dotSize={5} color="#54d88c" size={36} speed={1.2} />}
                      {message.id === streamingMessageId && message.content && (
                        <span className={styles.streamingCursor} aria-label="streaming">
                          <DotmHex10 dotSize={3} color="#54d88c" size={20} speed={1.2} />
                        </span>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <div className={styles.userAvatar}>
                      {renderNeteaseAvatar()}
                    </div>
                    <div className={`${styles.chatBubbleWithLabel} ${styles.chatBubbleLiric}`}>
                      <span className={styles.chatBubbleLabelLiric}>LIRIC</span>
                      {message.content || <DotmHex10 dotSize={5} color="#54d88c" size={36} speed={1.2} />}
                    </div>
                  </>
                )}
              </div>
              {message.role === "assistant" &&
              message.meta?.pendingCandidates &&
              message.meta.pendingCandidates.length > 0 ? (
                <div className={`${styles.chatLine} ${styles.chatLineAssistant}`}>
                  <div className={styles.chatGhostAvatar} aria-hidden="true" />
                  <div className={styles.chatCandidateMessage}>
                    <div className={styles.queueOverlay} role="list" aria-label="点播候选">
                      {message.meta.pendingCandidates.map((cand, candIndex) => {
                        const isPlaying = isSameTrackLabel(cand, visibleTrack);
                        return (
                          <button
                            key={`${cand.artist}-${cand.title}-${candIndex}`}
                            type="button"
                            role="listitem"
                            className={`${styles.queueCard} ${isPlaying ? styles.queueCardActive : ""}`}
                            onClick={() => {
                              void playPendingCandidate(cand).catch((error) => {
                                setError(error instanceof Error ? error.message : "QQ 播放失败");
                              });
                            }}
                          >
                            <span className={styles.queueCardIcon} aria-hidden>
                              {isPlaying ? "★" : "▶"}
                            </span>
                            <div className={styles.queueCardText}>
                              <strong className={styles.queueCardTitle}>{cand.title}</strong>
                              <span className={styles.queueCardArtist}>{cand.artist}</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : null}
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
            <button type="button" className={styles.iconButton} onClick={regenerateSchedule} title="换一批在线推荐">
              ⌁
            </button>
            <button
              type="button"
              className={styles.sendButton}
              onClick={handleSendClick}
              onPointerDown={handleSendPointerDown}
              onPointerUp={handleSendPointerEnd}
              onPointerLeave={handleSendPointerEnd}
              onPointerCancel={handleSendPointerEnd}
              aria-label={isChatSending ? "中止当前并重新发送" : "发送（长按 1 秒清空对话）"}
              title={isChatSending ? "正在接收模型回复，点击中止并发新消息" : "点发送 / 长按 1 秒清空对话"}
            >
              {isChatSending ? (
                <DotmHex10 dotSize={3} color="currentColor" size={16} speed={1.4} />
              ) : (
                "↑"
              )}
            </button>
          </section>
        </section>

        <footer className={styles.footerBar}>
          <span>CLAUDIO FM</span>
          <span>CONNECTED</span>
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
            <article className={styles.utilityCard}>
              <p className={styles.utilityTitle}>学习面板</p>
              <div className={styles.learningMeta}>
                <span>事件数 {preferenceInsights?.totalEvents ?? 0}</span>
                <span>{preferenceInsights?.updatedAt ? new Date(preferenceInsights.updatedAt).toLocaleString() : "尚未生成"}</span>
              </div>
              <div className={styles.learningBlock}>
                <strong>Top Artists</strong>
                <p>{preferenceInsights?.topArtists.join(" · ") || "-"}</p>
              </div>
              <div className={styles.learningBlock}>
                <strong>Top Languages / Tags</strong>
                <p>{preferenceInsights?.topLanguages.join(" · ") || "-"}</p>
                <p>{preferenceInsights?.topTags.join(" · ") || "-"}</p>
              </div>
              <div className={styles.learningBlock}>
                <strong>Request Patterns</strong>
                <p>{preferenceInsights?.topRequestPatterns.join(" · ") || "-"}</p>
              </div>
              <div className={styles.learningBlock}>
                <strong>Recommendation Source Stats</strong>
                <div className={styles.learningEventList}>
                  {(preferenceInsights?.recommendationSourceStats || []).map((item) => (
                    <div key={item.label} className={styles.learningEventRow}>
                      <span>{item.label}</span>
                      <span>入队 {item.generated}</span>
                      <span>完成率 {Math.round(item.completionRate * 100)}%</span>
                      <span>完播 {item.completed} / 中断 {item.interrupted} / 收藏 {item.favorite} / 下载 {item.download}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className={styles.learningBlock}>
                <strong>Intent Resolution Log</strong>
                <div className={styles.learningEventList}>
                  {(preferenceInsights?.recentIntentResolutions || []).map((item) => (
                    <div key={`${item.ts}-${item.message}`} className={styles.learningEventRow}>
                      <span>{item.resolver}</span>
                      <span>{item.action}</span>
                      <span>{item.scene}</span>
                      <span>{item.message}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className={styles.learningSceneList}>
                {(preferenceInsights?.sceneProfiles || []).map((profile) => (
                  <div key={profile.scene} className={styles.learningSceneCard}>
                    <strong>{profile.scene}</strong>
                    <p>偏好艺人: {profile.topArtists.join(" · ") || "-"}</p>
                    <p>偏好语言: {profile.topLanguages.join(" · ") || "-"}</p>
                    <p>偏好标签: {profile.topTags.join(" · ") || "-"}</p>
                    <p>避让信号: {profile.avoidSignals.join(" · ") || "-"}</p>
                    <p>目标能量: {typeof profile.preferredEnergy === "number" ? profile.preferredEnergy.toFixed(1) : "-"}</p>
                  </div>
                ))}
              </div>
              <div className={styles.learningBlock}>
                <strong>Recent Events</strong>
                <div className={styles.learningEventList}>
                  {(preferenceInsights?.recentEvents || []).map((event) => (
                    <div key={`${event.ts}-${event.type}-${event.trackLabel}`} className={styles.learningEventRow}>
                      <span>{event.type}</span>
                      <span>{event.scene}</span>
                      <span>{event.trackLabel}</span>
                      <span>{event.playbackRatio == null ? event.action : `${event.action} / ${Math.round(event.playbackRatio * 100)}%`}</span>
                    </div>
                  ))}
                </div>
              </div>
            </article>
          </div>
        </details>

        <audio
          ref={audioRef}
          preload="auto"
          src={audioSource || undefined}
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
          onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime || 0)}
          onEnded={() => {
            sendPreferenceEvent({
              type: "playback_completed",
              action: "track-ended",
              scene: program.scene,
              track: toPreferenceTrack(program.currentTrack, program.scene),
              playbackSeconds: duration || currentTime,
              playbackRatio: 1,
            });
            setIsPlaying(false);
            setCurrentTime(0);
            if (searchPreview) {
              clearSearchPreview();
              setActiveLabel("ON AIR");
              return;
            }
            playNextTrack();
          }}
          onPause={() => setIsPlaying(false)}
          onPlay={() => setIsPlaying(true)}
          onError={() => {
            void (async () => {
              console.error("[Audio] element.error", {
                trackId: program.currentTrack.id,
                title: program.currentTrack.title,
                artist: program.currentTrack.artist,
                audioSource,
                currentSrc: audioRef.current?.currentSrc || "",
                errorCode: audioRef.current?.error?.code || null,
                errorMessage: audioRef.current?.error?.message || "",
              });
              if (searchPreview) {
                setError("试听源播放失败。");
                clearSearchPreview();
                return;
              }

              const recovered = await recoverCurrentTrackPlayback();
              if (recovered) {
                setError(null);
                return;
              }

              setError("播放失败：当前源不可播，已跳到下一首。");
              playNextTrack();
            })();
          }}
        />
        </div>
      </section>

      {showSearchModal && (
        <div
          className={styles.searchBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label="搜索歌曲"
        >
          <div
            className={styles.searchModal}
          >
            <header className={styles.searchHeader}>
              <strong>SEARCH</strong>
              <button
                type="button"
                className={styles.searchClose}
                onClick={() => setShowSearchModal(false)}
                aria-label="关闭"
              >
                ✕
              </button>
            </header>
            <div className={styles.searchBody}>
              <SearchPanelInline
                source={searchSource}
                onSourceChange={setSearchSource}
                searchFn={searchSongsFromSource}
                playFn={playSearchSong}
                playingKey={searchPreview?.key ?? null}
                downloadFn={downloadSong}
              />
            </div>
          </div>
        </div>
      )}

    </main>
  );
}
