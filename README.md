# bili-edge-parse

B 站视频解析边缘函数。把 BV 号拼到 API 域名后即可拿到可直接进播放器的代理流地址，默认请求 720P；无状态、不依赖数据库，仅使用标准 Web API（`fetch` / `Response` / `URL` / `Headers`）。

## 接口

| 用途 | 链接 |
| --- | --- |
| 解析信息（JSON） | `/api/parse/<BV号>` |
| 直接播放（302 跳到代理流） | `/api/play/<BV号>` |
| 流代理 | `/api/stream?u=<上游地址>&b=<备用地址>` |

- 分 P：加 `?p=2`；也支持完整链接：`/api/parse?url=https://www.bilibili.com/video/BVxxxx/`
- 流代理自动携带 `Referer: https://www.bilibili.com/`，透传 `Range` 请求，支持拖动进度。
- 示例：`https://bili.466949.xyz/api/parse/BV1qYyRz5EdM`

## 目录结构

```
src/
  core.js                                  # 平台无关核心逻辑，createHandler() 返回 handleRequest
  aliyun-esa/entry.js                     # 阿里云 ESA（EdgeRoutine）模块入口
  cloudflare-worker/entry.js              # Cloudflare Workers 模块入口
  cloudflare-pages/functions/[[catchall]].js   # Cloudflare Pages Functions 入口
  edgeone-edge-function/entry.js           # 腾讯 EdgeOne 站点级边缘函数（addEventListener）
  edgeone-pages/edge-functions/[[default]].js  # 腾讯 EdgeOne Pages Functions 入口
dist/                                      # 内联核心后的单文件，可直接粘贴到控制台（build 产物）
tools/build.mjs                            # 由 src 生成 dist
```

## 构建

```bash
npm run build
# 等价于 node tools/build.mjs，输出到 dist/
```

## 各平台部署

### 阿里云 ESA（EdgeRoutine）— 已上线实测

- 入口形式：模块对象 `export default { async fetch(request, context, env) }`。
- 控制台函数代码直接粘贴 `dist/aliyun-esa.js`，保存 → 生成版本 → 快速发布到生产。
- 当前生产域名：`https://bili.466949.xyz`。

### Cloudflare Workers

- 入口形式：模块对象 `export default { async fetch(request, env, ctx) }`。
- 控制台粘贴 `dist/cloudflare-worker.js`，或用 Wrangler 部署 `src/cloudflare-worker/entry.js`。

### Cloudflare Pages Functions

- 把 `dist/cloudflare-pages-function.js` 内容放到 Pages 项目根目录 `functions/[[catchall]].js`。
- 导出 `onRequest(context)`，内部调用 `context.request`。

### 腾讯 EdgeOne 站点级边缘函数

- 入口形式：Service Worker 风格 `addEventListener("fetch", event => event.respondWith(...))`，**不支持 ES import**。
- 控制台函数代码粘贴 `dist/edgeone-edge-function.js`（已内联核心，单文件），再配置匹配站点 HOST / 路径的触发规则。

### 腾讯 EdgeOne Pages Functions

- 把 `dist/edgeone-pages-function.js` 内容放到 Pages 项目 `edge-functions/[[default]].js`。
- 默认导出 `onRequest({ request })`，所有路径进入同一处理函数。

## 第三方解析中转（可选）

核心逻辑在 `src/core.js` 的 `createHandler(options)`：

| 字段 | 说明 |
| --- | --- |
| `parseKey` | 第三方解析接口密钥；填写后走中转，不再直连 B 站 |
| `parseBase` | 接口根地址，默认 `https://xiaoapi.cn` |

适配结构：`data.video.{title,pic,duration,bvid,pages[]}`、`data.streams.{quality,quality_text,video_url,durl[]}`。其他形态（如 DASH 分离流）需再补适配器。各平台入口目前用默认空配置（直连 B 站）；接入中转时把密钥通过运行时环境变量传入 `createHandler({ parseKey, parseBase })`，**不要把 Cookie、密码、密钥写进仓库**。

## 清晰度与限制

- 默认请求 720P（`qn=64`）。未登录状态下部分视频会回落 480P/360P；稳定 720P 及以上需上游登录态（SESSDATA）。
- 会员专属、付费、已下架内容无法解析。上游流地址有时效，过期后重新请求解析接口刷新即可。
- B 站上游不提供原生 m3u8，返回音视频合流 mp4（durl），本工程通过代理流地址直接供播放器打开。
- 流代理白名单后缀：`.bilivideo.com`、`.bilivideo.cn`、`.akamaihd.net`、`.akamaized.net`、`.mountaintoys.cn`，非这些域名的地址一律 403，避免被当成开放代理。

## 各平台连通性说明（实测结论）

- **阿里云 ESA**：边缘出口未被 B 站 WAF 拦截，直连解析 / 取流 / 流代理均实测通过。
- **Cloudflare**：历史实测 CF 边缘出口 IP 段 / TLS 指纹会被 B 站接口全量 412（`request was banned`），换 buvid Cookie、补浏览器头均无效；CF 方向如需可用，应接不在黑名单的第三方中转后端。`/api/stream` 代理本身在传入已签名 CDN 地址时可用（注入 Referer、透传 Range）。
- **腾讯 EdgeOne**：入口与核心逻辑本地 harness 跑通（parse 200、play 302、stream 206），线上连通性未实测；若直连被风控，同样改用第三方中转。

## 本地验证

```bash
node tools/build.mjs
# 核心逻辑直连本机网络验证（parse / play / stream）
node --input-type=module -e "
import { createHandler } from './src/core.js';
const { handleRequest } = createHandler();
const r = await handleRequest(new Request('https://x.example.com/api/parse/BV1qYyRz5EdM'));
console.log(r.status, (await r.json()).data?.quality);
"
```
