# Progress Log

## Session: 2026-05-29

### Current Status
- **Phase:** 5 - Delivery
- **Started:** 2026-05-29

### Actions Taken
- Read `docs/claudio-architecture.md` and locked the product direction to “懂我的音乐 Agent”，而不是普通播放器增强。
- Audited the homepage recommendation loop across `preference-learning`, `online-radio`, `player-shell`, and chat-agent state routing.
- Implemented time-decayed preference aggregation so recent behavior outweighs old taste when the user’s mood changes.
- Implemented scene-aware affinity and negative signal modeling so the system can distinguish daytime, evening, and late-night behavior.
- Wired learned scene/global affinity back into online recommendation seed, query, ranking, and controlled discovery slots.
- Added a lightweight preference insights API and in-page learning panel so the learning system is observable instead of black-box.
- Added fixed “新发现” slots so exploration is explicit and measurable instead of hidden inside one mixed ranking score.
- Changed homepage queue labels from engineering jargon to user-facing language.
- Fixed homepage chat hydration issues caused by invalid `<p><div /></p>` nesting in streaming chat bubbles.
- Added a remote audio proxy route and updated online queue building to prefer playable URLs, with multi-source fallback and prune behavior for unusable remote tracks.
- Upgraded homepage chat so freeform music requests like “来点抒情的 / 摇滚劲爆一点 / DJ 上头” default to a new recommendation rebuild instead of requiring explicit control keywords.
- Tightened homepage recommendation filtering with recent-track hard exclusion, artist-cluster de-duplication, title-variant de-duplication, and junk-result filtering.
- Started collapsing homepage online playback into a single path: recommendation should return song content only, while actual playback should resolve through `/api/song-playback`, aligned with search preview.
- Migrated learning context into `claudio/live-music.ts` so Claudio live online mode now uses the same preference core.
- Added Claudio live playback completed/interrupted event write-back to `preference-events`.
- Updated architecture and planning documents to match the “懂我的音乐 Agent + 数据闭环推荐” positioning.

### Test Results
| Test | Expected | Actual | Status |
|------|----------|--------|--------|
| `npm run build` | Build passes after homepage recommendation, chat-agent, and proxy changes | Passed repeatedly after each stage, warning intentionally left unresolved | Passed |

### Errors
| Error | Resolution |
|-------|------------|
| `online-radio.ts` first patch did not match exact file context | Re-read exact code slices and patched in smaller chunks |
| `claudio/live-music.ts` query array inferred as `(string \| undefined)[]` | Narrowed with a type guard before returning |
| Invalid chat bubble HTML caused hydration warning | Changed streaming chat bubble wrappers from `<p>` to `<div>` where loaders render block nodes |
| Remote third-party direct URLs were not always browser-playable | Added server proxy and fallback source resolution, then pruned unplayable tracks from online LIST |
| Recommendation and playback URL responsibilities became mixed | Re-aligned the design toward “recommend content, resolve playback in one place” and documented `/api/song-playback` as the single playback resolution entry |

## Session: 2026-06-02

### Current Status
- **Phase:** 6 - 显式点播旁路（增量兼容原主线）
- **Started:** 2026-06-02

