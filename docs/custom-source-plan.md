# 自定义音源实现计划

> 基于 LX Music `userApi` 源码完整分析，参考 `/Users/lipan/Downloads/lx-music-desktop-master/src/main/modules/userApi/`
>
> 当前实现状态：Step 1-7 已完成，Step 8 待实现（接入 Claudio FM 播放流程）

---

## 源码文件索引

| 文件 | 用途 |
|------|------|
| `lx-music-desktop-master/src/main/modules/userApi/renderer/preload.js` | lx API 定义（核心） |
| `lx-music-desktop-master/src/main/modules/userApi/rendererEvent/rendererEvent.ts` | IPC 请求队列、20s 超时 |
| `lx-music-desktop-master/src/main/modules/userApi/main.ts` | BrowserWindow 创建、安全策略 |
| `lx-music-desktop-master/src/main/modules/userApi/utils.ts` | 元数据解析、deflate 压缩存储 |

---

## 当前实现清单

| Step | 文件 | 状态 |
|------|------|------|
| 1 | `src/lib/script-vm.ts` | ✅ 完成 |
| 2 | `src/lib/song-download.ts` | ✅ 完成 |
| 3 | `src/app/api/script-source/route.ts` | ✅ 完成 |
| 4 | `data/` 目录持久化 | ✅ 完成（与 Step 3 合并） |
| 5 | `lx.request` callback 风格 | ✅ 完成（与 Step 1 合并） |
| 6 | lyric 拦截 | ✅ 完成 |
| 7 | pic 拦截 | ✅ 完成 |
| **8** | **接入 Claudio FM 播放流程** | **⬜ 待做** |

---

## Step 8：接入 Claudio FM 播放流程

### 8.1 当前状态

`resolvePlaybackUrlForHit` 已接入 scriptVM 优先尝试，下载链路完整。

**缺失环节**： Claudio FM 播放时（`live-music.ts` 的 `buildLiveTracks`）直接调 `resolvePlaybackUrlForHit` 走下载逻辑，没有利用 scriptVM 的 lyric/pic 拦截能力。

### 8.2 需要补充的三个方向

#### 方向 A：streaming 播放时的 lyric/pic 拦截

**现状**：`buildLiveTracks` 在 `resolvePlaybackUrlForHit` 返回 null 时直接跳过这首歌，不会再尝试 lyric。

**目标**：当 `scriptVM.isLoaded` 且用户脚本声明了 lyric action 时，把 lyric 数据以某种形式传给 Claudio（存到临时文件或通过 API）。

**影响范围**：`src/lib/claudio/live-music.ts`

#### 方向 B：新增 API Route 支持 lyric/pic 单独获取

**目标**：让前端在播放页按需请求 lyric/pic，不走下载流程。

```
GET /api/script-source?action=lyric&source=kugou&hash=xxx
GET /api/script-source?action=pic&source=kugou&hash=xxx
```

**对比 LX Music**：LX 的 lyric/pic 是随 musicUrl 一起 IPC 发给主进程的，radio-app 需要分开请求。

#### 方向 C：搜索结果合并 user_script 源

**现状**：搜索只有 `kugou`/`qq`/`netease` 三个源。

**目标**：如果 scriptVM 声明了额外 source（如 `kg`/`wy`），搜索结果里加上这些源。

**影响范围**：`src/lib/music-search.ts`

---

### 8.3 推荐实现顺序

```
Step 8.1:  新增 lyric/pic API Route（/api/script-source?action=lyric|pic）
Step 8.2:  live-music.ts 调用 lyric/pic API 获取歌词
Step 8.3:  music-search.ts 扩展 source 列表
Step 8.4:  端到端验证
```

---

### 8.4 详细设计

#### 8.4.1 lyric/pic API Route（扩展现有 route.ts）

```typescript
// GET /api/script-source?action=lyric&source=kugou&hash=xxx&type=320k
// GET /api/script-source?action=pic&source=kugou&hash=xxx

case "lyric": {
  if (!scriptVM.isLoaded) return NextResponse.json({ success: false, error: "no script loaded" })
  const source = searchParams.get("source")
  const musicInfo = { hash, songmid, songId, name, singer, album } = ...
  const result = await scriptVM.resolve({ source, action: "lyric", info: { type, musicInfo } })
  if (!result) return NextResponse.json({ success: false, error: "lyric not found" })
  return NextResponse.json({ success: true, ...JSON.parse(result) })
}
case "pic": {
  // 同理
}
```

#### 8.4.2 live-music.ts lyric 获取逻辑

```typescript
// buildLiveTracks 中，对于远端歌曲：
const lyricText = await fetchLyricFromScript(hit).catch(() => null)

// 如果拿到了 lyric，存为临时 .lrc 文件供播放器使用
if (lyricText) {
  const tmpLrc = tempPath.replace(/\.mp3$/, '.lrc')
  await fs.writeFile(tmpLrc, lyricText, 'utf8')
}
```

#### 8.4.3 music-search.ts source 扩展

```typescript
export type MusicSearchSource = "kugou" | "qq" | "netease" | "user_script"

// searchSongsBySource 里：
// 如果 source === "user_script" 且 scriptVM.isLoaded
//   遍历 scriptVM.supportedSources，搜索每个 source
//   调用 scriptVM.resolve({ source, action: "search", info: { keyword } })
```

---

### 8.5 验证方式

```bash
# 1. 脚本加载状态
curl http://localhost:3000/api/script-source?action=status

# 2. lyric 请求（需要先加载脚本）
curl "http://localhost:3000/api/script-source?action=lyric&source=kugou&hash=YOUR_HASH"

# 3. pic 请求
curl "http://localhost:3000/api/script-source?action=pic&source=kugou&hash=YOUR_HASH"

# 4. Claudio FM 播放一首付费歌曲，日志应显示 lyric/pic 来自 scriptVM
```

---

## 参考：LX Music 与 radio-app 关键差异

| 项目 | LX Music | radio-app（当前） |
|------|----------|-----------------|
| 执行环境 | Electron BrowserWindow | Node.js vm |
| 请求模型 | IPC 队列，20s超时 | 直接调用 vm.resolve() |
| lx.env | 'desktop' | 'node' |
| lx.request | needle（callback风格） | fetch（Promise风格） |
| 错误处理 | window.error事件 | try/catch |
| 脚本存储 | deflate压缩+electron-store | JSON文件 |
| source过滤 | 硬编码 qualitys/actions | 用户脚本声明即支持 |

---

## 执行顺序

```
Step 1 ✅ → Step 2 ✅ → Step 3 ✅ → Step 4 ✅ → Step 5 ✅ → Step 6 ✅ → Step 7 ✅ → Step 8.1 ⬜ → Step 8.2 ⬜ → Step 8.3 ⬜ → Step 8.4 ⬜
```

每个 Step 完成后必须验证通过，再进行下一个。