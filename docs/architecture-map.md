# 项目速查表

整个项目核心模块的索引：函数 / effect / ref 的位置、用途、关键设计取舍。
**代码里每一项都有更详细的 JSDoc**，本表只做导航。

## 模块分布

| 模块 | 文件 | 角色 |
|---|---|---|
| 前端壳 | `src/components/player-shell.tsx` (1280 行) | 整个 UI + 所有按钮 / 输入 / 流式接收 |
| 中央节目生成器 | `src/lib/radio-engine.ts` | 把曲库+画像+schedule+memory 装配成 RadioProgram |
| 每日歌单层 | `src/lib/daily-schedule.ts` | 4 段歌单的生成 / 持久化 / 游标操作 |
| LLM 封装 | `src/lib/providers/llm.ts` | 所有 Hermes 调用 + 本地模板兜底 |
| 聊天 Agent | `src/lib/chat-agent.ts` | 意图分发 + 工具调用 + Hermes 消息装配 |
| SSE 代理 | `src/app/api/agent/route.ts` | 聊天流式接口 |
| 音频代理 | `src/app/api/audio/route.ts` | 本地音乐文件白名单 + Range 请求 |
| 歌单重生成 | `src/app/api/regenerate-schedule/route.ts` | ⌁ 按钮接口 |

## player-shell.tsx 速查

> 行号会随编辑漂移，定位时优先按符号名搜索，行号仅作参考。

## 速查表

| 行号 | 符号 | 类型 | 一句话 | 关键点 |
|---|---|---|---|---|
| 270 | `chatAbortRef` | ref | 正在进行的聊天请求 AbortController | 用户重发时 abort 旧请求 |
| 285 | `shouldResumePlaybackRef` | ref | **自动播放开关** | 设 true → setProgram → audioSource useEffect 自动 .play() |
| 303 | `streamingMessageId` | derived | 流式中的 assistant 气泡 id | 用来在气泡尾追加 loading 指示 |
| 322 | audioSource useEffect | effect | **自动播放唯一出口** | pause → load → 看 ref 决定是否 play → 复位 ref |
| 374 | volume useEffect | effect | UI 音量同步到 audio 元素 | — |
| 384 | chatPollTimer cleanup | effect | 残留旧机制清理 | 当前无写入点，可清理 |
| 401 | rewrite-reasons useEffect | effect | 推荐语懒加载润色 | 切段或换歌单时自动调 /api/rewrite-reasons |
| 469 | **`requestProgram`** | fn ⭐ | **中央请求器**，所有按钮（除聊天）入口 | 5 步副作用顺序：error / label / fetch / state / history |
| 519 | `togglePlayback` | fn | ▶ 圆按钮播放/暂停 | 主动复位 resume flag，防偷偷续播 |
| 552 | `playPreviousTrack` | fn | 上一首 | 纯前端 history 栈，不走后端 |
| 591 | `replayCurrentTrack` | fn | 当前曲回 0 重播 | — |
| 601 | `playNextTrack` | fn | 下一首 | keepPlaying=true 恒续播 |
| 612 | `sendFeedback` | fn | SKIP / FRESH / CALMER / FAMILIAR | 更新 memory.feedbackBias |
| 626 | `selectQueueTrack` | fn | 跳到 queue 任意一首 | 移动 currentTrackIndex |
| 663 | `regenerateSchedule` | fn | ⌁ 按钮重生成一天歌单 | keepPlaying=true 强制开播新轨 |
| 706 | `importLocalLibrary` | fn | 底部读取本地曲库 | mode:"replace" 会覆盖手动调整 |
| 717 | **`sendChatMessage`** | fn ⭐ | **聊天主流程**，8 步 SSE 接收 | abort 重发 + 30ms 批量 flush + loading 指示 |
| 731 | flush 窗口 | const | 流式 token 批量提交 | 30ms（调优表见代码注释） |

## 两条核心数据流

### 自动播放链路

谁触发都最终汇聚到 audioSource useEffect：

```
触发源（regenerateSchedule / 聊天 SSE state / playNext / sendFeedback / ...）
  ↓ 设 shouldResumePlaybackRef.current = true
  ↓ setProgram(新 program)
  ↓ program.currentTrack.sourcePath 变
  ↓ audioSource useMemo 重算
  ↓ audioSource useEffect 触发
  ↓ pause → load → ref?.play() → 复位 ref
```

调试时搜 `shouldResumePlaybackRef` 顺着引用就能拉出完整链。

### 聊天流式接收链路

```
sendChatMessage()
  ↓ chatAbortRef.abort() 取消旧请求
  ↓ 新 controller，POST /api/agent SSE
  ↓ 服务端先吐 type:"state" 事件 → setProgram / setSchedule
  ↓     （若 currentTrack.id 变了，设 shouldResumePlaybackRef = true）
  ↓ 然后吐 Hermes token：累积到 pendingContent
  ↓ 30ms 内合并 setChatHistory 一次 → 避免每 token 全量重渲染
  ↓ [DONE] 或 reader.done → 收尾 flushPending
  ↓ AbortError → 悄悄清占位符
```

## radio-engine.ts 速查

