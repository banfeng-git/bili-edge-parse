/**
 * B 站视频解析 · 平台无关核心逻辑
 * 仅使用标准 Web API（fetch / Response / URL / Headers），不依赖数据库与 Node 内置模块。
 *
 * 路由：
 *   /api/parse/<BV号>                           返回 JSON 信息 + 代理/直链地址
 *   /api/parse/pay/<BV号>                       同上，pay 为可选分类段
 *   /api/watch/<BV号>                           网页播放页（直链优先，出错回退代理）
 *   /api/play/<BV号>                            浏览器打开出播放页；播放器取流 302 跳代理
 *   /api/parse/play/<BV号>                      同上（play 为播放动作段）
 *   /api/stream?u=<上游地址>&b=<备用地址>        流代理（注入 Referer，透传 Range）
 *   其他路径                                    返回说明页
 *
 * 各边缘平台只需在入口里调用 createHandler() 拿到 handleRequest 并接入自己的运行时。
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REFERER = "https://www.bilibili.com/";

const QUALITY_MAP = {
  16: "360P",
  32: "480P",
  64: "720P",
  80: "1080P",
  112: "1080P+",
  116: "1080P60",
  120: "4K",
  125: "HDR",
  126: "杜比视界",
  127: "8K",
};

function qualityDesc(q) {
  return QUALITY_MAP[q] || `qn${q}`;
}

function extractBvid(input) {
  if (!input) return null;
  const m = String(input).match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : null;
}

function jsonResponse(data, status) {  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function createHandler(options) {
  const CONFIG = {
    PARSE_KEY: (options && options.parseKey) || "",
    PARSE_BASE: (options && options.parseBase) || "https://xiaoapi.cn",
    // 完整登录 Cookie 串（SESSDATA=...; bili_jct=...; DedeUserID=...），由平台环境变量注入，不落代码/仓库。
    BILI_COOKIE: (options && options.biliCookie) || "",
  };

  async function fetchJson(url, cookie, init) {
    const headers = new Headers((init && init.headers) || {});
    headers.set("User-Agent", UA);
    headers.set("Referer", REFERER);
    headers.set("Accept", "application/json, text/plain, */*");
    if (cookie) headers.set("Cookie", cookie);
    const resp = await fetch(url, Object.assign({}, init, { headers }));
    return resp.json().catch(() => ({ code: -1, message: "parse error" }));
  }

  async function fetchBuvid() {
    try {
      const r = await fetch("https://api.bilibili.com/x/frontend/finger/spi", {
        headers: { "User-Agent": UA, Referer: REFERER, Accept: "application/json" },
      });
      const j = await r.json();
      const b3 = j && j.data && j.data.b_3;
      const b4 = j && j.data && j.data.b_4;
      if (!b3 || !b4) return "";
      return `buvid3=${b3}; buvid4=${b4}`;
    } catch {
      return "";
    }
  }

  /** 第三方解析中转（xiaoapi 形态） */
  async function resolveViaThirdParty(bvid, page) {
    const base = (CONFIG.PARSE_BASE || "https://xiaoapi.cn").replace(/\/+$/, "");
    const url =
      `${base}/v1/bilibili_video_api.php?key=${encodeURIComponent(CONFIG.PARSE_KEY)}` +
      `&bv=${encodeURIComponent(bvid)}&p=${page}`;
    const j = await fetchJson(url, "");
    if (j.code !== 0) {
      throw new Error(`[thirdparty ${j.code}] ${j.msg || j.message || "解析失败"}`);
    }
    const d = j.data || {};
    const v = d.video || {};
    const s = d.streams || {};
    const pages = v.pages || [];
    const pItem = pages[page - 1] || {};
    const streamUrl = s.video_url || (s.durl && s.durl[0] && s.durl[0].url) || "";
    const backupUrl = (s.durl && s.durl[1] && s.durl[1].url) || "";
    if (!streamUrl) throw new Error("第三方未返回可播放流");
    return {
      bvid: v.bvid || bvid,
      aid: v.aid || 0,
      cid: pItem.cid || 0,
      title: v.title || bvid,
      desc: v.desc || "",
      duration: v.duration != null ? v.duration : pItem.duration || 0,
      poster: (v.pic || "").replace(/^http:/, "https:"),
      page,
      pageCount: pages.length || 1,
      quality: s.quality || 0,
      qualityDesc: s.quality_text || qualityDesc(s.quality || 0),
      format: s.format || "",
      streamUrl,
      backupUrls: backupUrl ? [backupUrl] : [],
      backupUrl,
    };
  }

  /** 直连 B 站取流（请求 1080P 档，按游客身份回落至 720P/360P；qn 可被查询参数覆盖） */
  async function resolveDirect(bvid, page, qn) {
    // buvid 与分 P 列表互不依赖，并行请求以降低首屏延迟。
    const [buvid, pl] = await Promise.all([
      fetchBuvid(),
      fetchJson(`https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`, ""),
    ]);
    if (pl.code !== 0) {
      throw new Error(`[pagelist ${pl.code}] ${pl.message || "分P信息获取失败"}`);
    }
    const items = pl.data || [];
    if (!items.length) throw new Error("未找到分P信息");
    const pIdx = Math.min(Math.max(page, 1), items.length) - 1;
    const pItem = items[pIdx];
    const cid = pItem.cid;

    // 合并游客 buvid 与注入的登录 Cookie（SESSDATA 等），空值忽略。
    const cookie = [buvid, CONFIG.BILI_COOKIE].filter(Boolean).join("; ");

    let title = pItem.part || bvid;
    let desc = "";
    let pic = pItem.first_frame || "";
    let aid = 0;

    const playQn = qn || 80;
    const playUrl =
      `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}` +
      `&cid=${cid}&qn=${playQn}&fnval=1&fourk=1&otype=json`;
    // 详情（标题/封面）与播放地址互不依赖，并行请求；详情失败不影响取流。
    const [det, play] = await Promise.all([
      fetchJson(
        `https://api.bilibili.com/x/web-interface/view/detail?bvid=${encodeURIComponent(bvid)}`,
        cookie,
      ).catch(() => ({ code: -1 })),
      fetchJson(playUrl, cookie),
    ]);
    if (det.code === 0 && det.data && det.data.View) {
      const v = det.data.View;
      title = v.title || title;
      desc = v.desc || "";
      pic = v.pic || pic;
      aid = v.aid || aid;
    }

    if (play.code !== 0) {
      throw new Error(`[playurl ${play.code}] ${play.message || "播放地址获取失败"}`);
    }
    const d = play.data || {};
    const durl = (d.durl || [])[0];
    if (!durl || !durl.url) {
      throw new Error("该视频无可播放流（可能为会员/付费内容或已下架）");
    }
    return {
      bvid,
      aid,
      cid,
      title,
      desc,
      duration: pItem.duration != null ? pItem.duration : durl.length || 0,
      poster: pic ? pic.replace(/^http:/, "https:") : "",
      page: pIdx + 1,
      pageCount: items.length || 1,
      quality: d.quality || 0,
      qualityDesc: qualityDesc(d.quality || 0),
      format: d.format || "",
      streamUrl: durl.url,
      backupUrls: durl.backup_url || [],
      backupUrl: (durl.backup_url || [])[0] || "",
    };
  }

  async function resolveVideo(bvid, page, qn) {
    if (CONFIG.PARSE_KEY) return resolveViaThirdParty(bvid, page);
    return resolveDirect(bvid, page, qn);
  }

  function proxyStreamUrl(origin, info) {
    // 代理回源也按节点质量优选：主链取最优节点，次优节点作为 backup 供回源失败时切换。
    const list = rankedStreams(info);
    const target = list[0] || info.streamUrl || info.backupUrl || "";
    const backup = list[1] || "";
    const u = encodeURIComponent(target);
    const b = backup ? `&b=${encodeURIComponent(backup)}` : "";
    return `${origin}/api/stream?u=${u}${b}`;
  }

  function isAllowedStreamHost(href) {
    try {
      const host = new URL(href).hostname;
      return (
        host.endsWith(".bilivideo.com") ||
        host.endsWith(".bilivideo.cn") ||
        host.endsWith(".akamaihd.net") ||
        host.endsWith(".akamaized.net") ||
        host.endsWith(".mountaintoys.cn")
      );
    } catch {
      return false;
    }
  }

  /**
   * 宽松节点：浏览器 UA、不带 Referer 也能取流（实测 akamai 节点放行）。
   * bilivideo 主域必须携带 Referer: https://www.bilibili.com/，否则 403。
   */
  function isLooseHost(href) {
    try {
      const host = new URL(href).hostname;
      return host.endsWith(".akamaized.net") || host.endsWith(".akamaihd.net");
    } catch {
      return false;
    }
  }

  /**
   * P2P 边缘坏节点：实测 1–2M/s 且频繁 Connection reset（mcdn、mountaintoys 专属域），
   * 正规 CDN（bilivideo.com）5–25M/s 稳定。命中坏节点时应优先换 backup 里的正规 CDN。
   */
  function isP2PHost(href) {
    try {
      const h = new URL(href).hostname;
      return (
        h.includes("mcdn.bilivideo") ||
        h.includes("edge.mountaintoys") ||
        h.endsWith(".mountaintoys.cn")
      );
    } catch {
      return false;
    }
  }

  /** 节点打分：宽松可裸连加分，P2P 坏节点重扣分，其余放行节点给基础分。 */
  function hostRank(href) {
    if (!isAllowedStreamHost(href)) return -1;
    let rank = 1;
    if (isLooseHost(href)) rank += 2;
    if (isP2PHost(href)) rank -= 3;
    return rank;
  }

  /** 候选流按节点质量降序：正规 CDN / 宽松节点优先，P2P 坏节点垫底。 */
  function rankedStreams(info) {
    const candidates = [info.streamUrl, ...(info.backupUrls || [])].filter(Boolean);
    return candidates.sort((a, b) => hostRank(b) - hostRank(a));
  }

  /** 选直链：取质量最优的一条；宽松节点可裸连，其余需客户端自带 B 站 Referer。 */
  function pickDirect(info) {
    return rankedStreams(info)[0] || "";
  }

  async function handleStream(request) {
    const url = new URL(request.url);
    const primary = url.searchParams.get("u") || "";
    const backup = url.searchParams.get("b") || "";
    const candidates = [primary, backup].filter(Boolean);
    if (!candidates.length) return new Response("missing stream url", { status: 400 });
    if (!candidates.every(isAllowedStreamHost)) {
      return new Response("host not allowed", { status: 403 });
    }
    const headers = new Headers();
    headers.set("User-Agent", UA);
    headers.set("Referer", REFERER);
    headers.set("Accept", "*/*");
    // 无 Range 时默认只取前 512KB 分片，避免整段回源被前置安全防护按大响应拦截（567）；
    // 播放器拖动进度时会再发带 Range 的分片请求。
    let range = request.headers.get("Range");
    if (!range) range = "bytes=0-524287";
    headers.set("Range", range);

    let lastErr = null;
    for (const target of candidates) {
      try {
        const upstream = await fetch(target, { headers, redirect: "follow" });
        if (upstream.status === 403 || upstream.status === 404) {
          lastErr = upstream.status;
          continue;
        }
        const out = new Headers();
        ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Cache-Control"].forEach((k) => {
          const v = upstream.headers.get(k);
          if (v) out.set(k, v);
        });
        if (!out.get("Accept-Ranges")) out.set("Accept-Ranges", "bytes");
        out.set("Access-Control-Allow-Origin", "*");
        out.set("Cache-Control", "no-store");
        return new Response(upstream.body, { status: upstream.status, headers: out });
      } catch (e) {
        lastErr = e;
      }
    }
    return new Response(`stream fetch failed: ${lastErr}`, { status: 502 });
  }

  function indexHtml() {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>B 站视频解析</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;line-height:1.7}code,pre{background:rgba(127,127,127,.15);border-radius:6px;padding:2px 6px}pre{padding:12px;overflow:auto}</style>