### Actions Taken
- 在 `src/lib/types.ts` 给 `ChatIntentAction` 加 `play-artist | play-song | play-song-by-artist` 三个 action（`play-similar` 评审为死代码已删），给 `ChatMessage` 加可选 `meta?: { pendingCandidates?: Array<{artist, title}> }`，给 `ChatIntent` 加 `artist?/title?/language?/versionHint?/mustPlayNow?`。
- 新建 `src/lib/play-request-executor.ts`：纯增量，不 import radio-engine / online-radio / preference-learning。两种结果互斥：candidate-list（play-artist 搜该歌手 top 3，不切歌）和 play-now（play-song-by-artist 搜 → 评分 → 拿可播 URL → 替换 currentTrack）。top vs second 差 ≤ 2 时仅在 title 不完全 match 才 fallback 候选，title 已精确匹配时强制走切歌（避免同名版本顶回候选让用户无响应）。
- `src/lib/chat-agent.ts` 加 play-request 旁路：在 `resolveAgentState` 之后、`inferOnlineFreeformIntent` / 9 个 action 流程之前插入 `resolvePlayRequest`。detectExplicitPlayIntent 三种 hit 形态（候选匹配 / 裸歌手 / X 的 Y / 《Y》- X / 裸歌名），不命中走原链路，命中短路并 return。`lastPendingCandidates` 倒着找 history 末尾 assistant 带 meta 的那一条，避免跳多句闲聊后误用过期候选。
- `src/app/api/agent/route.ts` directReply 分支的 SSE 帧加 `type: "assistant"` 标识 + `meta` 字段；现有 `type: "state"` 帧、模型流式 token 透传、`[DONE]` 一行不动。
- `src/components/player-shell.tsx` SSE 解析加 `chunk.type === "assistant"` 帧处理，把 `chunk.meta.pendingCandidates` 写进 placeholder.meta；现有 `chunk.type === "state"` 帧、`chunk.choices?.[0]?.delta?.content` 流式 token 两条路径一字不动。
- 端到端 probe 验证：`播 刘德华` → 候选列表 + SSE meta 进 chatHistory；`1` → 切刘德华《练习》；`播 刘德华 中国人` → 真点播直切（同名版本存在时 titleExactMatch 短路）；`下一首/收藏/你好/安静一点` → 原 9 个 action 完整保留。

### Test Results
| Test | Expected | Actual | Status |
|------|----------|--------|--------|
| `npx tsc --noEmit` | 0 error after types/executor/chat-agent/route/player-shell changes | 0 error | Passed |
| `播 刘德华` → 候选列表 | assistant SSE 帧带 `meta.pendingCandidates=[{刘德华, 暗里着迷(粤)}, {刘德华, 练习}, {刘德华, 17岁}]` | meta 字段正确，state.currentTrack 未变 | Passed |
| `1` → 切歌 | state.currentTrack 切到 `刘德华 - 练习`，reply `已经切到刘德华《练习》` | 切歌成功 | Passed |
| `播 刘德华 中国人` → 真点播 | top 命中刘德华《中国人》时直接切（titleExactMatch 短路同名版本干扰） | 走 play-now | Passed |
| `播 周杰伦 晴天` 模糊版本 → 候选列表 | top vs second 差 ≤ 2 且 title 不完全 match → fallback candidate-list | 走 candidate-list | Passed |
| `下一首` 原 9 个 action | 不被点播旁路截胡，走原 skip 链路 | state 正常切歌 | Passed |
| `收藏` 原 9 个 action | 不被截胡 | 收藏成功 | Passed |
| `你好` 闲聊 | 不被截胡 | 走 LLM 闲聊 | Passed |
| `安静一点` 原 9 个 action | 不被截胡 | 走 calmer | Passed |
| `播 xyzabc` 搜不到 | reply "我这儿没搜到" | empty 路径走通 | Passed |
| 长 history 跳多句闲聊再 `1` | `lastPendingCandidates` 找末尾 assistant 无 meta → 返 null → 走 LLM 闲聊 | 预期行为 | Passed |

### Errors
| Error | Resolution |
|-------|------------|
| resolveChatIntent 把"播 刘德华"判成 `scene-change`（"播" + 早晨时段），导致 initialState.mode === "music-control"，旁路只在 chat mode 跑没命中 | 把旁路插入点移到 music-control 块内最前面，让原 9 个 action 仍走原链路、play-* 才短路 |
| 真点播 `播 刘德华 练习` 搜到 top《练习》+ second《练习 (Live)》，score 差 ≤ 2 触发 fallback candidate-list，用户从候选里选 `1` 走第二轮又走 fallback 死循环 | scoreCandidate 加 `titleExactMatch` 短路：intent.title normalizeText 等于 top.hit.title 时强制走切歌 |
| 误把 `play-similar` 加进 `ChatIntentAction` | 评审为死代码（executor 不实现、LLM 路由器也未输出该 action），已删 |
| LSP server 反复报"修复后已不存在的旧行号" | 已知 LSP 缓存陈旧，以 `npx tsc --noEmit` 为准 |

