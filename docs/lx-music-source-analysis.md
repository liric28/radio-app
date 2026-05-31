# LX Music 自定义音源机制分析

> 参考源码：`/Users/lipan/Downloads/lx-music-desktop-master/src/main/modules/userApi/`

## 1. 核心架构

**独立 BrowserWindow + preload 沙箱**

```
主进程                    用户脚本窗口(preload)           用户JS脚本
┌──────────────────┐    ┌───────────────────────────┐    ┌──────────────┐
│ userApiWindow     │    │ webFrame.executeJavaScript │    │ eval(script) │
│ (BrowserWindow)  │───▶│ (preload.js)               │───▶│ lx.on()      │
│                  │    │ 暴露 lx API                │    │ 请求拦截      │
└──────────────────┘    └───────────────────────────┘    └──────────────┘
```

**流程**：
1. 主进程创建隐藏 BrowserWindow，加载 `user-api.html`（空白页）
2. preload 注入 `lx` 对象（request工具、crypto工具、on/send 接口）
3. 通过 `webFrame.executeJavaScript(userApi.script)` 执行用户脚本
4. 用户脚本调用 `lx.on('request', handler)` 注册请求拦截
5. 主进程通过 IPC 发请求到脚本窗口，脚本返回 URL

## 2. lx API 核心

**preload 暴露的 lx 对象**（`renderer/preload.js`）：

```javascript
lx = {
  version: '2.0.0',
  env: 'desktop',
  currentScriptInfo: { name, description, version, author, homepage, rawScript },
  request(url, opts, callback),  // HTTP 请求（needle 风格）
  on('request', handler),        // 注册请求拦截（关键！）
  send('inited', sourceInfo),    // 初始化完成，声明支持哪些 source/quality
  send('updateAlert', data),      // 可选，提示更新
  utils: { crypto, buffer, zlib }
}
```

**用户脚本的请求格式**（`rendererEvent.ts`）：

```javascript
// data 来自主进程 IPC
{
  source: 'kw'|'kg'|'wy'|'tx'|'mg',
  action: 'musicUrl'|'lyric'|'pic',
  info: {
    type?: '128k'|'320k'|'flac'|'flac24bit',
    musicInfo: { hash, songmid, songId, ... }
  }
}
```

## 3. preload 关键实现细节

### 3.1 初始化握手

用户脚本必须先调用 `lx.send('inited', { sources })` 声明支持哪些源。preload 内部做一次过滤：

```javascript
// preload.js line 146-156
for (const source of allSources) {
  const userSource = info.sources[source]
  if (!userSource || userSource.type !== 'music') continue
  const qualitys = supportQualitys[source]      // ['128k','320k','flac','flac24bit']
  const actions = supportActions[source]        // ['musicUrl']
  sourceInfo.sources[source] = {
    type: 'music',
    actions: actions.filter(a => userSource.actions.includes(a)),
    qualitys: qualitys.filter(q => userSource.qualitys.includes(q)),
  }
}
sendMessage(USER_API_RENDERER_EVENT_NAME.init, sourceInfo, true)
```

**关键**：用户脚本声明的 `qualitys` 和 `actions` 必须与 preload 中预设的 `supportQualitys`/`supportActions` 取交集。不是用户脚本声明什么就支持什么。

### 3.2 lx.request 实现（needle 风格）

```javascript
// preload.js line 194-241
request(url, { method='get', timeout, headers, body, form, formData }, callback) {
  let options = { headers, agent: getRequestAgent(url) }
  let data = body ?? form ?? formData
  options.response_timeout = Math.min(timeout ?? 60_000, 60_000)

  needle.request(method, url, data, options, (err, resp, body) => {
    if (err) callback.call(this, err, null, null)
    else {
      resp.body = resp.raw.toString()
      try { resp.body = JSON.parse(resp.body) } catch (_) {}
      callback.call(this, null, {
        statusCode: resp.statusCode,
        statusMessage: resp.statusMessage,
        headers: resp.headers,
        bytes: resp.bytes,
        raw: resp.raw,
        body: resp.body,
      }, resp.body)
    }
  })
}
```

### 3.3 utils 实现

```javascript
utils: {
  crypto: {
    aesEncrypt(buffer, mode, key, iv) { ... },
    rsaEncrypt(buffer, key) {
      // RSA_NO_PADDING，buffer pad到128字节
      buffer = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer])
      return publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, buffer)
    },
    randomBytes(size) { return randomBytes(size) },
    md5(str) { return createHash('md5').update(str).digest('hex') },
  },
  buffer: {
    from(...args) { return Buffer.from(...args) },
    bufToString(buf, format='binary') { return Buffer.from(buf,'binary').toString(format) },
  },
  zlib: {
    inflate(buf): Promise<Buffer>,
    deflate(data): Promise<Buffer>,
  },
}
```

