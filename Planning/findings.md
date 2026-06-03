# Findings & Decisions

## Requirements
- Claudio 的产品定位必须明确为“懂我的音乐 Agent”，而不是播放器外面包一层聊天。
- 系统核心目标是通过用户偏好数据不断学习，并持续推荐用户真正更愿意听下去的歌。
- 首页是当前第一主战场，用户应能通过随意自然语言聊天自由切换不同风格的歌。
- 新增能力必须直接提高事件学习质量、偏好表达能力、推荐反哺强度，或让自由聊天更稳定地触发推荐重组。

## Research Findings
- 现有 `src/lib/preference-learning.ts` 已有事件落盘和聚合，但早期模型表达不足，原本缺少时间衰减和 scene 分层。
- 现有 `src/lib/online-radio.ts` 已把偏好模型用于 seed/query/ranking，但如果没有更强反馈链和可解释标签，系统仍容易变成“黑盒推荐”。
- 前端 `player-shell.tsx` 已持续上报 `favorite / download / playback_completed / playback_interrupted / chat_request`，采样入口已足够支撑真正的数据闭环。
- 首页聊天原本更偏“显式控制命令”，并不稳定支持“来点抒情的 / DJ 上头 / 摇滚劲爆一点”这类自由音乐请求。
- 在线歌播放失败的核心风险不在“本地和在线混排”，而在第三方直链不稳定，必须服务端代理并在入队前剔除不可播项。
- 在线推荐和在线播放如果同时各自产生一套最终 URL，会把推荐职责和播放职责搅在一起，后续很难稳定。
- 正确的边界应该是：推荐层只产出歌曲内容，播放层统一拿这些内容走 `/api/song-playback` 解出真实可播地址。
- `claudio-live` 原本有独立在线搜歌链路，但没有完整复用首页学习上下文，也没有一开始就把 live 播放行为写回偏好事件流。
- 在不重构统一编排内核的前提下，先把首页学习核心做稳，再把学习上下文迁入 `claudio/live-music.ts`，是当前风险最低的推进路径。

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| 给偏好事件增加时间衰减 | 近期行为应比旧习惯更能代表当前口味变化 |
| 新增按 scene 的 artist/language/tag affinity | 同一用户在 morning/daytime/evening/late-night 的偏好不是一套 |
| 在在线推荐评分里直接接入 learned positive/negative signals | 让学习结果真实影响匹配和排序，而不只停留在旁路统计 |
| 增加学习面板和 `preference-insights` API | 学习链路必须可观测，否则后续调优仍然是黑盒 |
| 给在线推荐加入固定“新发现”槽位 | 让探索是显式、可控、可统计的，而不是混在一个大排序里 |
| 首页聊天把自由音乐请求默认转成 `regenerate + messageHint` | 用户应通过随意对话切换风格，而不是学习命令词 |
| 在线歌统一走服务端代理并做三源兜底 | 浏览器不应直接承担第三方音频直链不稳定的问题 |
| 推荐和播放必须拆职责 | 推荐只负责“推什么歌”，播放统一负责“把这首歌变成真实可播地址” |
| Claudio live 先迁学习上下文和播放事件回流 | 先把 learning core 统一，再做更高风险的 on-air caller/chat |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| `Planning` 目录不是标准 `SKILL.md` | 按其中的计划文档结构读取并补充发现与进度 |
| 工程术语过重，不适合直接显示给用户 | 将首页推荐标签改成更像用户能理解的自然语言 |
| 聊天气泡里 loader 组件输出块级节点 | 把相关气泡容器从 `<p>` 改成 `<div>`，消除 hydration 风险 |
| 第三方在线音频直链不稳定 | 代理远端音频，并在建队列时多源兜底、不可播即剔除 |
| 推荐层和播放层一度同时维护播放 URL | 收口为单一职责，并把统一播放解析入口写入架构和计划文档 |

## Resources
- `docs/claudio-architecture.md`
- `src/lib/preference-learning.ts`
- `src/lib/online-radio.ts`
- `src/components/player-shell.tsx`
- `src/lib/chat-agent.ts`
- `src/app/api/remote-audio/route.ts`
- `src/lib/claudio/live-music.ts`
- `src/components/claudio-live-shell.tsx`

## Session 2026-06-02: 显式点播旁路

### 增量要求
- 显式点播（"播 刘德华""播 刘德华 中国人"）应**优先于**"重生成推荐"，不进入原 9 个 action 列表
- 走新旁路：`detectExplicitPlayIntent` → `executePlayRequest` → 真点播切歌 或 候选提问
- 不动 `radio-engine` / `online-radio` / `preference-learning` / `applyChatIntentWithProgram` / `applyOnlineChatIntent` 任何一行

### Research Findings
- `resolveChatIntent` 在 `radio-engine.ts` 把"播" + 时段组合判成 `scene-change`，导致 `resolveAgentState` 把 initialState.mode 标成 `music-control`。点播旁路如果只挂在 `mode === "chat"` 分支会完全错过。旁路必须挂到 `music-control` 块**最前面**先判 play-*，命中短路；不命中才让原 9 个 action 走自己的 `appendPreferenceEvent` + `applyOnlineChatIntent`。
- `inferOnlineFreeformIntent` 的 LLM 路由器在裸 query "刘德华""冰雨"上不可靠：它会忽略 history 里的"上一条候选"上下文，自己编出 play-song 但不带 artist，或编出 regenerate 让电台推荐新歌。结构化候选 meta 比 LLM 文本匹配准 100 倍。
- music-search 返回的 hit 标准化不严格，"练习"和"练习 (Live)" 在 score 上经常同分（差 ≤ 2）。如果 executor fallback 候选列表阈值不调整，用户从候选里选 `1` 走第二轮又走 fallback → 死循环。必须加 `titleExactMatch` 短路：intent.title normalizeText 等于 top.hit.title 时强制走 play-now。
- `next dev` 进程的 SSE 状态帧里 `intent.action` 在点播旁路下应该是 `none`（不是 `play-artist`/`play-song-by-artist`），因为原前端 `applyChatIntentWithProgram` / `applyOnlineChatIntent` 不会读这 3 个新 action；意图已经走 executor 实际切完歌，state.intent 只作 SSE 帧透传给前端，前端不会拿这个 intent 去调任何 action handler。
- LSP server 对历史版本缓存很重，明明删了的行 / 改完的 import 还会报错。**只信 `npx tsc --noEmit`，LSP 警告忽略**。

