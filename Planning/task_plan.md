# Task Plan: Claudio 懂我的音乐 Agent 主线

## Goal
把 Claudio 做成一个懂我的音乐 Agent：
- 通过用户的真实偏好数据持续学习
- 通过学习结果不断推荐用户更愿意听下去的歌
- 允许用户通过随意自然语言聊天自由切换不同风格的歌
- 形成“行为采样 -> 事件打点 -> 偏好建模 -> 推荐匹配 -> 再反馈”的稳定闭环

## Current Phase
Phase 5

## Phases

### Phase 1: Requirements & Discovery
- [x] Understand user intent
- [x] Identify constraints
- [x] Document in findings.md
- **Status:** completed

### Phase 2: Planning & Structure
- [x] Define approach
- [x] Create project structure
- **Status:** completed

### Phase 3: Implementation
- [x] Execute the plan
- [x] Write to files before executing
- **Status:** completed

### Phase 4: Testing & Verification
- [x] Verify requirements met
- [x] Document test results
- **Status:** completed

### Phase 5: Delivery
- [x] Review outputs
- [ ] Deliver to user
- **Status:** in_progress

### Phase 6: 显式点播旁路（2026-06-02 增量，兼容原主线）
- [x] 识别"播/放/来首/想听/切到 + 歌手"形态走 play-artist 候选提问
- [x] 识别"X 的 Y / 《Y》- X"形态走 play-song-by-artist 真点播
- [x] 候选候选匹配（"1/2/3" 序号、歌名、第 N 首、就这首、中间那首、最后一个）
- [x] 候选数据通过 SSE type:"assistant" 帧 + meta.pendingCandidates 透传前端 chatHistory
- [x] 不动原 9 个 action 链路（radio-engine / online-radio / preference-learning 全 0 改动）
- **Status:** completed

### Phase 7: 聊天触发播放器控件（2026-06-02 增量）
- [x] 暂停 / 继续 / 重播 / 音量（绝对值 + 相对调整）4 个 action
- [x] chat-agent 头部最优先旁路（先于 resolveAgentState / play-request 旁路 / LLM 路由器）
- [x] radio-engine.resolveChatIntent 加 4 个新分支（pause / resume / replay / set-volume 绝对值）
- [x] player-shell.tsx 统一动作层（playerActionsRef）— 聊天 SSE control 帧和按钮 onClick 走同一份 pauseAudio / resumeAudio 实现
- [x] SSE type:"control" 帧透传（route.ts + 前端 player-shell.tsx 解析）
- [x] 不动原 9 个 action 链路（favorite / skip / regenerate / ...），不写 preference_event，不动 program
- **Status:** completed

### Phase 8: 候选列表"换一批"重搜（2026-06-02 增量）
- [x] `换` / `换一批` / `换一下` / `再来点` / `还有吗` / `别的` 等关键词 + 上一条是 candidateList → 旁路接管
- [x] play-artist 模式下重搜同一歌手 top 3，excludeKeys 排除上一轮已展示候选
- [x] 无候选上下文时"换"fall through 到 LLM 路由器 / 原 9 个 action 链路
- [x] 不动原 9 个 action（regenerate 关键词仍由 radio-engine.resolveChatIntent 命中）
- [x] assistant 文本用"X 的其他歌，刷新一下："区别于首轮"X 的歌，你想听哪首？"
- [x] 重搜搜不到时回 "我这儿就这几首 X 的歌了" 区别于首轮"我这儿没搜到 X"
- **Status:** completed

### Phase 9: LLM 路由器 + mood keyword 兜底（2026-06-02 增量）
- [x] LLM 路由器 `inferOnlineFreeformIntent` 喂 `preference insights` + 输出 `messageHint`（在 prompt 里加 4 个偏好段 + 3 个 hint 例子）
- [x] chat-agent 加 `MOOD_KEYWORD_HINTS` 18 组关键词（情绪/风格/时刻/否定 4 类信号）
- [x] chat-agent 加 `inferFromMoodKeywords()`：LLM 判 none 时纯函数兜底，不调 LLM
- [x] 命中后构造 `mode:"music-control" + intent:{action:"regenerate", messageHint}`，走原 `applyOnlineChatIntent` 链路
- [x] `IntentResolution` 联合类型加 `"mood-keyword"`，preference-learning `resolver` 联合类型同步加
- [x] 18/18 单元测试通过：13 个 mood 表达（累/想家/嗨/夜深/暖/慵懒/轻快/早上/下雨/静/燃/烦躁/想家的歌）→ `regenerate + messageHint`；5 个非 mood（"你麻痹"/"你好"/"今天天气不错"/"我想听个故事"/"刘德华"）→ null
- [x] 0 侵入：原 9 个 action、radio-engine、online-radio、preference-learning、LLM 路由器 prompt **一字不动**
- **Status:** completed