## Session: 2026-06-02 (Phase 7)

### Current Status
- **Phase:** 7 - 聊天触发播放器控件
- **Started:** 2026-06-02 (Phase 6 同日)

### Actions Taken
- 在 `src/lib/types.ts` 给 `ChatIntentAction` 加 `pause | resume | replay | volume-up | volume-down | set-volume` 6 个 action（4 个新 + 2 个相对音量），给 `ChatIntent` 加 `value?: number` 给 set-volume 绝对值用。
- `src/lib/radio-engine.ts` `resolveChatIntent` 在 skip 分支后加 4 个新分支（pause / resume / replay / set-volume 绝对值）。volume-up / volume-down 相对调整**不进 radio-engine**，因为它们只需要 chat-agent 旁路识别，前端按 step 0.1 累加更准。
- `src/lib/chat-agent.ts` 加 `resolveControlIntent(message)` 函数 + `runChatAgent` 头部**最优先**短路（在 `resolveAgentState` 之后立即判，命中后直接 return）。`RunChatAgentResult` 加 `controlAction?` / `controlValue?` 字段。短路路径**不写** preference_event、**不动** program、**不调** LLM / radio-engine / online-radio。
- `src/app/api/agent/route.ts` directReply 分支在 state 帧之后、assistant 帧之前**新发** SSE `type: "control"` 帧，data 字段 `{ action, value? }`。
- `src/components/player-shell.tsx` 抽离出 `pauseAudio / resumeAudio / replayAudio / volumeUp / volumeDown / setVolumeTo` 6 个独立函数 + `playerActionsRef = useRef({...})`。**`togglePlayback` 内部重构成调 `resumeAudio / pauseAudio`**——按钮 onClick 跟聊天 control 帧走完全同一份代码。SSE control 帧解析时调 `playerActionsRef.current.xxx()`。**60+ 个其他按钮 onClick 没动**（A 方案：只新增 playerActionsRef，不重构现有按钮）。
- 端到端 probe 验证：`暂停 / 继续 / 重播 / 音量 70 / 大声点 / 小声点` 6 个全部正确返回 SSE control 帧；`收藏 / 下一首` 原 9 个 action 完整保留、不被 control 旁路截胡。

### Test Results
| Test | Expected | Actual | Status |
|------|----------|--------|--------|
| `npx tsc --noEmit` | 0 error after types/engine/chat-agent/route/player-shell changes | 0 error | Passed |
| `暂停` → control 帧 | SSE `type:"control", action:"pause"`, assistant content `"暂停了。"` | control 帧 + assistant 帧都发 | Passed |
| `继续` → control 帧 | SSE `type:"control", action:"resume"`, assistant content `"继续播。"` | 同上 | Passed |
| `重播` → control 帧 | SSE `type:"control", action:"replay"`, assistant content `"从头再来。"` | 同上 | Passed |
| `音量 70` → control 帧 | SSE `type:"control", action:"set-volume", value:70`, assistant content `"音量调到 70。"` | value 字段正确 | Passed |
| `大声点` → volume-up | SSE `type:"control", action:"volume-up"` | 命中 | Passed |
| `小声点` → volume-down | SSE `type:"control", action:"volume-down"` | 命中 | Passed |
| `收藏` 原 9 个 action | intent=favorite、**无 control 帧** | 走原 9 个 action 链路 | Passed |
| `下一首` 原 9 个 action | intent=skip、**无 control 帧** | 走原 9 个 action 链路 | Passed |
| togglePlayback 按钮行为 | 内部调 resumeAudio / pauseAudio，跟聊天 control 帧走同一份实现 | 重构后功能等价 | Passed |