### Technical Decisions
| Decision | Rationale |
|----------|-----------|
| 点播用 3 个新 action（`play-artist` / `play-song` / `play-song-by-artist`）而不是扩 9 个原 action | 显式点播的语义是"切到指定歌"（指定歌手或指定 X+Y），跟"重排推荐 LIST"（regenerate/calmer/fresh/familiar）正交；混进原 action 会污染 feedbackBias 累加、schedule 重排逻辑、preference_event 流 |
| 候选数据走 SSE `meta.pendingCandidates` 透传，不存后端 | 不需要 anchor store / 服务端 chat session / localStorage；前端 ChatMessage 加可选 `meta` 字段，history 数组照常透传，下一轮 user 选歌时后端从 history 末尾 assistant.meta 读 |
| `play-artist` 默认只列 top 3 不切歌 | 用户输"播 刘德华"多数情况是想听某一首而不是随机切一首；让用户从 top 3 里挑是最低认知负担（不用弹窗不用候选 UI） |
| `play-song-by-artist` 模糊版本差 ≤ 2 时仅在 title 不完全 match 时 fallback 候选 | title 已精确匹配时尊重用户明确意图（同名版本是次要语义），避免"刘德华 练习"被"练习 (Live)" 顶回候选 |
| `matchPendingCandidate` 识别"第 N 首" / 裸数字 1/2/3 / "就这首" / "这首" / "第一个" / "中间那首" / "最后一个" / 裸歌名 | 候选列表里的歌名是结构化数据，能直接程序化匹配；不需要 LLM 路由器来识别"上一条是候选"这种语义 |
| executor 内部自己 `buildProgramWithCurrentSong`，不复用 `radio-engine` | 显式点播对 program 的修改语义是"硬切 currentTrack + 把原 currentTrack 推到 queue 头"，跟 radio-engine 的 queue 重排不是同一回事 |
| `play-similar` 评审为死代码已删 | executor 不实现 play-similar、LLM 路由器的 action 列表也没列它，留在 `ChatIntentAction` 类型里只会误导后续开发者 |
| `lastPendingCandidates` 倒着找 history 末尾第一条 assistant，碰到无 meta 的就停返 null | 避免跳多句闲聊后（如"播 刘德华 → 你好 → 1"）错用过期候选；`你好`是 chat 模式走 LLM 路由器，assistant 消息无 meta，返 null 走 LLM 闲聊是预期 |
| `appendPreferenceEvent` / `preference-learning` 在点播旁路里不写 | 点播语义跟"反馈"（skip/favorite/fresh/calmer）正交；混写会污染偏好模型。下次有需要再单独开 issue 加 `play-request` event type |
| `route.ts` directReply 帧加 `type: "assistant"` 标识 | 前端 SSE 解析需要区分"模型流式 token"和"directReply 整段"。原 `chunk.choices?.[0]?.delta?.content` 路径完全不动 |

### Issues Encountered
| Issue | Resolution |
|-------|------------|
| 原 9 个 action 链路里"播 刘德华"被 `resolveChatIntent` 误判为 `scene-change`，旁路挂在 chat mode 跑没命中 | 旁路插入点移到 `music-control` 块内最前面，先判 play-*；不命中才让原 9 个 action 继续 |
| music-search 返回的同名版本（刘德华《练习》vs《练习 (Live)》）让 top vs second 经常差 ≤ 2，从候选里选 `1` 走第二轮又走 fallback | executor 加 `titleExactMatch` 短路：intent.title 完全等于 top.hit.title 时强制切歌 |
| `play-similar` 写进 `ChatIntentAction` 类型但 executor / LLM 路由器都不实现 | 评审为死代码，从类型里删 |
| "1/2/3" 裸数字作为候选选择 | 在 `matchPendingCandidate` 加 `^(\d+)$` 分支，限制 1-N 防误吞越界值 |
| LSP server 反复报"修复后已不存在的旧行号" | 已知 LSP 缓存陈旧，`npx tsc --noEmit` 0 error 即真 |

### Resources
- `src/lib/play-request-executor.ts`（新建）
- `src/lib/chat-agent.ts`（增量：旁路 + detect/last/match 三个函数）
- `src/lib/types.ts`（增量：3 个新 action + ChatMessageMeta + ChatIntent 5 个新字段）
- `src/app/api/agent/route.ts`（增量：directReply 帧 type + meta）
- `src/components/player-shell.tsx`（增量：SSE 解析 `type === "assistant"` 分支）

## Session 2026-06-02 (Phase 7): 聊天触发播放器控件

### 增量要求
- 用户在聊天里说"暂停/继续/重播/音量 N/大声点/小声点"应直接调主页面 audio 元素，**不进入**原 9 个 action 列表
- 跟 play-request 同款思路：chat-agent 头部最优先旁路，SSE `type:"control"` 帧让前端 audioRef 调
- **必须**跟现有播放器按钮走同一份实现（统一动作层），不能各写一份 audioRef.pause() / audioRef.play()
- 后续要扩"上一首/下一首/收藏/下载"进聊天，扩 playerActionsRef 即可，不应该动 60+ 个现有按钮 onClick