| 符号 | 类型 | 一句话 |
|---|---|---|
| 文件头 | 文档 | 中央节目生成器，5 个 API 路由入口、3 个下游依赖、2 条主路径 |
| `buildRadioProgram` | fn ⭐ | 主入口：无 options 走轻量路径，带 forceRandom/pinned/period 走重路径 |
| `buildProgramFromDailySchedule` | fn | 轻量路径：直接读 schedule，仅调一次 LLM 串词，<1s |
| `applyFeedbackAndBuildProgramWithOptions` | fn | 反馈主流程 6 步：累加 bias → writeMemory → 重排或随机 → 记 recent |
| `advanceProgramRandomly` | fn | 下一首：advanceDailyScheduleTrack + 更新 recentTrackIds |
| `selectTrackProgram` | fn | 跳到指定 track + 更新 recent |
| `resolveChatIntent` | fn ⭐ | 意图分类器（关键词匹配，**不用 LLM**），6 级优先级 |
| `applyChatIntentWithProgram` | fn | 意图执行器：scene-change/feedback 各自分派 |
| `scoreSong` | fn | 评分核心：偏好 +4 / 最近播 -6 / 锚点 +5 / feedbackBias 偏移 |

## daily-schedule.ts 速查

| 符号 | 类型 | 一句话 |
|---|---|---|
| 文件头 | 文档 | schedule 持久化 + 操作层，函数分 5 类（读写/生成/定位/游标/重排） |
| `generateDailySchedule` | fn | 4 段生成，每段数量随机，**不调 LLM**（速度优先） |
| `regenerateDailySchedule` | fn | ⌁ 按钮入口：generate + write |
| `readDailySchedule` | fn | 读盘 + normalize，过期 / 损坏自动重生成 |
| `advanceDailyScheduleTrack` | fn | 游标 +1，到段尾跳下段，到日尾回卷 |
| `selectScheduledTrack` | fn | 在 4 段里搜 trackId 移游标 |
| `switchDailySchedulePeriod` | fn | 切到指定时段，currentTrackIndex 归零 |
| `rewriteCurrentScheduleBlock` | fn | 重写当前段（保护已播部分），应用 fresh/calmer/familiar |
| `resolveCurrentScheduleBlock` | fn | currentBlockPeriod 优先，回落 hour 推断 |
| `getCurrentScheduledTrack` | fn | 拿当前段当前曲 + 剩余 queue |

## providers/llm.ts 速查

| 符号 | 类型 | 一句话 |
|---|---|---|
| 文件头 | 文档 | 所有 Hermes 调用集中地，按"推荐语 / 串词 / 聊天 / 推荐数"分类 |
| `rewriteTrackReason` | fn | 单首推荐语，~1s，失败回 buildFallbackTrackReason |
| `batchRewriteTrackReasons` | fn ⭐ | 批量一次 LLM 调用，60s 超时，**不能并发**否则 Hermes 挂 |
| `composeHostIntro` | fn | 开场串词，**本地模板**不调 LLM，<1ms |
| `buildRuleBasedDjReply` | fn | 纯规则 DJ 回复，0ms，作为 Hermes fallback |
| `buildHermesDjMessages` | fn | 装配 system + history + user 给 Hermes |
| `describeAgentState` | fn | agent 执行结果压成一句话喂模型 |
| `recommendBlockTrackCount` | fn | 每段歌曲数：场景基线 + ±2 抖动 |

## chat-agent.ts 速查

| 符号 | 类型 | 一句话 |
|---|---|---|
| 文件头 | 文档 | /api/agent 唯一入口，3 种 mode（weather/music-control/chat） |
| `runChatAgent` | fn ⭐ | 主流程：判定意图 → 调工具 → 装配 messages |
| `resolveAgentState` | fn | 意图判定，决定 mode |

## API 路由速查

| 路由 | 关键点 |
|---|---|
| `POST /api/regenerate-schedule` | ⌁ 按钮，~1s（不调 LLM） |
| `POST /api/agent` | 聊天 SSE，先吐 state 帧再透传 Hermes token |
| `GET /api/audio` | 白名单 + Range 请求 + 长期缓存 |
| `POST /api/next-track` | advanceProgramRandomly |
| `POST /api/feedback` | applyFeedbackAndBuildProgram |
| `POST /api/select-track` | selectTrackProgram |
| `POST /api/rewrite-reasons` | 懒加载润色当前段推荐语 |
| `POST /api/import-library` | 全量扫描本地音乐目录写 songs.json |

## 常见调试入口

- **点 ⌁ 没反应** → 看 `requestProgram` catch 分支 + Network 面板
- **新歌单出来不自动播** → 搜 `shouldResumePlaybackRef`，看 audioSource useEffect 是否走到 play
- **聊天卡顿** → 调整 flush 窗口（30ms ↑ ~50ms），或检查是否 startTransition 误用
- **发送按钮锁死** → 看 `isChatSending` 状态 + `chatAbortRef`
- **推荐语都是 "它来自你的本地音乐库..."** → rewrite-reasons useEffect 没触发，检查 deps 是否更新

## 维护规则

- 增减函数时同步更新本表
- 行号漂移到 ±10 行就需要刷新（按符号名搜索即可重新定位）
- 新增重要 ref / 派生 state 也要登记在表里