### Errors
| Error | Resolution |
|-------|------------|
| 第一次 patch togglePlayback 删过头，把 4 行孤儿 pause 代码 + JSDoc 注释留在函数外，编译报 93 个 LSP 错误 | 实际 tsc 0 error，撤回多余 4 行；LSP 缓存陈旧，以 tsc 为准 |
| `pauseAudio` / `resumeAudio` 等函数闭包引用外层 audioRef / setIsPlaying / setVolume 等 hooks 状态 | 函数定义在 PlayerShell 组件内，闭包合法；tsc 0 error |

## Session: 2026-06-02 (Phase 8)

### Current Status
- **Phase:** 8 - 候选列表"换一批"重搜
- **Started:** 2026-06-02 (Phase 6/7 同日)

### Actions Taken
- `src/lib/play-request-executor.ts`：`dedupeAndTakeTop` 和 `searchArtistTopN` 加 `excludeKeys: Set<string> = new Set()` 可选参数。`executePlayRequest` 第 3 个参数加 `excludeKeys`，play-artist 透传到 `searchArtistTopN`。**0 破坏**——已有 caller 不传 excludeKeys 时行为完全不变。
- `src/lib/types.ts`：`ChatIntent` 加 `refresh?: boolean` 标记。
- `src/lib/chat-agent.ts` `detectExplicitPlayIntent` 新增第 0 优先级分支（先于候选匹配和 bareArtist）："换/换一批/换一下/不要这几首/再来点/换其他/还有吗/别的/换一批的/换一批吧/想换一批/再换一批/refresh" + `lastPendingCandidates(history)` 命中 → 返回 `play-artist, artist=pending[0].artist, refresh:true`。
- 加 `isRefreshIntent(normalized)` 函数 12 个关键词识别。
- `resolvePlayRequest` 加 refresh 路径：从 history 末尾 candidateList 构造 `excludeKeys: Set<"artist::title" 标准化 key">`，透传给 `executePlayRequest`。assistant 文本区分首轮 "X 的歌，你想听哪首？" vs 刷新 "X 的其他歌，刷新一下："。空集合时刷新走"我这儿就这几首 X 的歌了"区别于首轮"我这儿没搜到 X"。
- `normalizeTitleKeyForExclude` 复用 executor 内部 `normalizeText` 规则（小写化 + 去空白 + 去符号），避免规则漂移。

### Test Results
| Test | Expected | Actual | Status |
|------|----------|--------|--------|
| `npx tsc --noEmit` | 0 error after types/executor/chat-agent changes | 0 error | Passed |
| `播 刘德华` → 候选列表 | assistant SSE 帧带 `meta.pendingCandidates`、content "刘德华 的歌，你想听哪首？..." | 命中 | Passed |
| `换`（紧接在 candidateList 之后） | assistant 文本 "刘德华 的其他歌，刷新一下：1.《17岁》..."、meta 全新 3 首 | 完全不重复前 3 个 | Passed |
| `换一批`（紧接在第二轮之后） | assistant 文本 "刘德华 的其他歌，刷新一下：1.《暗里着迷 (粤)》..."、meta 全新 | music-search 三源顺序稳定，去重后回到第一轮的 3 个 | Passed |
| `换一批的` | 同上 | 命中 | Passed |
| `换` 无候选上下文 | fall through 到原 9 个 action 链路 | `intent: none`、走 LLM 路由器（已知 LLM 在裸 "换" 上会判 none——是基线行为，非本次回归） | Passed (by design) |
| `1` / `中国人` / `就这首` 候选匹配 | play-song-by-artist 真点播切歌 | 不变 | Passed |
| 原有 9 个 action（`下一首` / `收藏` / `安静一点`） | 不被 refresh 旁路截胡 | 不变 | Passed |

### Errors
| Error | Resolution |
|-------|------------|
| 第一次写 refresh branch 时漏掉 assistant 文本区分首轮 vs 刷新——用户看不出"我刚看的歌又出现了" | 加 prefix 区分：首轮"X 的歌"、刷新"X 的其他歌，刷新一下"；空集合回复也区分 |
| music-search 三源返回顺序稳定 → "换一批" 总是回到第一轮的 3 个 | 这是 music-search 本身行为，不是逻辑 bug；接受。文档里写清楚"刘德华本地能搜到的就这 6 首" |