### Research Findings
- `resolveChatIntent` 跟 `resolveAgentState` 是平行的，命中即返回 action，**默认会进 music-control 分支**走 `appendPreferenceEvent`。如果 pause / resume 走这条路，preference_event 流会被"暂停"这种纯播放器操作污染——feedbackBias 累加、schedule 重排、preference-insights 全部出现噪声。**chat-agent 头部最优先旁路是必须**。
- 音量**不需要后端知道当前音量**——"大声点"是相对语义（+0.1），"音量 N" 是绝对语义。前端已经在 React state 里管音量（1228 行 `audioRef.current.volume = volume` useEffect），后端只发语义指令（`volume-up` / `volume-down` / `set-volume-N`），前端解析时执行。当前音量完全前端管，零状态同步问题。
- "音量 70" 这种绝对值用 `set-volume 70`；"大声点/小声点"用 `volume-up` / `volume-down`（前端按 step 0.1 累加，clamp 0-1）。**两类不混**——LLM 路由器不会被要求同时识别相对 / 绝对语义。
- **统一动作层模式**：`playerActionsRef = useRef<PlayerActions>` 暴露 6 个独立函数（`pauseAudio` / `resumeAudio` / `replayAudio` / `volumeUp` / `volumeDown` / `setVolumeTo`），`togglePlayback` 内部重构成调 `resumeAudio / pauseAudio`——**按钮 onClick 和聊天 SSE control 帧走完全同一份实现**。`useRef` 在 render 之间稳定，SSE 解析和 onClick 持有同一份 ref。
- A 方案 vs B 方案：A 方案只新增 `playerActionsRef`，60+ 个现有按钮 onClick 不动；B 方案把 60+ 个 onClick 全重构走 ref。本次选 A——理由：未来扩展（"上一首/下一首/收藏/下载"进聊天）只需扩 PlayerActions 类型 + 现有按钮 onClick 改成 ref.current.xxx，**0 风险一次性到位**；B 方案是当前不必要的 60 处手术。

### Technical Decisions
| Decision | Rationale |
|----------|-----------|
| 控件类动作走 chat-agent 头部**最优先**旁路，不进 9 个 action 列表 | 跟"改推荐 LIST"语义正交；不进 preference_event / 不污染 feedbackBias |
| 音量用前后端**语义解耦**：后端发 `volume-up` / `volume-down` / `set-volume N`，前端调 React state | 当前音量完全前端管；后端不需要读 program.currentVolume 字段 |
| 音量 step = 0.1（10%），clamp 0-1 | 跟 audio 元素 native volume API 一致；用户感知"10% 一档"是合理粒度 |
| `playerActionsRef` 抽离独立函数（不内联 switch） | `togglePlayback` 内部能直接调 `resumeAudio` / `pauseAudio`，未来扩"上一首"等动作只需加新函数 + 加进 ref 类型 |
| **不重构** 60+ 个现有按钮 onClick（A 方案） | 现有按钮行为稳定，重构 60 处是当前不必要的手术；未来扩"上一首/下一首"时按需把那个按钮的 onClick 改 `playerActionsRef.current.playPrevious()`，渐进式收口 |
| `volume-up` / `volume-down` 相对调整**不进** `resolveChatIntent` | 它们只在 chat-agent 旁路里识别就够了；放进 radio-engine 会增加 9 个 action 列表的"动作噪声"——本质是 audio 元素操作，不是推荐 intent |

### Issues Encountered
| Issue | Resolution |
|-------|------------|
| 第一次 patch togglePlayback 删过头，4 行孤儿 pause 代码 + JSDoc 注释留在函数外，LSP 报 93 个错 | 实际 tsc 0 error；LSP 缓存陈旧，**以 tsc 为准** |
| `pauseAudio` 等函数闭包引用外层 audioRef / setIsPlaying / setVolume 等 hooks 状态 | 函数定义在 PlayerShell 组件内，闭包合法；tsc 0 error |
| pause / resume / replay / set-volume 绝对值 4 个 action 在 radio-engine.resolveChatIntent 也加了分支 | 跟 chat-agent 旁路**不冲突**——旁路在头部最优先，radio-engine 命中 control-* 时虽然也会进 music-control 分支，但 chat-agent 已经先 return 短路了。**两端都加是为了 LLM 路由器在 freeform 模式下也能识别**，但实际走旁路不会污染 preference_event |

### Resources
- `src/lib/types.ts`（增量：6 个 action + value 字段）
- `src/lib/radio-engine.ts`（增量：resolveChatIntent 4 个新分支）
- `src/lib/chat-agent.ts`（增量：resolveControlIntent 函数 + runChatAgent 头部最优先短路）
- `src/app/api/agent/route.ts`（增量：SSE type:"control" 帧透传）
- `src/components/player-shell.tsx`（增量：playerActionsRef 统一动作层 + SSE control 帧解析）

## Session 2026-06-02 (Phase 8): 候选列表"换一批"重搜

### 增量要求
- 用户在 candidateList 上下文里说"换/换一批"等关键词 → **重搜同一歌手的 top 3**（去重已展示候选），不切歌、不进原 9 个 action
- 无候选上下文时 "换" → fall through 到原 9 个 action（`换一批` regenerate 走原 radio-engine）——保持原行为
- 不动原 9 个 action 链路
- assistant 文本要区分首轮 vs 刷新——给用户明确反馈