### Phase 10: mood 关键词扩词（2026-06-03 增量）
- [x] `MOOD_KEYWORD_HINTS` 18 组 → 28 组
- [x] 拆"情绪上扬"为 3 组（嗨/燃/炸，weight 5）
- [x] 新增"炸/爆炸/炸裂/硬核/暴力"（weight 5）
- [x] 新增"嗨翻/带感/飞起/上头/劲爆/推力/冲劲/够劲"扩到原"燃"组
- [x] 新增"浪漫/甜蜜/甜歌/文艺/诗意/走心/动人"（weight 4）
- [x] 新增"怀旧/复古/y2k"（weight 4）
- [x] 新增"困/想睡/助眠/催眠"（weight 3）
- [x] 新增"跑步/运动/健身/撸铁/有氧"（weight 4）
- [x] 新增"工作/写代码/专注/干活/学习"（weight 3）
- [x] 新增"吃饭/聚餐/派对"（weight 3）
- [x] "听腻/腻了/不喜欢/避开/排斥"扩到 avoid 兜底组
- [x] 30/30 单元测试通过
- **Status:** completed

### Phase 11: similar action（2026-06-03 增量）
- [x] `ChatIntentAction` 加 `similar`
- [x] `resolveSimilarIntent` 识别 14 个关键词（再来点这种/类似的/和这首一样/保持这种/继续这种/就这种/再来一首/多来点这种/还有这种吗/类似的歌/同类型/类似风格/再来点/类似的）
- [x] chat-agent chat mode 旁路：构造 `messageHint = "类似 ${artist} ${title}，风格延续，标签：t1,t2,t3"`
- [x] 写 `similar_request` preference event（+1.2 分）
- [x] `applyOnlineChatIntent` 加 `similar` 分支 → `regenerateOnlineRadioProgram({action:"regenerate", messageHint, excludeTrackIds:[currentTrack.id]})`
- [x] local 模式 fallback 到原 9 个 action `regenerate`
- [x] 19/19 单元测试通过
- **Status:** completed

### Phase 12: avoid-current action（2026-06-03 增量）
- [x] `ChatIntentAction` 加 `avoid-current`
- [x] `resolveAvoidIntent` 识别 17 种"太 + 形容词" + 6 种"显式不要"
- [x] chat-agent chat + music-control 双 mode 都判（最优先，比 mood 兜底还早）
- [x] 写 `avoid_signal` preference event（-1.5 分）+ `reason` 结构化原因
- [x] online 模式：`applyOnlineChatIntent({action:"avoid-current"})` → `regenerateOnlineRadioProgram({action:"fresh", messageHint, excludeTrackIds:[currentTrack.id, ...queue]})`
- [x] local 模式 fallback 到 `applyChatIntentWithProgram({action:"skip"})`
- [x] `extractMessageHints` 派发词加"避开/不要/排斥/跳过/换掉"
- [x] 26/26 单元测试通过
- **Status:** completed

### Phase 13: time 注入 LLM 路由器 prompt（2026-06-03 增量）
- [x] `inferOnlineFreeformIntent` 加 hour/dayOfWeek/timeOfDay/isWeekend 变量
- [x] timeOfDay 6 段切分：早高峰/午休/下午/晚间/深夜
- [x] prompt 末尾追加"实际时间"行
- [x] 新增 2 条路由器规则：时间敏感（早高峰清新提神/深夜低能量）+ 周末感知
- [x] 0 侵入：路由器对外契约、JSON schema、action 列表 全部不动
- **Status:** completed