### 3.4 错误处理机制

```javascript
// preload.js line 355-366
webFrame.executeJavaScript(`(() => {
  window.addEventListener('error', (event) => {
    if (event.isTrusted)
      globalThis.__lx_init_error_handler__.sendError(event.message)
  })
  window.addEventListener('unhandledrejection', (event) => {
    if (!event.isTrusted) return
    const message = typeof event.reason === 'string'
      ? event.reason : event.reason?.message ?? String(event.reason)
    globalThis.__lx_init_error_handler__.sendError(message)
  })
})()`)
```

preload 暴露 `__lx_init_error_handler__`，脚本执行期间的未捕获错误通过它上报。

## 4. 通信协议（rendererEvent.ts）

### 4.1 请求队列 + 超时

```typescript
const requestQueue = new Map<string, [resolve, reject, data]>()
const timeouts = new Map<string, NodeJS.Timeout>()

// 20秒超时
timeouts.set(requestKey, setTimeout(() => cancelRequest(requestKey), 20_000))

requestQueue.set(requestKey, [resolve, reject, data])
sendRequest({ requestKey, data })
```

### 4.2 响应处理

```typescript
const handleResponse = ({ status, data: { requestKey, result }, message }) => {
  const request = requestQueue.get(requestKey)
  if (!request) return
  requestQueue.delete(requestKey)
  clearRequestTimeout(requestKey)
  status ? request[0](result) : request[1](new Error(message))
}
```

### 4.3 三种 action 的响应格式

```typescript
// musicUrl
{ requestKey, result: { source, action, data: { type, url } } }
// lyric
{ requestKey, result: { source, action, data: { lyric, tlyric, rlyric, lxlyric } } }
// pic
{ requestKey, result: { source, action, data: picUrl } }
```

## 5. 安全机制（main.ts）

```javascript
const denyEvents = [
  'will-navigate', 'will-redirect', 'will-attach-webview',
  'will-prevent-unload', 'media-started-playing',
]

browserWindow = new BrowserWindow({
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    sandbox: false,  // sandbox: false 因为需要 webFrame.executeJavaScript
    spellcheck: false,
    autoplayPolicy: 'document-user-activation-required',
    enableWebSQL: false,
    disableDialogs: true,
    webgl: false,
    images: false,
    preload: preloadUrl,
  },
})

for (const eventName of denyEvents) {
  browserWindow.webContents.on(eventName, event => event.preventDefault())
}
browserWindow.webContents.session.setPermissionRequestHandler = () => false
browserWindow.webContents.setWindowOpenHandler = () => ({ action: 'deny' })
```

## 6. 脚本持久化（utils.ts）

```typescript
// 存储时 deflate 压缩
const deflateScript = (script: string) =>
  zlib.deflate(Buffer.from(script, 'utf8'))
    .then(buf => 'gz_' + buf.toString('base64'))

// 加载时 inflate 解压
const inflateScript = (script: string) =>
  script.startsWith('gz_')
    ? zlib.inflate(Buffer.from(script.substring(3), 'base64')).then(buf => buf.toString())
    : script
```

## 7. 元数据解析

和 radio-app 现有实现一致，使用 JS 注释块头部的 `@name/@version/@author/@homepage/@description` 格式：

```javascript
/*
 * @name 源名称
 * @description 描述
 * @version 1.0.0
 * @author 作者
 * @homepage https://...
 */
```

INFO_NAMES 长度限制：name(24), description(36), author(56), homepage(1024), version(36)

## 8. 与 radio-app 当前实现的差异

| 项目 | LX Music | radio-app（当前） |
|------|----------|-----------------|
| 执行环境 | Electron BrowserWindow | Node.js vm |
| 请求发送 | IPC 队列，20s超时 | 直接调用 vm.resolve() |
| lx.env | 'desktop' | 'node' |
| lx.request | needle（callback风格） | fetch（Promise风格） |
| 错误处理 | window.error事件 + __lx_init_error_handler__ | try/catch |
| 脚本存储 | deflate压缩+electron-store | JSON文件 |
| 初始化握手 | 必须 send('inited') 才算完成 | 自动初始化 |
| source过滤 | 硬编码 qualitys/actions 列表 | 用户脚本声明即支持 |
| openDevTools | 支持 | 不支持 |
| 代理 | 支持 proxy.host/port | 不支持 |