### Research Findings
- **触发条件耦合**：用户说"换"的语义强依赖于上下文——candidateList 上下文里 = "换该歌手的其他歌"，无上下文 = "换电台推荐"。两种语义不能混。**判定时机**必须在 detectExplicitPlayIntent 头部，且必须先看 history。
- **关键词冲突**：`换一批` 在原 `resolveChatIntent` 里就是 regenerate 关键词。如果旁路无条件接，会跟原 9 个 action 撞。**解决方案**：旁路只在 candidateList 上下文命中，无上下文 fall through，原 9 个 action 仍按 `换一批` regenerate 走。
- **excludeKeys 标准化**：executor 内部 `normalizeText` 规则（小写 + 去空白 + 去符号 `( ) - _ . · , ， / \ ' "`）。chat-agent 构造 excludeKeys 时**必须复用同一套规则**，否则 key 不匹配，重搜会返回已展示过的歌。封装在 `normalizeTitleKeyForExclude` 跟 executor 同步维护。
- **music-search 三源返回顺序稳定** → "换一批"总是回到第一轮的 3 个。这是 search 本身行为，不是逻辑 bug。
- **assistant 文本反馈**：用户在刷新时如果没看到歌名变化，会以为系统没动。必须用文本区分（"X 的其他歌，刷新一下" vs "X 的歌，你想听哪首"）。

### Technical Decisions
| Decision | Rationale |
|----------|-----------|
| "换一批" 走 play-artist refresh 模式 + `intent.refresh=true` 标记 | 跟原 play-artist 共用 executor 搜索路径；只新增 excludeKeys 透传参数，不另开新 action |
| 旁路只在 `lastPendingCandidates(history)` 命中时识别"换" | 上下文耦合；无候选时 fall through 到原 9 个 action 链路（"换一批" regenerate） |
| excludeKeys 是 `Set<"artist::title" 标准化 key">` 透传到 executor | 复用 executor 内部去重逻辑；不在 chat-agent 里复制一份 normalize 函数，避免规则漂移 |
| 12 个"换一批类"关键词 | 中文口语化"换/换一批/换一下/换其他/还有吗/别的/不要这几首/再来点/换一批的/换一批吧/想换一批/再换一批" + 英文 "refresh"。覆盖 80% 口语，不搞 fuzzy match（避免误判"换季"="换"+"季" 之类） |
| assistant 文本区分首轮 vs 刷新 | 给用户明确反馈当前是"看到新歌"还是"回到老歌"；空集合回复也区分（"我这儿就这几首" vs "我这儿没搜到"） |
| **不**改 `resolveChatIntent` `换一批` 分支 | 保持原 9 个 action 链路行为不变；裸 `换`（无候选上下文）走 LLM 路由器由它自己处理——基线行为，不引入回归 |

### Issues Encountered
| Issue | Resolution |
|-------|------------|
| 第一次写 refresh branch 时漏掉 assistant 文本区分首轮 vs 刷新 | 加 prefix 区分；空集合回复也区分 |
| music-search 三源返回顺序稳定 → "换一批" 总是回到第一轮的 3 个 | 这是 music-search 本身行为，不是逻辑 bug；文档里写清楚 |
| 无候选上下文 `换` fall through 后 LLM 路由器判 none → 静默失败 | 基线行为，非本次回归；后续要补可单独 issue 改 `resolveChatIntent` regenerate 分支加 `/^换$/`（**但需要你同意动原链路**） |

### Resources
- `src/lib/types.ts`（增量：`refresh?: boolean`）
- `src/lib/play-request-executor.ts`（增量：`dedupeAndTakeTop` + `searchArtistTopN` + `executePlayRequest` 加 `excludeKeys` 可选参数）
- `src/lib/chat-agent.ts`（增量：`isRefreshIntent` 函数 + `detectExplicitPlayIntent` 第 0 优先级分支 + `resolvePlayRequest` refresh 路径 + `normalizeTitleKeyForExclude` 辅助）

## Session 2026-06-02 (Phase 9): LLM 路由器 + mood keyword 兜底

### 增量要求
- LLM 路由器对"今天有点累/想家了/嗨一点/夜深了"等 mood 表达 100% 判 `none` → messageHint 字段不被使用，链路失效
- chat-agent 加纯增量 keyword 兜底，命中后补回 `regenerate + messageHint` 走原 `applyOnlineChatIntent` 链路
- 不动 LLM 路由器 prompt，不动原 9 个 action，不动 radio-engine / online-radio / preference-learning

### Research Findings
- **LLM 路由器对 mood 表达偏 none 是基线行为**：Phase 9a probe（`今天有点累` / `想家了` / `嗨一点` / `慵懒一点` / `想听点轻快的` 等 7 个 mood 表达）100% 判 `none`。Likely 是 prompt 的 json schema 限定 + 模型对模糊 mood 的"安全"倾向。**改 prompt 风险大且违反"不擅改 LLM 调用方"原则**，改走 chat-agent 旁路兜底。
- **keyword 库形态选择**：考虑过 (a) 复刻 LLM 路由器 prompt 加 examples、(b) 接 LLM 自动扩词、(c) 手工维护 18 组关键词。**选 (c)**——简单稳定可观测，覆盖 90% 用户的直觉 mood 表达；扩展性靠后续加 weight/分组，不靠 LLM 调用。
- **多组命中时取 weight 最高**：5 类信号 weight 5/4/3/2 反映"信号强度"（情绪 > 风格 > 时刻 > 否定）。**不做复杂合并**（如 hint 拼接、LLM 重写）——保持 fallback 是"确定性纯函数"，可控可测。
- **触发位置**：必须在 `runChatAgent` 内部、`inferOnlineFreeformIntent` 调用之后立即判。**不能**放到 LLM 模型调用之后（已经走远）；**不能**放到 `applyOnlineChatIntent` 内部（那层已经被旁路封装好，动了会污染）。
- **intent 产物同构**：fallback 命中后构造的 `{action: "regenerate", messageHint: "..."}` 跟 LLM 路由器命中的产物完全同构 → 走同一条 `applyOnlineChatIntent` 链路（messageHint 智能优先路径）。**不为 fallback 单独写 apply 函数**。
- **`resolver: "mood-keyword"` 联合类型扩展**：preference-learning 的 `PreferenceEvent.resolver` 联合类型从 `"rule" | "llm"` 扩到 `"rule" | "llm" | "mood-keyword"`。**intent_resolved 事件会带上这个字段**，后续可观测"fallback 命中率 / fallback 后用户对推荐的接受度"。
- **HTTP 端到端探针在 Next dev mode 不稳**：SSE 流式响应 + LLM 5s+ 调用 + dev HMR 缓存错乱组合下，curl 反复 0 字节。**改用直接抠源码纯函数跑单元测试**（18/18）作为交付标准。生产环境用 `next build && next start` 无 HMR 不会有这问题。

