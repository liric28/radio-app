/**
 * 显式点播执行器（纯增量，不动原 radio-engine/online-radio 链路）。
 *
 * 入口：executePlayRequest(intent, currentProgram) —— chat-agent 在新点播旁路里调。
 *
 * 两种结果互斥：
 *   - needsCandidateList=true → 候选提问，program 不变，candidateList 是 top 3。
 *     用户下一轮从候选里选。
 *   - needsCandidateList=false → 真点播，nextProgram 替换 currentTrack，其它字段保留。
 *
 * 注意：本模块不调 applyChatIntentWithProgram / applyOnlineChatIntent，
 * 不写 preference_event，不动 daily-schedule / online-radio / radio-engine。
 * 真点播的 program 构造只更新 currentTrack（追加原 currentTrack 到 queue 头，去重），
 * 其它字段从 currentProgram 原样透传。
 */
import { searchSongsBySource, type MusicSearchHit, type MusicSearchSource } from "@/lib/music-search";
import { resolveVerifiedPlaybackUrlForHit } from "@/lib/song-download";
import { buildTrackLabel } from "@/lib/track-labels";
import type { ChatIntent, RadioProgram, Song } from "@/lib/types";

const CANDIDATE_LIST_SIZE = 3;
const SOURCE_ORDER: MusicSearchSource[] = ["qq", "kugou", "netease"];

export type PlayCandidate = {
  artist: string;
  title: string;
};

export type PlayRequestExecutionResult =
  | {
      kind: "candidate-list";
      program: RadioProgram;
      candidateList: PlayCandidate[];
      empty: boolean;
    }
  | {
      kind: "play-now";
      program: RadioProgram;
      played: PlayCandidate;
    };

function normalizeText(value: string | undefined) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()（）\[\]【】\-_.·,，/\\'"]/g, "");
}