### Phase 14: similar 反向回写（2026-06-03 增量）
- [x] 不写新代码：靠现有 `playback_completed`(+1.5) + `playback_interrupted`(-0.5~-2) + `avoid_signal`(-1.5) 覆盖
- [x] similar_request(+1.2) + playback_completed → 正向累加
- [x] similar_request + playback_interrupted → 抵消，模型能学到"这次不像"
- [x] similar_request + avoid_signal → 体现"既要类似的又怕吵"精细口味
- [x] 注释进 chat-agent.ts 说明闭环路径
- **Status:** completed

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| 首页是当前第一主战场 | "懂我的音乐 Agent"最先要在首页推荐与聊天闭环里成立 |
| 先强化数据闭环，不先堆零散功能 | 没有稳定采样、建模、反哺，再多按钮也不会更懂用户 |
| 聊天必须成为自由切风格入口 | 用户应该随口一句"来点抒情的"就能触发新一轮 LIST，而不是记命令 |
| 采用时间衰减 + 场景分层 + 负反馈反哺 | 这是当前代码结构里性价比最高、最接近真实口味变化的路径 |
| 首页学习核心做稳后，再逐步迁 Claudio live | 避免在 live 侧重复发明一套独立偏好逻辑 |
| 推荐和播放必须拆职责 | 推荐只产出歌曲内容，在线播放统一通过 `/api/song-playback` 解析真实可播地址 |
| 显式点播走 chat-agent 旁路，**不进入** 9 个 action 列表 | 点播是"切到指定歌"语义，跟推荐重排/偏好反馈正交，混进原 action 会污染 preference_event 流和 radio-engine feedback 链 |
| 候选数据走 SSE `meta.pendingCandidates` 透传 | 比 LLM 读 history 文本猜歌名准 100 倍；前端 placeholder 收到 assistant 帧后写进 chatHistory，下一轮 user 选歌时原样发回后端匹配 |
| 裸 query "1/2/3" 走 `lastPendingCandidates` 匹配 | 避免给 LLM 路由器引入"上一条是候选列表"这种语义识别，前端 ChatMessage 已有结构化 meta 可用 |
| 真点播 top vs second 差 ≤ 2 时**仅在 title 完全不 match** 才 fallback 候选 | 用户明确说"刘德华 练习"时被同名版本"练习 (Live)"顶回候选列表等于无响应；title 已精确匹配时直接切 |
| 控件类动作（暂停/继续/重播/音量）走 chat-agent 头部**最优先**旁路，不进 9 个 action 列表 | 这些动作是"操作 audio 元素"，跟"改推荐 LIST"语义完全正交；混进 9 个 action 会污染 preference_event 和 feedbackBias 累加链 |
| 聊天 control 帧和按钮 onClick 走 player-shell.tsx 内部**统一动作层**（playerActionsRef） | 一处实现两处入口，未来扩"上一首/下一首/收藏/下载"进聊天控制时直接加进 PlayerActions 类型，零额外分散代码 |
| 音量 step = 0.1（10%），clamp 0-1；"音量 N" 绝对值走 setVolumeTo(N/100) | 跟现有 audio 元素 volume API 一致；前端 audioRef.current.volume 已是 0-1 范围 |
| "换一批" 走 play-artist refresh 模式，**只在** lastPendingCandidates 命中时 | 用户在 candidateList 上下文里说"换" = 想换该歌手的其他歌；无候选上下文时让原 9 个 action 的 regenerate 接管（避免语义串台） |
| refresh 模式用 `excludeKeys: Set<"artist::title" 标准化 key">` 透传给 executor | 复用 executor 内部 `normalizeText` 规则作为去重 key；不在 chat-agent 里复制一份 normalize 函数，避免规则漂移 |
| assistant 文本区分首轮 vs 刷新：首轮"X 的歌"、刷新"X 的其他歌，刷新一下" | 文本给用户明确反馈：当前是"看到新的"还是"回到旧的"；防止误以为系统没动 |
| LLM 路由器喂 `preference insights` + 输出 `messageHint`，走"LLM 智能优先"路径 | 把 Phase 5 已有的 messageHint 通道从单点（点播用）扩成"LLM 路由器直出"通用；让 online-radio.applyOnlineChatIntent 走智能优先，吃到 insights + sceneProfile + 实时口味 |
| LLM 路由器对 mood 表达偏 none 时，chat-agent 加 `MOOD_KEYWORD_HINTS` 18 组关键词兜底 | 实测 LLM 路由器对"今天有点累/想家了/嗨一点" 等 mood 表达 100% 判 none，messageHint 字段不被使用 → 链路失效。keyword 兜底**纯函数、不调 LLM**，命中后构造同构 `regenerate + messageHint` 产物复用原链路 |
| `MOOD_KEYWORD_HINTS` 用 4 类信号 + weight 5/4/3/2 分级：情绪(5) / 风格(4) / 时刻(3) / 否定(2) | 情绪类比风格类更明确（"累" vs "慢"），时刻类（"夜深了"）是弱信号（可能用户在描述不是请求），否定类（"不想听"）最弱（无法判断用户具体不想要什么） |
| 兜底命中后用 `mode:"music-control" + intent:{action:"regenerate", messageHint}` | 跟 LLM 路由器命中的产物**同构**，走同一条 `applyOnlineChatIntent` 链路，不为 fallback 单独写 apply 函数 |
| `IntentResolution` 联合类型加 `"mood-keyword"` 标识 | 跟 `rule` / `llm` 并列，写进 `intent_resolved` 事件；后续可观测"LLM 路由器判 none 率" / "fallback 命中率" / "fallback 后用户对推荐的接受度" |
| keyword 库不接 LLM 自动扩词、不做多 keyword 复杂合并、不命中时不主动追问 | Phase 9 只补 mood 直觉式表达（"今天有点累" = 想听柔和的）；复杂语义（"我想听一首能让我想起 17 岁夏天的歌"）仍交给 LLM 路由器；保持 fallback 是"简单稳定兜底"定位，避免复杂度爆炸 |

## Errors Encountered
| Error | Resolution |
|-------|------------|