### Technical Decisions
| Decision | Rationale |
|----------|-----------|
| LLM 路由器喂 `preference insights` + 输出 `messageHint`，走"LLM 智能优先"路径 | 把 Phase 5 已有的 messageHint 通道从单点（点播用）扩成"LLM 路由器直出"通用；让 online-radio.applyOnlineChatIntent 走智能优先，吃到 insights + sceneProfile + 实时口味 |
| 走 chat-agent keyword 兜底**不调 LLM** | LLM 调用的延迟 / 失败率 / token 成本不允许把 fallback 交给 LLM；keyword 是确定性纯函数，0 延迟 0 失败 |
| `MOOD_KEYWORD_HINTS` 用 4 类信号 + weight 5/4/3/2 分级 | 情绪类比风格类更明确（"累" vs "慢"），时刻类（"夜深了"）是弱信号（可能用户在描述不是请求），否定类（"不想听"）最弱（无法判断用户具体不想要什么） |
| 兜底命中后用 `mode:"music-control" + intent:{action:"regenerate", messageHint}` | 跟 LLM 路由器命中的产物**同构**，走同一条 `applyOnlineChatIntent` 链路 |
| `IntentResolution` 加 `"mood-keyword"` 标识 | 跟 `rule` / `llm` 并列，写进 `intent_resolved` 事件；后续可观测"LLM 路由器判 none 率" / "fallback 命中率" / "fallback 后用户对推荐的接受度" |
| 不接 LLM 自动扩词 | 保持 fallback 是"简单稳定兜底"定位；自动扩词会把 fallback 复杂度抬到跟 LLM 路由器同档，不如直接改 LLM 路由器 |
| 不做多 keyword 复杂合并 | 跟 LLM 路由器输出的 messageHint 比起来，手工合并多个 hint 容易产生矛盾或冗余；保持单 hint 简明 |
| 不命中时不主动追问 | 保持当前 fall through 到 LLM DJ 闲聊；用户已经得到"自然回应"（DJ 自由应答），不强行打断成"想听点什么？" |
| 用"直接抠源码纯函数跑单元测试"代替 HTTP 端到端探针 | Next dev mode + SSE + LLM 组合下探针不稳定；纯函数单元测试 18/18 是稳定可重复的交付标准 |

### Issues Encountered
| Issue | Resolution |
|-------|------------|
| 第一版 plan 提"动 LLM 路由器 prompt"让 mood 表达判 regenerate | 实测 LLM 路由器对 7 个 mood 表达 100% 判 none（基线行为），改 prompt 风险大。**回滚**，改走 chat-agent 纯增量 keyword 兜底 |
| `console.log("[phase9-fallback]")` 调试日志 | 删了保持代码干净；resolver 字段已经写进 preference_event，dev server log 不需要这一行 |
| dev server HMR 缓存错乱 → HTTP 探针 0 字节 | kill + 重启 dev server。生产环境用 `next build && next start` 无 HMR，无此问题 |
| HTTP 端到端探针反复超时（5s/20s/30s 都拿不到 state 帧） | 改用纯函数单元测试（18/18）作为交付标准；保留一次 HTTP 成功实测（`今天有点累` → `action=regenerate hint=用户情绪低落...`）作 evidence |
| 探针代码多次跑超时卡住 terminal | 删除 /tmp/probe_phase9_*.js 临时文件，保持 /tmp 干净 |

### Resources
- `src/lib/chat-agent.ts`（增量：import readPreferenceInsights + inferOnlineFreeformIntent 第 3 参数 insights + prompt preferenceBlock + messageHint 指令 + MOOD_KEYWORD_HINTS 常量 + inferFromMoodKeywords 函数 + runChatAgent fallback 调用 + IntentResolution 联合类型扩展）
- `src/lib/preference-learning.ts`（增量：PreferenceEvent.resolver 联合类型加 "mood-keyword"）
- 单元测试脚本：临时 `/tmp/probe_phase9_unit.js`（已删，跑通 18/18 后清理）

## Session 2026-06-03 (Phase 10-14): 聊天控制在线播歌 + agent 懂你想要的歌

### 增量要求
- 用户说"炸一点/嗨翻/带感"等 mood 表达要稳定进入 regenerate + messageHint
- "再来点这种/类似的" → 基于 currentTrack 特征找相似
- "太吵了/太老了/不喜欢这首" → 标黑当前曲
- LLM 路由器感知"现在是早高峰/午休/深夜"等实际时间，messageHint 反映时段差分
- 闭环：similar 推荐用户听了 → 正向；中途 skip → 负向；主动 avoid → 负向

