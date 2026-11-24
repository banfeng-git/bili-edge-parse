# bili-edge-parse

B 站视频解析边缘函数。把 BV 号拼到 API 域名后即可拿到可播放地址，默认请求 1080P 档并按游客身份回落至 720P/360P；无状态、不依赖数据库，仅使用标准 Web API（`fetch` / `Response` / `URL` / `Headers`）。

## 接口

| 用途 | 链接 |
| --- | --- |
| 解析信息（JSON） | `/api/parse/<BV号>` |
| 网页播放页（直连 CDN，出错回退代理） | `/api/watch/<BV号>` |
| 播放入口：浏览器出网页页，播放器取流 302 跳代理 | `/api/play/<BV号>` |
| 播放别名（同上） | `/api/parse/play/<BV号>` |
| 流代理 | `/api/stream?u=<上游地址>&b=<备用地址>` |

- 分 P：加 `?p=2`；也支持完整链接：`/api/parse?url=https://www.bilibili.com/video/BVxxxx/`
- 浏览器打开 `/api/watch/<BV号>`：分到 akamai 宽松节点时页面内 `<video referrerpolicy="no-referrer">` 直连 CDN，视频流量不经过函数；只分到 bilivideo 主域（必须带 Referer）时网页页直接用本站代理起播，避免先 403 再回退。画质按游客身份回落，通常 720P，部分片源 360P。
- 第三方播放器/App 直接取流时，`/api/play` 返回 302：宽松节点直连，主域走本站代理（代理自动补 `Referer: https://www.bilibili.com/` 并转发分片）；受免费函数出口带宽限制。
- JSON `data` 字段：`direct` 为 B 站 CDN 签名直链（优先 akamai 宽松节点），`proxy` 为本站代理地址，`raw` 为上游主域签名地址，`backup` / `backups` 为备用流域名列表。
- Referer 现实：bilivideo 主域必须带 B 站 Referer 否则 403；akamai 宽松节点不带 Referer 也能放行。能自定义 Referer 的播放器（MPV、IINA 等）可直接用 `direct`/`raw` 直链以获得更高带宽。
- 示例：`https://bili.466949.xyz/api/watch/BV1qYyRz5EdM`

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

### 腾讯 EdgeOne 站点级边缘函数 — 已上线实测

- 入口形式：Service Worker 风格 `addEventListener("fetch", event => event.respondWith(...))`，**不支持 ES import**。
- 控制台函数代码粘贴 `dist/edgeone-edge-function.js`（已内联核心，单文件），再配置匹配站点 HOST / 路径的触发规则。
- 当前生产域名：`https://bili.cotd.top`（站点 `cotd.top`，触发规则按 HOST 命中本函数）；免费证书签发前浏览器会提示证书不安全，命令行可加 `-k` 验证。
- 实测（BV1qYyRz5EdM，360P 回落片）：解析 200 JSON，边缘出口未被 B 站 WAF 412；`/api/stream` 代理 8MB 分片持续约 **2.0–2.2 MB/s**，对照同片 ESA 约 **433 KB/s**，EdgeOne 代理带宽明显更高。

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

- 默认请求 1080P 档（`qn=80`，可用 `?qn=` 覆盖）。**2026-11-25 实测**：EdgeOne 出口命中宽松 akamai / P2P 坏节点时会被风控压到 360P（quality 16）；把选流与代理回源切到正规 `bilivideo.com` CDN 后，同一出口连续多次稳定取到 720P（quality 64，mp4720）。720P 以上（1080P/高帧率/4K）仍需登录态（SESSDATA）、大会员或住宅出口 VPS / 第三方中转后端。
- **登录 Cookie（可选，解高清）**：在平台边缘函数的环境变量/密钥中配置 `BILI_COOKIE`，值为完整登录 Cookie 串（`SESSDATA=...; bili_jct=...; DedeUserID=...`），代码运行时读取并随上游请求带上；凭证只存平台 Secret，不写入代码与仓库。未配置时按游客身份取流。机房出口叠加登录态能否解除 360P 限档需线上验证。
- 会员专属、付费、已下架内容无法解析。上游流地址有时效，过期后重新请求解析接口刷新即可。
- B 站上游不提供原生 m3u8，返回音视频合流 mp4（durl）；`direct` 为签名直链，`proxy` 字段为边缘代理回退。
- 流代理白名单后缀：`.bilivideo.com`、`.bilivideo.cn`、`.akamaihd.net`、`.akamaized.net`、`.mountaintoys.cn`，非这些域名的地址一律 403，避免被当成开放代理。
- 节点质量分级：选流与代理回源优先正规 `bilivideo.com` / 宽松 akamai；P2P 坏节点（`mcdn.bilivideo*`、`edge.mountaintoys*`、`*.mountaintoys.cn`，实测 1–2M/s 且频繁断连）降为兜底，命中时自动从 backup 换正规 CDN。

### 浏览器 / 普通 App 播放的两层限制（2026-11-25 实测）

1. **直链防盗链 403**：bilivideo 主域只认 `Referer: https://www.bilibili.com/`，浏览器与普通 App 无法把 Referer 伪造成 B 站，直取该主域会 `Access Denied / 403`；akamai 宽松节点也并非全部放行。网页播放页 `/api/watch` 因此统一走本站代理起播（代理补 Referer、节点经质量优选），不再先直连撞墙再回退；`direct`/`raw` 直链只留给能自定义 Referer 的播放器（MPV、IINA 等）。
2. **免费边缘代理带宽有限**：`/api/stream` 代理自动补 B 站 Referer；无 Range 的整段回源会被前置安全防护拦截（567），现已改为默认只取前 512KB 分片、拖动时再按 Range 分片转发以规避。带宽随平台节点波动：同一片视频，ESA 代理 8MB 分片约 433 KB/s，EdgeOne 约 2.9–3.1 MB/s；长视频高码率仍可能缓冲。免费版 ESA 的全局 WAF、全网限流均为企业版功能，控制台无放行入口。

**结论**：网页页经本站代理起播（节点优选到正规 CDN）；能自定义 Referer 的播放器可直接用 `direct`/`raw` 直链。720P 在节点优选后的 EdgeOne 出口可稳定取到，1080P 及以上、长视频高码率仍可能缓冲，需要登录态、自备中转后端（VPS / 对象存储 / 第三方解析 API）或更高带宽的企业版。

## 各平台连通性说明（实测结论）

- **阿里云 ESA**：边缘出口未被 B 站 WAF 拦截，解析 / 取流正常；`/api/stream` 分片（带 Range）可 206 转发，但整段回源被前置防护 567，且免费函数带宽有限（见上节）。
- **Cloudflare**：历史实测 CF 边缘出口 IP 段 / TLS 指纹会被 B 站接口全量 412（`request was banned`），换 buvid Cookie、补浏览器头均无效；CF 方向如需可用，应接不在黑名单的第三方中转后端。`/api/stream` 代理本身在传入已签名 CDN 地址时可用（注入 Referer、透传 Range）。
- **腾讯 EdgeOne**：线上实测出口未被 B 站 WAF 拦截（parse 200、watch 200、play 播放器取流 302、stream 206）；代理持续带宽约 2.9–3.1 MB/s（8MB 分片），优于同片 ESA 的约 433 KB/s。节点优选到正规 `bilivideo.com` 后可稳定取 720P；早期命中 akamai/P2P 节点时回落 360P。1080P 及以上仍需登录态/中转/住宅 VPS。默认函数域名 `*.eo-edgefunctions1.com` 从大陆网络 TLS 握手被重置，需绑定站点内已加速的自定义域名并配触发规则才能稳定访问。

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
