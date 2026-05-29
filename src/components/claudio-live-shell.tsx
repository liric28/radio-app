"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Doto } from "next/font/google";
import type { ClaudioProgramEvent, ClaudioSegment, ClaudioTrack } from "@/lib/claudio/types";
import styles from "@/app/claudio-live/page.module.css";

const claudioPixelFont = Doto({
  subsets: ["latin"],
  weight: ["400", "600"],
});

type SnapshotEvent = {
  type: "snapshot";
  programId: string | null;
  sessionTitle: string;
  tracks: ClaudioTrack[];
  segments: ClaudioSegment[];
  history: ClaudioProgramEvent[];
};

type LiveEvent = ClaudioProgramEvent | SnapshotEvent;

type TranscriptToken = {
  text: string;
  word: boolean;
};

type TranscriptTurn = {
  id: string;
  speaker: string;
  text: string;
  timeLabel: string;
  tokens: TranscriptToken[];
};

function transcriptTokens(text: string) {
  return [...String(text || "").matchAll(/(\s+)|([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])|([^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+)/gu)]
    .map((match) => ({ text: match[0], word: !match[1] }));
}

export function ClaudioLiveShell() {
  const SEGUE_BUFFER_SECONDS = 1.8;
  const MIN_SEGUE_LEAD_SECONDS = 4;
  const MAX_SEGUE_LEAD_SECONDS = 18;
  const DUCKED_VOLUME_RATIO = 0.16;
  const scrubberBarCount = 60;
  const scrubberHeights = Array.from({ length: scrubberBarCount }, (_, index) => {
    const ratio = index / scrubberBarCount;
    return 4 + 18 * Math.abs(Math.sin(index * 0.41) * Math.cos(index * 0.17 + ratio));
  });
  const [programId, setProgramId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState("Claudio FM");
  const [tracks, setTracks] = useState<ClaudioTrack[]>([]);
  const [segments, setSegments] = useState<ClaudioSegment[]>([]);
  const [currentTrackIndex, setCurrentTrackIndex] = useState(0);
  const [status, setStatus] = useState("Idle");
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [activeMediaTime, setActiveMediaTime] = useState(0);
  const [activeMediaDuration, setActiveMediaDuration] = useState(0);
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [currentWordIndex, setCurrentWordIndex] = useState(-1);
  const [activeWordCount, setActiveWordCount] = useState(0);
  const [starting, setStarting] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const musicAudioRef = useRef<HTMLAudioElement | null>(null);
  const playbackTokenRef = useRef(0);
  const lastPlaybackKeyRef = useRef("");
  const programClockStartedAtRef = useRef<number | null>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const autoStartRequestedRef = useRef(false);
  const refillRequestedForTrackRef = useRef(-1);
  const outroTalkStartedForTrackRef = useRef(-1);
  const pendingSegueNextTrackRef = useRef<number | null>(null);
  const skipLeadSegmentsForTrackRef = useRef<number | null>(null);
  const volumeFadeFrameRef = useRef<number | null>(null);

  function fmt(seconds: number) {
    if (!Number.isFinite(seconds)) return "0:00";
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${String(secs).padStart(2, "0")}`;
  }

  function resetProgramClock() {
    programClockStartedAtRef.current = Date.now();
  }

  function programTimeLabel() {
    if (!programClockStartedAtRef.current) {
      resetProgramClock();
    }
    return fmt(Math.max(0, ((Date.now() - (programClockStartedAtRef.current || Date.now())) / 1000)));
  }

  function appendTurn(speaker: string, text: string, timeLabel = "now") {
    const tokens = transcriptTokens(text);
    const wordCount = tokens.filter((token) => token.word).length;
    const nextTurn: TranscriptTurn = {
      id: `${speaker.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      speaker,
      text,
      timeLabel,
      tokens,
    };
    setTurns((current) => [...current, nextTurn].slice(-80));
    setActiveTurnId(nextTurn.id);
    setCurrentWordIndex(wordCount > 0 ? 0 : -1);
    setActiveWordCount(wordCount);
  }

  function appendSystemLine(text: string) {
    appendTurn("System", text, "now");
  }

  function finishKaraoke() {
    setCurrentWordIndex(activeWordCount > 0 ? activeWordCount : -1);
  }

  function advanceKaraoke(currentTime: number, duration: number) {
    if (activeWordCount <= 0 || duration <= 0) return;
    const ratio = Math.max(0, Math.min(1, currentTime / duration));
    const nextIndex = Math.min(Math.floor(ratio * activeWordCount), Math.max(activeWordCount - 1, 0));
    setCurrentWordIndex(nextIndex);
  }

  function syncAudioPlayingState() {
    const ttsPlaying = !!ttsAudioRef.current?.src && !ttsAudioRef.current.paused && !ttsAudioRef.current.ended;
    const musicPlaying = !!musicAudioRef.current?.src && !musicAudioRef.current.paused && !musicAudioRef.current.ended;
    setIsAudioPlaying(ttsPlaying || musicPlaying);
  }

  function syncActiveMediaProgress(source: "tts" | "music", time: number, total: number) {
    const ttsPlaying = !!ttsAudioRef.current?.src && !ttsAudioRef.current.paused && !ttsAudioRef.current.ended;
    const musicPlaying = !!musicAudioRef.current?.src && !musicAudioRef.current.paused && !musicAudioRef.current.ended;
    if (source === "tts" || !ttsPlaying || musicPlaying) {
      setActiveMediaTime(time || 0);
      setActiveMediaDuration(total || 0);
    }
  }

  function duckedMusicVolume() {
    return DUCKED_VOLUME_RATIO;
  }

  function fadeMusicVolume(target: number, durationMs = 260) {
    const music = musicAudioRef.current;
    if (!music) return;
    if (volumeFadeFrameRef.current !== null) {
      window.cancelAnimationFrame(volumeFadeFrameRef.current);
      volumeFadeFrameRef.current = null;
    }
    const startVolume = music.volume;
    const startedAt = performance.now();

    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / durationMs);
      music.volume = startVolume + (target - startVolume) * progress;
      if (progress < 1) {
        volumeFadeFrameRef.current = window.requestAnimationFrame(tick);
      } else {
        volumeFadeFrameRef.current = null;
      }
    };

    volumeFadeFrameRef.current = window.requestAnimationFrame(tick);
  }

  function duckMusic() {
    const music = musicAudioRef.current;
    if (!music?.src || music.paused) return;
    fadeMusicVolume(duckedMusicVolume());
  }

  function restoreMusicVolume() {
    const music = musicAudioRef.current;
    if (!music) return;
    fadeMusicVolume(1);
  }

  function estimateSegmentSpeechSeconds(items: ClaudioSegment[]) {
    const text = items.map((item) => item.text || "").join(" ").trim();
    if (!text) return MIN_SEGUE_LEAD_SECONDS;
    const cjkChars = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
    const latinWords = text
      .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
    const estimated = cjkChars * 0.24 + latinWords * 0.34 + 0.8;
    return Math.max(MIN_SEGUE_LEAD_SECONDS, Math.min(MAX_SEGUE_LEAD_SECONDS, estimated + SEGUE_BUFFER_SECONDS));
  }

  const consumeEvent = useEffectEvent((payload: LiveEvent) => {
    if (payload.type === "snapshot") {
      setProgramId(payload.programId);
      setSessionTitle(payload.sessionTitle || "Claudio FM");
      setTracks(payload.tracks || []);
      setSegments(payload.segments || []);
      return;
    }

    if (payload.type === "program-start") {
      setProgramId(payload.programId);
      setSessionTitle(payload.sessionTitle || "Claudio FM");
      setTracks(payload.tracks);
      setSegments(payload.segments);
      setCurrentTrackIndex(0);
      setStatus("On Air");
      setStarting(false);
      resetProgramClock();
      setTurns([]);
      setActiveTurnId(null);
      setCurrentWordIndex(-1);
      setActiveWordCount(0);
      refillRequestedForTrackRef.current = -1;
      return;
    }

    if (payload.type === "tracks-ready") {
      setTracks((current) => [...current, ...payload.tracks]);
      appendSystemLine(`Refill ready: +${payload.tracks.length} tracks`);
      return;
    }

    if (payload.type === "segment-ready") {
      setSegments((current) => [...current, ...payload.segments]);
      return;
    }

    if (payload.type === "now-playing") {
      setSessionTitle(payload.sessionTitle || "Claudio FM");
      setTracks(payload.tracks);
      setSegments(payload.segments);
      setStatus(payload.status === "speaking" ? "Speaking" : "Queued");
      return;
    }

    if (payload.type === "control") {
      if (payload.action === "next") {
        void advanceToNextTrack();
      } else if (payload.action === "pause") {
        ttsAudioRef.current?.pause();
        musicAudioRef.current?.pause();
      } else if (payload.action === "resume") {
        if (ttsAudioRef.current?.src && ttsAudioRef.current.paused) {
          void ttsAudioRef.current.play().catch(() => null);
        } else if (musicAudioRef.current?.src && musicAudioRef.current.paused) {
          void musicAudioRef.current.play().catch(() => null);
        }
      }
      setStatus(payload.action.toUpperCase());
      return;
    }

    if (payload.type === "job-status") {
      if (payload.jobType === "program_start" && payload.status !== "queued" && payload.status !== "running") {
        setStarting(false);
      }
      if (payload.status === "failed") {
        appendSystemLine(`${payload.jobType} failed: ${payload.error || "unknown error"}`);
      }
    }
  });

  useEffect(() => {
    const source = new EventSource("/api/claudio/stream");

    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as LiveEvent;
      consumeEvent(payload);
    };

    source.addEventListener("ready", () => {
      setStatus((value) => (value === "Idle" ? "Connected" : value));
    });

    source.onerror = () => {
      setStatus("Disconnected");
    };

    return () => {
      if (volumeFadeFrameRef.current !== null) {
        window.cancelAnimationFrame(volumeFadeFrameRef.current);
      }
      playbackTokenRef.current += 1;
      ttsAudioRef.current?.pause();
      musicAudioRef.current?.pause();
      source.close();
    };
  }, []);

  useEffect(() => {
    if (autoStartRequestedRef.current) return;
    if (programId || tracks.length || starting) return;
    autoStartRequestedRef.current = true;
    void startStation();
  }, [programId, tracks.length, starting]);

  useEffect(() => {
    const node = logRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [turns, currentWordIndex]);

  useEffect(() => {
    const canvasRefValue = waveCanvasRef.current;
    if (!canvasRefValue) return;

    const contextRefValue = canvasRefValue.getContext("2d");
    if (!contextRefValue) return;

    const canvasNode = canvasRefValue;
    const context = contextRefValue;

    let rafId = 0;
    let time = 0;
    const barCount = 56;
    const barGap = 4;
    const bars = Array.from({ length: barCount }, (_, index) => ({
      height: 0,
      target: 0,
      noiseSeed: Math.random() * 100 + index * 0.4,
    }));

    function resizeCanvas() {
      const rect = canvasNode.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvasNode.width = Math.max(1, Math.round(rect.width * dpr));
      canvasNode.height = Math.max(1, Math.round(rect.height * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function pseudoNoise(x: number, t: number) {
      return (
        Math.sin(x * 0.3 + t) +
        Math.sin(x * 0.7 - t * 1.3) +
        Math.sin(x * 1.1 + t * 0.7) +
        Math.sin(x * 0.17 + t * 2.1)
      ) / 4;
    }

    function draw() {
      const width = canvasNode.clientWidth;
      const height = canvasNode.clientHeight;
      const isAnimated = status === "Speaking" || status === "Playing" || status === "On Air";
      context.clearRect(0, 0, width, height);

      const barWidth = (width - barGap * (barCount - 1)) / barCount;
      bars.forEach((bar, index) => {
        const noise = pseudoNoise(bar.noiseSeed, time + index * 0.015);
        const normalized = (noise + 1) / 2;
        if (isAnimated) {
          const base = 0.08 + 0.12 * Math.abs(Math.sin(index * 0.19));
          bar.target = (base + normalized * 0.72) * height;
        } else {
          bar.target = (0.03 + normalized * 0.08) * height;
        }
        bar.height += (bar.target - bar.height) * 0.14;

        const x = index * (barWidth + barGap);
        const barHeight = Math.max(2, bar.height);
        const y = height - barHeight;
        const alpha = isAnimated ? 0.48 + normalized * 0.34 : 0.16 + normalized * 0.08;

        context.fillStyle = `rgba(67,255,198,${alpha.toFixed(3)})`;
        context.beginPath();
        context.roundRect(x, y, Math.max(2, barWidth), barHeight, 3);
        context.fill();
      });

      time += isAnimated ? 0.022 : 0.01;
      rafId = window.requestAnimationFrame(draw);
    }

    resizeCanvas();
    draw();
    window.addEventListener("resize", resizeCanvas);
    return () => {
      window.removeEventListener("resize", resizeCanvas);
      window.cancelAnimationFrame(rafId);
    };
  }, [status]);

  async function waitForAudioEnd(audio: HTMLAudioElement, token: number) {
    await new Promise<void>((resolve) => {
      const handleDone = () => {
        audio.removeEventListener("ended", handleDone);
        audio.removeEventListener("error", handleDone);
        audio.removeEventListener("pause", handlePauseAfterCancel);
        resolve();
      };
      const handlePauseAfterCancel = () => {
        if (playbackTokenRef.current !== token) handleDone();
      };
      audio.addEventListener("ended", handleDone, { once: true });
      audio.addEventListener("error", handleDone, { once: true });
      audio.addEventListener("pause", handlePauseAfterCancel);
    });
    if (playbackTokenRef.current !== token) return;
  }

  async function playSegmentSequence(items: ClaudioSegment[], token: number) {
    const audio = ttsAudioRef.current;
    if (!audio) return false;
    for (const item of items) {
      if (playbackTokenRef.current !== token) return false;
      if (!item.ttsUrl) {
        if (item.text && item.status === "tts_failed") {
          appendSystemLine(`TTS failed: ${item.error || item.id}`);
          setStatus("TTS Failed");
          return false;
        }
        continue;
      }
      if (item.text) {
        appendTurn("Claudio", item.text, programTimeLabel());
      }
      audio.src = item.ttsUrl;
      setStatus("Speaking");
      const started = await audio.play().then(() => true).catch(() => {
        setStatus("Tap Play");
        return false;
      });
      if (!started) return false;
      await waitForAudioEnd(audio, token);
    }
    return true;
  }

  function resolveSegmentsForIndex(index: number) {
    if (index === 0) {
      return segments.filter((segment) => segment.position === "before_track" && segment.trackIndex === 0);
    }
    return segments.filter(
      (segment) =>
        segment.position === "between_tracks" &&
        segment.afterTrackIndex === index - 1 &&
        segment.beforeTrackIndex === index,
    );
  }

  const playTrackFlow = useEffectEvent(async (index: number) => {
    const track = tracks[index];
    const music = musicAudioRef.current;
    if (!track || !music) return;

    const token = Date.now();
    playbackTokenRef.current = token;
    ttsAudioRef.current?.pause();
    music.pause();

    const leadSegments = skipLeadSegmentsForTrackRef.current === index ? [] : resolveSegmentsForIndex(index);
    if (skipLeadSegmentsForTrackRef.current === index) {
      skipLeadSegmentsForTrackRef.current = null;
    }
    if (leadSegments.length) {
      const ok = await playSegmentSequence(leadSegments, token);
      if (!ok) return;
    }
    if (playbackTokenRef.current !== token) return;

    if (!track.streamUrl) {
      setStatus("Missing Audio");
      return;
    }

    music.src = track.streamUrl;
    music.volume = 1;
    setStatus("Playing");
    await music.play().catch(() => {
      setStatus("Playback Failed");
    });
  });

  const startOutroSegue = useEffectEvent(async (nextIndex: number) => {
    const music = musicAudioRef.current;
    if (!music || nextIndex >= tracks.length) return;
    const leadSegments = resolveSegmentsForIndex(nextIndex).filter((segment) => segment.ttsUrl && segment.status === "ready");
    if (!leadSegments.length) return;
    if (!ttsAudioRef.current?.paused && !ttsAudioRef.current?.ended) return;

    const token = Date.now();
    playbackTokenRef.current = token;
    outroTalkStartedForTrackRef.current = currentTrackIndex;
    pendingSegueNextTrackRef.current = nextIndex;
    duckMusic();

    const ok = await playSegmentSequence(leadSegments, token);
    if (!ok || pendingSegueNextTrackRef.current !== nextIndex) {
      restoreMusicVolume();
      return;
    }

    music.pause();
    music.currentTime = 0;
    pendingSegueNextTrackRef.current = null;
    skipLeadSegmentsForTrackRef.current = nextIndex;
    setCurrentTrackIndex(nextIndex);
  });

  useEffect(() => {
    if (!programId || !tracks.length) return;
    const leadSegments = resolveSegmentsForIndex(currentTrackIndex);
    if (currentTrackIndex === 0 && !leadSegments.length) return;
    const leadSegmentKey = leadSegments.map((segment) => `${segment.id}:${segment.ttsUrl || segment.status}`).join("|");
    const playbackKey = `${programId}:${currentTrackIndex}:${leadSegmentKey}`;
    if (lastPlaybackKeyRef.current === playbackKey) return;
    lastPlaybackKeyRef.current = playbackKey;
    void playTrackFlow(currentTrackIndex);
  }, [programId, currentTrackIndex, tracks, segments]);

  useEffect(() => {
    if (!programId || !tracks.length) return;
    const remaining = tracks.length - currentTrackIndex - 1;
    if (remaining > 1) return;
    if (refillRequestedForTrackRef.current === currentTrackIndex) return;
    refillRequestedForTrackRef.current = currentTrackIndex;
    void fetch("/api/claudio/refill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: 3, djLanguage: process.env.NEXT_PUBLIC_DEFAULT_DJ_LANGUAGE ?? "zh" }),
    }).catch(() => null);
  }, [programId, tracks.length, currentTrackIndex]);

  async function advanceToNextTrack() {
    pendingSegueNextTrackRef.current = null;
    outroTalkStartedForTrackRef.current = -1;
    restoreMusicVolume();
    const atLastTrack = currentTrackIndex + 1 >= tracks.length;
    if (atLastTrack) {
      // 当前段的 queue 已经播完，立即开新台承接，避免卡在空白状态
      void startStation();
    }
    setCurrentTrackIndex((current) => {
      if (current + 1 >= tracks.length) return current;
      return current + 1;
    });
  }

  async function startStation() {
    setStarting(true);
    setStatus("Starting");
    try {
      const response = await fetch("/api/claudio/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "Open the station.", source: "live-page", djLanguage: process.env.NEXT_PUBLIC_DEFAULT_DJ_LANGUAGE ?? "zh" }),
      });
      if (!response.ok) {
        throw new Error(await response.text().catch(() => response.statusText));
      }
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean };
      if (!data.ok) {
        throw new Error("Claudio start was not accepted");
      }
    } catch (error) {
      autoStartRequestedRef.current = false;
      setStarting(false);
      setStatus("Start Failed");
      appendSystemLine(`program_start failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function togglePlayback() {
    const ttsAudio = ttsAudioRef.current;
    const musicAudio = musicAudioRef.current;
    if (ttsAudio?.src && !ttsAudio.paused && !ttsAudio.ended) {
      ttsAudio.pause();
      return;
    }
    if (ttsAudio?.src && ttsAudio.paused && !ttsAudio.ended) {
      await ttsAudio.play().catch(() => null);
      return;
    }
    if (!musicAudio?.src) {
      await startStation();
      return;
    }
    if (musicAudio.paused) {
      await musicAudio.play().catch(() => null);
      return;
    }
    musicAudio.pause();
  }

  return (
    <main className={styles.page}>
      <section className={styles.shell}>
        <audio
          ref={ttsAudioRef}
          preload="auto"
          onPlay={() => {
            setStatus("Speaking");
            duckMusic();
            syncAudioPlayingState();
          }}
          onPause={() => {
            if (pendingSegueNextTrackRef.current === null) {
              restoreMusicVolume();
            }
            syncAudioPlayingState();
          }}
          onTimeUpdate={(event) => {
            const nextTime = event.currentTarget.currentTime || 0;
            const nextDuration = event.currentTarget.duration || 0;
            advanceKaraoke(nextTime, nextDuration);
            syncActiveMediaProgress("tts", nextTime, nextDuration);
          }}
          onEnded={() => {
            finishKaraoke();
            if (musicAudioRef.current?.src) {
              setStatus("Playing");
            }
            if (pendingSegueNextTrackRef.current === null) {
              restoreMusicVolume();
            }
            setActiveMediaTime(0);
            setActiveMediaDuration(0);
            syncAudioPlayingState();
          }}
        />
        <audio
          ref={musicAudioRef}
          preload="auto"
          onPlay={() => {
            setStatus("Playing");
            restoreMusicVolume();
            syncAudioPlayingState();
          }}
          onPause={() => {
            syncAudioPlayingState();
          }}
          onLoadedMetadata={(event) => {
            setDuration(event.currentTarget.duration || 0);
          }}
          onTimeUpdate={(event) => {
            const nextTime = event.currentTarget.currentTime || 0;
            const nextDuration = event.currentTarget.duration || 0;
            setCurrentTime(nextTime);
            setDuration(nextDuration);
            syncActiveMediaProgress("music", nextTime, nextDuration);
            const remaining = nextDuration - nextTime;
            const nextIndex = currentTrackIndex + 1;
            const nextLeadSegments = nextIndex < tracks.length ? resolveSegmentsForIndex(nextIndex) : [];
            const segueLeadSeconds = estimateSegmentSpeechSeconds(nextLeadSegments);
            if (
              nextDuration > 0 &&
              remaining <= segueLeadSeconds &&
              nextIndex < tracks.length &&
              outroTalkStartedForTrackRef.current !== currentTrackIndex &&
              pendingSegueNextTrackRef.current === null
            ) {
              void startOutroSegue(nextIndex);
            }
          }}
          onEnded={() => {
            setCurrentTime(0);
            setActiveMediaTime(0);
            setActiveMediaDuration(0);
            syncAudioPlayingState();
            if (pendingSegueNextTrackRef.current === null) {
              void advanceToNextTrack();
            }
          }}
        />
        <header className={styles.header}>
          <div className={styles.brand}>
            <div className={styles.avatar} />
            <div>
              <h1 className={`${styles.brandTitle} ${claudioPixelFont.className}`}>Claudio</h1>
              <p className={styles.brandMeta}>
                <span className={styles.liveDot} />
                {status}
              </p>
            </div>
          </div>
          <div className={styles.waveWrap} aria-hidden="true">
            <canvas ref={waveCanvasRef} className={styles.waveCanvas} />
          </div>
        </header>

        <section className={styles.columns}>
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <span>Transcript</span>
              <span>{turns.length} turns</span>
              <span>{tracks.length} tracks</span>
            </div>
            <div ref={logRef} className={styles.transcript}>
              {turns.length ? turns.map((turn) => {
                let wordCounter = -1;
                const isActive = turn.id === activeTurnId;
                return (
                  <div key={turn.id} className={`${styles.turn} ${isActive ? styles.turnActive : ""}`}>
                    <div className={styles.turnHead}>
                      <span className={styles.turnWho}>{turn.speaker}</span>
                      <span> · {turn.timeLabel}</span>
                    </div>
                    <div className={styles.turnBody}>
                      {turn.tokens.map((token, index) => {
                        if (!token.word) {
                          return <span key={`${turn.id}-space-${index}`}>{token.text}</span>;
                        }
                        wordCounter += 1;
                        let className = isActive ? styles.wordFuture : styles.wordSaid;
                        if (isActive) {
                          if (currentWordIndex >= activeWordCount && activeWordCount > 0) {
                            className = styles.wordSaid;
                          } else if (wordCounter < currentWordIndex) {
                            className = styles.wordSaid;
                          } else if (wordCounter === currentWordIndex) {
                            className = styles.wordCurrent;
                          }
                        }
                        return (
                          <span key={`${turn.id}-word-${index}`} className={`${styles.word} ${className}`}>
                            {token.text}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              }) : <p className={styles.transcriptEmpty}>Waiting for signal...</p>}
            </div>
          </div>
        </section>

        <section className={styles.player}>
          <div className={styles.playerTime}>{fmt(activeMediaTime)}</div>
          <button
            type="button"
            className={styles.playerBars}
            aria-label="Seek current track"
            onClick={(event) => {
              const audio = musicAudioRef.current;
              if (!audio?.duration) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
              audio.currentTime = ratio * audio.duration;
              setCurrentTime(audio.currentTime);
            }}
          >
            {scrubberHeights.map((height, index) => {
              const progressRatio = activeMediaDuration > 0 ? activeMediaTime / activeMediaDuration : 0;
              const playedCount = activeMediaDuration > 0 ? Math.floor(progressRatio * scrubberBarCount) : 0;
              const played = index < playedCount;
              return (
                <span
                  key={`scrubber-${index}`}
                  className={`${styles.playerBar} ${played ? styles.playerBarPlayed : ""}`}
                  style={{ height: `${height}px` }}
                />
              );
            })}
          </button>
          <button
            type="button"
            className={styles.playButton}
            aria-label="Play or pause"
            onClick={() => {
              void togglePlayback();
            }}
          >
            {isAudioPlaying ? (
              <span className={styles.pauseGlyph} aria-hidden="true">
                <i />
                <i />
              </span>
            ) : (
              <span className={styles.playGlyph} aria-hidden="true" />
            )}
          </button>
        </section>
      </section>
    </main>
  );
}