function includesNormalized(haystack: string | undefined, needle: string | undefined) {
  const left = normalizeText(haystack);
  const right = normalizeText(needle);
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

/**
 * 评分：play-song-by-artist 模式下用，top vs second 差 > 2 才算"明显唯一"。
 * 同名不同版本（live/remix/伴奏）一律降权。
 */
function scoreCandidate(hit: MusicSearchHit, intent: ChatIntent) {
  let score = 0;
  const title = intent.title?.trim();
  const artist = intent.artist?.trim();
  const versionHint = intent.versionHint?.trim().toLowerCase();
  const text = `${hit.title} ${hit.artist} ${hit.albumName || ""}`.toLowerCase();

  if (title) {
    if (normalizeText(hit.title) === normalizeText(title)) score += 14;
    else if (includesNormalized(hit.title, title)) score += 8;
    else score -= 10;
  }
  if (artist) {
    if (normalizeText(hit.artist) === normalizeText(artist)) score += 14;
    else if (includesNormalized(hit.artist, artist)) score += 8;
    else score -= 12;
  }
  if (intent.language && text.includes(intent.language.toLowerCase())) score += 2;
  if (versionHint && text.includes(versionHint)) score += 4;
  else if (/live|dj|remix|伴奏|纯音乐/i.test(text)) score -= 6;
  if (hit.downloadable) score += 3;
  if (hit.payable) score -= 2;
  return score;
}

/**
 * 把 MusicSearchHit 列表里按"去重（artist+title 标准化）"过滤后取前 N 个。
 * 候选提问不需要评分：搜 X 出来前 3 首就是前 3 首，同名版本都进。
 */
function dedupeAndTakeTop(
  hits: MusicSearchHit[],
  n: number,
  excludeKeys: Set<string> = new Set(),
): MusicSearchHit[] {
  const seen = new Set<string>(excludeKeys);
  const out: MusicSearchHit[] = [];
  for (const hit of hits) {
    const key = `${normalizeText(hit.artist)}::${normalizeText(hit.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * 三源合并搜。play-artist 走这个；play-song-by-artist 也走这个但额外评分筛 top 1。
 */
async function searchAcrossSources(query: string, limitPerSource = 6) {
  const hits: MusicSearchHit[] = [];
  for (const source of SOURCE_ORDER) {
    try {
      const result = await searchSongsBySource(query, source, 1, limitPerSource);
      for (const hit of result) hits.push(hit);
    } catch {
      // 单源失败不要让整个搜崩，继续
    }
  }
  return hits;
}

/**
 * play-artist 专用：搜该歌手的 top N（同名不同版本都进）。
 * excludeKeys：之前已经搜出来过的 (artist+title) 标准化 key 集合，
 * 用于"换一批"——重搜时排除已展示过的候选，返回新 top N。
 */
async function searchArtistTopN(
  artist: string,
  n: number,
  excludeKeys: Set<string> = new Set(),
): Promise<MusicSearchHit[]> {
  const hits = await searchAcrossSources(artist, 6);
  return dedupeAndTakeTop(hits, n, excludeKeys);
}

/**
 * play-song-by-artist 专用：搜 X Y，按 score 排名，取 score > 0 的前 5，
 * 然后看 top vs second 差是否 > 2 决定是否能直接切。
 */
async function searchSongByArtist(intent: ChatIntent) {
  const queries = [
    intent.title && intent.artist ? `${intent.title} ${intent.artist}` : "",
    intent.title || "",
    intent.artist && intent.title ? `${intent.artist} ${intent.title}` : "",
  ]
    .map((q) => q.trim())
    .filter(Boolean);

  const allHits: MusicSearchHit[] = [];
  for (const q of queries) {
    const h = await searchAcrossSources(q, 6);
    for (const x of h) allHits.push(x);
  }
  const ranked = allHits
    .map((hit) => ({ hit, score: scoreCandidate(hit, intent) }))
    .sort((a, b) => b.score - a.score);
  return ranked.filter((x) => x.score > 0).slice(0, 5);
}

function buildRemoteSong(hit: MusicSearchHit, url: string): Song {
  return {
    id: buildTrackLabel(hit.title, hit.artist),
    title: hit.title,
    artist: hit.artist,
    year: new Date().getFullYear(),
    mood: "点播",
    energy: 0,
    language: "",
    tags: ["on-demand", hit.source],
    reasonSeed: "on-demand-play-request",
    source: hit.source,
    streamUrl: url,
    downloadContext: {
      source: hit.source,
      duration: hit.duration,
      payable: hit.payable,
      downloadable: hit.downloadable,
      albumName: hit.albumName,
      imageUrl: hit.imageUrl,
      raw: hit.raw,
    },
  };
}

/**
 * 真点播切歌：把原 currentTrack 推到 queue 头（去重），explanation 保留。
 * 不依赖 radio-engine / online-radio / applyChatIntentWithProgram。
 */
function buildProgramWithCurrentSong(
  song: Song,
  reason: string,
  currentProgram: RadioProgram,
): RadioProgram {
  const nextCurrent = { ...song, reason };
  const dedupedQueue = [currentProgram.currentTrack, ...currentProgram.queue].filter(
    (track) => track.id !== nextCurrent.id,
  );
  return {
    ...currentProgram,
    currentTrack: nextCurrent,
    queue: dedupedQueue,
  };
}

export async function executePlayRequest(
  intent: ChatIntent,
  currentProgram: RadioProgram,
  excludeKeys: Set<string> = new Set(),
): Promise<PlayRequestExecutionResult> {
  // play-artist：只搜不切，列 top N 让用户选。
  // excludeKeys 用于"换一批"——重搜同一歌手时排除之前已展示的候选。
  if (intent.action === "play-artist" && intent.artist) {
    const hits = await searchArtistTopN(intent.artist, CANDIDATE_LIST_SIZE, excludeKeys);
    if (hits.length === 0) {
      return {
        kind: "candidate-list",
        program: currentProgram,
        candidateList: [],
        empty: true,
      };
    }
    return {
      kind: "candidate-list",
      program: currentProgram,
      candidateList: hits.map((h) => ({ artist: h.artist, title: h.title })),
      empty: false,
    };
  }

  // play-song / play-song-by-artist：真点播
  if (intent.action === "play-song" || intent.action === "play-song-by-artist") {
    const viable = await searchSongByArtist(intent);
    const top = viable[0];
    const second = viable[1];

    // 模糊时回退成"候选提问"，让用户选
    // 当 intent.title 跟 top.hit.title normalizeText 后完全相等，
    // 说明用户已经明确指定了歌名（不是只给了歌手），即使有同名版本
    // 也强制走切歌——否则用户选完候选再输入"1"还是会被同名版
    // 本顶回来 fallback candidate-list，体验上等于没反应。
    const titleExactMatch =
      intent.title && normalizeText(top.hit.title) === normalizeText(intent.title);
    if (!top || (!titleExactMatch && second && top.score - second.score <= 2)) {
      const fallback = await searchArtistTopN(intent.artist || intent.title || "", CANDIDATE_LIST_SIZE);
      return {
        kind: "candidate-list",
        program: currentProgram,
        candidateList: fallback.map((h) => ({ artist: h.artist, title: h.title })),
        empty: fallback.length === 0,
      };
    }

    const url = await resolveVerifiedPlaybackUrlForHit(top.hit).catch(() => null);
    if (!url) {
      const fallback = await searchArtistTopN(intent.artist || intent.title || "", CANDIDATE_LIST_SIZE);
      return {
        kind: "candidate-list",
        program: currentProgram,
        candidateList: fallback.map((h) => ({ artist: h.artist, title: h.title })),
        empty: fallback.length === 0,
      };
    }

    const remoteSong = buildRemoteSong(top.hit, url);
    const reason = `按你的点播切到 ${top.hit.artist}《${top.hit.title}》。`;
    return {
      kind: "play-now",
      program: buildProgramWithCurrentSong(remoteSong, reason, currentProgram),
      played: { artist: top.hit.artist, title: top.hit.title },
    };
  }

  // play-similar 暂不实现（落到 chat 闲聊兜底）
  return {
    kind: "candidate-list",
    program: currentProgram,
    candidateList: [],
    empty: true,
  };
}
