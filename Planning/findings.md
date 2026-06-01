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