</head><body><h1>B 站视频解析</h1>
<pre>解析信息：/api/parse/BV1xxxxxxxxx
网页播放：/api/watch/BV1xxxxxxxxx
直链/代理：见 JSON 的 direct、proxy 字段
分 P：?p=2；完整链接：?url=</pre>
<p><code>/api/watch</code> 在浏览器内直连 CDN 播放（不带 Referer），被防盗链拦截时自动回退本站代理；会员/付费/下架内容无法解析。</p>
</body></html>`;
  }

  function watchHtml(info, src, proxy, mode) {
    const cfg = JSON.stringify({ proxy });
    const noteText =
      mode === "direct"
        ? `清晰度 ${escapeHtml(info.qualityDesc)} · 直连 CDN 播放`
        : `清晰度 ${escapeHtml(info.qualityDesc)} · 本站代理播放（已补 Referer）`;
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(info.title)}</title>
<style>
body{margin:0;background:#111;color:#eee;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
h1{font-size:16px;font-weight:600;margin:8px 0 12px;text-align:center;max-width:900px}
video{width:100%;max-width:900px;aspect-ratio:16/9;background:#000;border-radius:10px}
#note{margin-top:10px;font-size:13px;color:#999}
</style></head><body>
<h1>${escapeHtml(info.title)}</h1>
<video id="v" controls playsinline autoplay muted preload="metadata" referrerpolicy="no-referrer" poster="${escapeHtml(info.poster)}" src="${escapeHtml(src)}"></video>
<div id="note">${noteText}</div>
<script>
const cfg = ${cfg};
const v = document.getElementById('v');
const note = document.getElementById('note');
let fallback = false;
v.addEventListener('error', () => {
  if (fallback || !cfg.proxy) return;
  fallback = true;
  note.textContent = '直链被防盗链拦截，已切换本站代理播放';
  v.src = cfg.proxy;
  v.load();
});
</script>
</body></html>`;
  }

  async function handleRequest(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/stream") return handleStream(request);

    // 路径段：/api/[parse|play|watch]/[可选分类段]/<BV号>。
    const routeMatch = path.match(/^\/api\/(parse|play|watch)(?:\/([a-z]+))?\/(.+)$/);
    const seg1 = routeMatch ? routeMatch[1] : null;
    const seg2 = routeMatch ? routeMatch[2] : null;
    let bvid = routeMatch ? extractBvid(decodeURIComponent(routeMatch[3])) : null;
    if (!bvid) bvid = extractBvid(url.searchParams.get("url") || "");
    const page = parseInt(url.searchParams.get("p") || "1", 10) || 1;
    const qn = parseInt(url.searchParams.get("qn") || "", 10) || 0;
    const isPlay = seg1 === "play" || seg2 === "play";
    const isWatch = seg1 === "watch";

    if (path.startsWith("/api/parse") || path.startsWith("/api/play") || path.startsWith("/api/watch")) {
      if (!bvid) return jsonResponse({ code: 400, message: "缺少 BV 号" }, 400);
      try {
        const info = await resolveVideo(bvid, page, qn);
        // B 站 CDN 签名直链（优先宽松节点），网页页直连优先；proxy 为出错/不兼容客户端的代理兜底。
        const direct = pickDirect(info);
        const proxy = proxyStreamUrl(url.origin, info);
        const loose = isLooseHost(direct);
        const accept = request.headers.get("Accept") || "";
        const wantHtml = isWatch || (isPlay && accept.includes("text/html"));
        if (wantHtml) {
          // 网页页统一走本站代理起播：实测宽松 akamai 节点也可能被防盗链 403，
          // 先直连撞墙再回退只会增加起播延迟；代理已补 Referer 且节点经质量优选。
          return new Response(watchHtml(info, proxy, "", "proxy"), {
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          });
        }
        if (isPlay) {
          // 宽松节点裸连即可播，直连减少代理回源；主域必须带 Referer，走本站代理兜底。
          const playTarget = loose ? direct : proxy;
          return Response.redirect(playTarget, 302);
        }
        return jsonResponse({
          code: 0,
          message: "success",
          data: {
            bvid: info.bvid,
            cid: info.cid,
            title: info.title,
            desc: info.desc,
            duration: info.duration,
            poster: info.poster,
            page: info.page,
            page_count: info.pageCount,
            quality: info.quality,
            quality_desc: info.qualityDesc,
            format: info.format,
            // proxy：本站代理，浏览器/普通 App 默认可播；direct：CDN 直链，需客户端自带 B 站 Referer。
            direct,
            proxy,
            raw: info.streamUrl,
            backup: info.backupUrl,
            backups: info.backupUrls || [],
          },
        });
      } catch (e) {
        return jsonResponse({ code: 500, message: (e && e.message) || String(e) }, 500);
      }
    }

    return new Response(indexHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return { handleRequest, resolveVideo, isAllowedStreamHost };
}

export { createHandler };