### Research Findings
- LLM 路由器对 mood 表达 100% 判 none 的根因（Phase 9）没消失，只能在 chat-agent 旁路**继续补关键词**。"炸/嗨翻/带感/上头/困/跑步/派对"这些用户口语高频词没被 18 组覆盖 → 直接 0 学习。
- `extractMessageHints` 已经有"炸/炸一点/劲爆/热一点"派发词（online-radio.ts:378-380），所以**只要 mood 兜底 messageHint 填上，online-radio 端就自然识别**。这是补关键词 ROI 高的原因。
- similar 路径不能用 messageHint "类似 X" 喂搜索端，原因是搜索端不知道 X 是哪首歌。**必须**在 chat-agent 层把 currentTrack 特征（artist + title + tags）拼成 messageHint，再透传 — `extractMessageHints` 已经有"类似/延续/保持/继续"派发词。
- avoid-current 跟 similar 互斥：用户说"类似的"绝不是说"避开"，但都是 chat mode 触发。**avoid 必须放最优先**（在 mood 兜底、LLM 路由器、点播旁路之前），否则用户说"太吵了"会先被 LLM 路由器判 none 落到 DJ 闲聊、不会换歌。
- 反向回写不写新代码的判断依据：现有 `playback_completed`（+1.5）+ `playback_interrupted`（-0.5~-2）+ `avoid_signal`（-1.5）已能完整覆盖 similar 路径的反馈；再加新事件会出现"自己扣自己"的双重计分问题。

### Technical Decisions
| Decision | Rationale |
|----------|-----------|
| MOOD_KEYWORD_HINTS 18→28 组，纯增量补词 | 0 侵入原 9 个 action + LLM 路由器 prompt；高 ROI |
| 拆"情绪上扬"为 3 组（嗨/燃/炸），weight 5 | 细分语义：嗨=开心推力、燃=上头、炸=重型；同 weight 不冲突，命中时按"先遍历后取最大"自然取首 |
| "否定/喜好"组扩"避开/排斥/听腻/腻了/不喜欢" | 反向语义，但 mood 兜底只走 regenerate+messageHint；avoid 实际触发由 `resolveAvoidIntent` 专责 |
| `similar` 跟 `play-*` 一样走 chat-agent 旁路，不进 9 个 action 列表 | 跟"重排推荐 LIST"在用户感知上像，但**不**写 feedbackBias；写专门的 `similar_request` 事件 +1.2 弱信号 |
| `avoid-current` 旁路位置在 Layer 1 后立即判（比 mood 兜底还早） | avoid 跟"换歌"是 1:1 映射；必须短路所有路由，直接换歌 + 写负反馈 |
| `avoid-current` online 模式走 fresh + excludeCurrent + excludeQueue，**不**走 regenerate | avoid 是"换方向"语义，regenerate 会回到类似区，fresh 才真换 |
| local 模式 avoid fallback 到 `applyChatIntentWithProgram({action:"skip"})` | 保留 skip 是合理的"换一首"语义；local 模式没有 messageHint 智能优先能力 |
| `extractMessageHints` 派发词加"避开/不要/排斥/类似/延续/保持/继续" | 让 avoid / similar 构造的 messageHint 在搜索端被识别成 hints；不写新提取函数，零漂移风险 |
| time 注入 LLM 路由器 prompt 不动 router 内部逻辑 | 路由器对外契约不变；time 信息只作为额外上下文 |
| `PreferenceEvent.reason?: string` 字段 | avoid_signal 携带结构化原因"用户觉得太吵，避开高能量"，未来可观测 / 可反馈学习 |
| 走 chat-agent 旁路而不是扩展 `resolveChatIntent` | 9 个 action 列表是关键词枚举；semantic 任务（similar/avoid）应该旁路隔离，避免污染 |
| 0 侵入：原 9 个 action 链路 / 控件旁路 / 点播旁路 / 9 个 music-control intent / LLM 路由器 prompt 结构 | 全部 1 行不动，新功能纯加法 |

### Issues Encountered
| Issue | Resolution |
|-------|------------|
| 第一版 plan 提"动 LLM 路由器 prompt"做 time 注入 | 实际只需要在 prompt 末尾追加 2 行 + 1 行时间变量；不动 router 内部逻辑，0 风险 |
| similar 路径要不要调 `applyOnlineFeedbackAndBuildProgram("familiar")` | 不调 — familiar 是 schedule block 微调；similar 是"基于当前曲找新曲"，跟 familiar 语义正交；用 regenerate + messageHint 智能优先 |
| avoid 信号要不要写进 `negativeSignals` 而不是 `avoid_signal` event | negativeSignals 是聚合产物（PreferenceModel），不是原始事件；写原始事件后由 `buildPreferenceModel` 聚合（scoreEvent 已经是 -1.5，会自然进 negativeSignals） |
| similar 跟 avoid 反向回写要不要做特殊计分 | 不做；现有 playback_completed / playback_interrupted / avoid_signal 流已经能区分正向/负向，加新计分会出现"自己扣自己" |
| patcher 警告"re-read before overwrite" | LSP cache 陈旧已知，以 `npx tsc --noEmit` 0 error 为准 |

## Session: 2026-06-03 (Phase 15: LIST 展开区挪到 QUEUE 区域 + top3 候选卡渲染)

### 增量要求
- LIST 按钮弹出的"当前段歌单"渲染位置从 chatLog 内联挪到 queueHeader 正下方，跟播放队列预览视觉对齐
- 旧 `.queueOverlay` 卡片组（带边框/圆角/meta/badge）作为**样式来源保留**给 top3 候选卡复用
- assistant 气泡内挂 `message.meta?.pendingCandidates` 渲染 top3 候选卡（**复用旧 .queueCard 卡片样式**：fit-content 宽度、★ 图标位置换成 `1/2/3` 序号、title+artist 两行；不显示 meta/badge 因为 pendingCandidates 不带这俩字段）
- 候选卡点击走 `setChatInput(cand.title) + void sendChatMessage()`，触发后端 `matchPendingCandidate` 现有链路
- 0 侵入：后端 chat-agent / route / play-request-executor / preference-learning **全部 1 行不动**，只是把已有 `meta` 字段可视化

### Research Findings
- 旧的 `.queueOverlay` 渲染位置是 chatLog 之后 inputDock 之前（行 2484-2522），从产品语义上"插播在聊天流里"是 OK 的，但截图明显表达"歌单是播放区的一部分、不是聊天流的一部分"。挪到 queueHeader 下面更符合"播放队列预览"的视觉层级。
- 旧 `.queueCard` 按钮卡样式（带边框圆角、3 行 title/artist/meta/badge）和截图里的紧凑行（无边框、左序号中标题右艺术家）**完全不是一种视觉**。不能用同一份样式两边复用——必须新写一套 `.queueListRow` 紧凑行。
- top3 候选后端早就透传了 `meta.pendingCandidates`（Phase 6），但前端从来没渲染过，user 看到的是 assistant 文本里 `1.《X》2.《Y》3.《Z》` 纯文本。新加候选卡 UI 复用后端 `matchPendingCandidate` 识别（"1/2/3/歌名/就这首/中间那首"），点击把对应歌名塞进 `chatInput` 再调 `sendChatMessage()` 就走通了。
- `queueOverlayRef` 在新位置（queueHeader 下面）依然挂上，展开时 `scrollIntoView({block:"center"})` 让长聊天也能滚到歌单位置——只是滚到的目标从 chatLog 内部的卡片组变成了 queueHeader 下方的独立区域。

### Decisions Made
| Decision | Rationale |
|----------|-----------|
| LIST 按钮位置保持 transport 区不动 | 用户原话"点击LIST按钮也是展开折叠或收起"——toggle 触发器是 LIST 按钮，触发后渲染位置是 QUEUE 区域 |
| 旧 `.queueOverlay` 整段删除，不保留 .queueOverlay 引用 | 引用全在 .queueOverlay 自己定义的位置，删掉后没人会引用；保留是死代码 |
- 旧 `.queueCard` 样式**不删**（注释行 2233 已经标记"旧版，先保留"） | 候选项（assistant 气泡内）现在复用这套样式——fit-content 宽度、序号图标的圆形、title+artist 视觉，**正好是产品要保留的"聊天播放列表"那种卡片感** |
| 候选卡复用 `.queueCard`（旧 chatLog 卡片样式）而不是新写 `.queueListRow` 紧凑行 | 用户原话"聊天的播放列表 ui 样式保留 给聊天点播返回的 top3 数据显示 ui"——保留视觉就是保留 `.queueCard` 那种按钮卡感（fit-content 宽度、序号圆形图标、title+artist 两行），不是"无边框紧凑行" |
| 候选卡点击走 `setChatInput(cand.title) + sendChatMessage()` | 不需要新写点击 handler——直接把候选歌名作为 user input 提交，后端 `matchPendingCandidate` 早就识别裸歌名 |
| 候选卡**不**标 `.queueListRowActive` 高亮 | active 是"正在播"语义，候选不是"正在播"；保留视觉差异让用户知道这是"待选" |
| 0 侵入：后端链路 / 原 9 个 action / radio-engine / online-radio / preference-learning | 全部 1 行不动；纯前端 UI 重构 + meta 可视化 |

### Issues Encountered
| Issue | Resolution |
|-------|------------|
| 候选卡点击 handler 想绕开 chatInput state 直接调 sendChatMessage | 走 setChatInput 同步 state 后调 sendChatMessage；行 1824 读 chatInput、行 1844 清空 state，符合现有链路，零侵入 |
| `.queueListOverlay` 渲染在 `.panel` 之外（panelContent 内部），亮色主题覆盖用 `.pageLight` 而不是 `.panelLight` | 跟 .dayListBackdrop 一样的 ancestor 链规则，统一用 .pageLight |
| 候选卡 key 用 `${artist}-${title}-${index}` 而不是 stable id | backend pendingCandidates 不带稳定 id 字段（只有 artist+title 字符串），用这两个 + index 当 React key 即可 |

### Test Results
| Test | Expected | Actual | Status |
|------|----------|--------|--------|
| `npx tsc --noEmit` | 0 error | 0 error | Passed |
| 旧 `.queueOverlay` / `.queueCard` 在 player-shell.tsx 引用数 | 0（除 .module.css 定义本身） | 0 | Passed |
| `.queueListRow` 视觉对齐截图（无边框 / 左序号 / 中标题 / 右艺术家） | 一致 | 一致 | Passed (需手动确认) |

### Resources
- `src/components/player-shell.tsx`（增量：旧 .queueOverlay chatLog 内联块整段删；新 .queueListOverlay 渲染块挪到 queueHeader 下方；assistant 气泡内挂 message.meta?.pendingCandidates 渲染 top3 候选卡）
- `src/app/page.module.css`（增量：行 1408-1500 新加 .queueListOverlay / .queueListRow / .queueListRowIndex / .queueListRowTitle / .queueListRowArtist / .queueListRowActive + .pageLight 亮色覆盖；旧 .queueOverlay 块保留定义但 player-shell.tsx 0 引用）

### Resources
- `src/lib/chat-agent.ts`（增量：MOOD_KEYWORD_HINTS 18→28 + resolveSimilarIntent + resolveAvoidIntent + runChatAgent 2 个新旁路 + 2 个新 ChatAgentState 短路 return + time 变量在 prompt）
- `src/lib/types.ts`（增量：ChatIntentAction 加 `similar` / `avoid-current`）
- `src/lib/preference-learning.ts`（增量：PreferenceEvent.type 加 `similar_request` / `avoid_signal`，scoreEvent 给两个新事件打分，reason? 字段）
- `src/lib/online-radio.ts`（增量：applyOnlineChatIntent 加 `similar` / `avoid-current` 两个分支；extractMessageHints directPhrases 扩"避开/类似/延续"等）
- 单元测试脚本：临时 `/tmp/probe_mood_similar_avoid.mjs`（已删，跑通 75/75 后清理）

## Session: 2026-06-03 (Phase 15)

### Resources
- `src/components/player-shell.tsx`（增量：旧 .queueOverlay chatLog 内联块整段删；新 .queueListOverlay 渲染块挪到 queueHeader 下方行 2397；assistant 气泡内挂 message.meta?.pendingCandidates 行 2493 渲染 top3 候选卡）
- `src/app/page.module.css`（增量：行 1408-1500 新加 .queueListOverlay / .queueListRow / .queueListRowIndex / .queueListRowTitle / .queueListRowArtist / .queueListRowActive + .pageLight 亮色覆盖；旧 .queueOverlay 块保留定义但 player-shell.tsx 0 引用）

## Session: 2026-06-03 (Phase 16)

### 增量要求
- 候选卡点击必须不二次搜索，直接复用上一轮搜索命中
- 点击时仍要重新解一条 fresh 播放直链，不能长期复用旧短链
- `换` 必须按上一轮候选自己的 seed 刷新，不允许偷拿第一首歌手
- `换 / 1 / 2 / 3 / 这首` 这类候选上下文短指令，优先级必须高于 online freeform LLM 路由
- 排查 loading / SSE / history 丢状态时，必须能只看 `/tmp/radio-app-dev.log` 就串起全链路

### Research Findings
- 候选卡原来的失败点不是 `/api/song-playback` 本身，而是“候选只带 `{artist,title}`，前端点击后再走一遍 QQ 搜索”。这会出现“搜索页能播、候选卡又搜不到”的分叉。
- 把 `playbackUrl` 在候选生成时缓存给前端，也不是终解。第三方直链是短时资源，候选生成时能播，不代表用户几秒后点击时还有效；这正是 `audio element.error` 的根因之一。
- `换` 一度按 `pending[0].artist` 重搜，这对“来点慢摇/来点民谣/来点晚安歌”这类 seed 请求完全错语义。刷新锚点必须是“上一轮候选自己的 seed”，不是第一首歌手。
- 日志证明某次 `换` 请求只有 `[agent] request.start`，却没有 `[chat-agent] play-request.detected`。这说明请求在 `runChatAgent()` 里、到 `resolvePlayRequest()` 之前就被卡住了。根因是 online 模式下先跑了 freeform LLM 路由，候选上下文短指令被错误地放在后面。
- 继续追发现，`换` 有时还是不命中 refresh，不是后端判断错，而是前端发过去的 `history` 已经丢了上一轮 `pendingCandidates/pendingSeed`。原因是 `sendChatMessage()` 用的是滞后的 `chatHistory` state 闭包，而不是最新 ref。
- 浏览器 console 和服务端 dev 输出原本是两套断开的日志面；排 SSE/前端 state 问题时，仅看服务端文件不够。加一个本地 debug route 镜像浏览器关键日志，才能在 `/tmp/radio-app-dev.log` 里按 requestId 贯通。

### Technical Decisions
| Decision | Rationale |
|----------|-----------|
| `pendingCandidates` 升级成完整 `PendingCandidateHit[]` | 候选点击播放需要完整 `MusicSearchHit/raw`，不应再靠 `{artist,title}` 回头重搜 |
| 候选卡点击不二次搜索，但仍重新解 fresh 直链 | 搜索命中是稳定上下文，播放 URL 是短时资源；两者职责必须拆开 |
| 候选消息新增 `pendingSeed` | refresh 必须绑定上一轮真实 seed，而不是偷用第一首歌手 |
| `resolvePlayRequest()` 前移到 online freeform LLM 路由之前 | 候选上下文短指令必须先短路，不允许先掉进 `inferOnlineFreeformIntent()` |
| 候选可播验证并发化，只扫描前 12 个候选 | refresh/loading 的主要开销在逐首解链和验链；并发验证能显著缩短等待时间 |
| `chatHistoryRef` 作为发送时的真实 history 来源 | React state 闭包会滞后一拍；候选 meta 一旦丢，`换/1/2/3` 就会退化成普通聊天或普通切歌 |
| 新增 `/api/debug-log` 镜像浏览器日志 | 统一看 `/tmp/radio-app-dev.log` 就能按 requestId 追到前端和后端同一次请求 |
| `/api/agent` provider fetch 必须有 45s 超时 | provider 卡住时，不应该让前端 SSE 一直 loading |

### Issues Encountered
| Issue | Resolution |
|-------|------------|
| 候选卡点击“不重搜”后，直接复用旧 `playbackUrl` 导致短链过期，浏览器报 `audio element.error` | 点击时继续直接透传完整 hit，但重新调 `/api/song-playback` 解析一条 fresh URL |
| `换` 一直回到第一首歌手的歌 | 改为 assistant 候选消息写入 `pendingSeed`，refresh 一律按 seed 重搜 |
| `换` 某些场景卡在 loading，没有进入 `play-request` 日志 | `resolvePlayRequest()` 前移到 online freeform LLM 路由之前 |
| `换` 某些场景直接切歌，不出新候选 | 前端 `history` 丢了上一轮 meta；加 `chatHistoryRef`，并在 assistant-meta/flush/abort/error 分支同步更新 ref |
| 只看浏览器 console 或只看服务端日志都不够 | 新增 `/api/debug-log`，镜像 `[chat]` 关键日志到服务端输出 |

### Resources
- `src/lib/types.ts`
- `src/lib/play-request-executor.ts`
- `src/lib/chat-agent.ts`
- `src/components/player-shell.tsx`
- `src/app/api/agent/route.ts`
- `src/app/api/debug-log/route.ts`
