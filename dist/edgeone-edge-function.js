/**
 * 由 tools/build.mjs 自动生成，请勿手改；源码见 src/ 目录。
 * 目标平台：edgeone-edge-function
 */
/**
 * B 站视频解析 · 平台无关核心逻辑
 * 仅使用标准 Web API（fetch / Response / URL / Headers），不依赖数据库与 Node 内置模块。
 *
 * 路由：
 *   /api/parse/<BV号>                          返回 JSON 信息 + 代理流地址
 *   /api/play/<BV号>                           302 跳转到代理流
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

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

function createHandler(options) {
  const CONFIG = {
    PARSE_KEY: (options && options.parseKey) || "",
    PARSE_BASE: (options && options.parseBase) || "https://xiaoapi.cn",
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
      backupUrl,
    };
  }

  /** 直连 B 站取流（默认 720P，拿不到回落可用清晰度） */
  async function resolveDirect(bvid, page) {
    const cookie = await fetchBuvid();

    const pl = await fetchJson(
      `https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`,
      cookie,
    );
    if (pl.code !== 0) {
      throw new Error(`[pagelist ${pl.code}] ${pl.message || "分P信息获取失败"}`);
    }
    const items = pl.data || [];
    if (!items.length) throw new Error("未找到分P信息");
    const pIdx = Math.min(Math.max(page, 1), items.length) - 1;
    const pItem = items[pIdx];
    const cid = pItem.cid;

    let title = pItem.part || bvid;
    let desc = "";
    let pic = pItem.first_frame || "";
    let aid = 0;
    try {
      const det = await fetchJson(
        `https://api.bilibili.com/x/web-interface/view/detail?bvid=${encodeURIComponent(bvid)}`,
        cookie,
      );
      if (det.code === 0 && det.data && det.data.View) {
        const v = det.data.View;
        title = v.title || title;
        desc = v.desc || "";
        pic = v.pic || pic;
        aid = v.aid || aid;
      }
    } catch {
      /* 兜底接口忽略 */
    }

    const playUrl =
      `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}` +
      `&cid=${cid}&qn=64&fnval=1&fourk=1&otype=json`;
    const play = await fetchJson(playUrl, cookie);
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
      backupUrl: (durl.backup_url || [])[0] || "",
    };
  }

  async function resolveVideo(bvid, page) {
    if (CONFIG.PARSE_KEY) return resolveViaThirdParty(bvid, page);
    return resolveDirect(bvid, page);
  }

  function proxyStreamUrl(origin, info) {
    const target = info.streamUrl || info.backupUrl;
    const u = encodeURIComponent(target);
    const b = info.backupUrl ? `&b=${encodeURIComponent(info.backupUrl)}` : "";
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
    const range = request.headers.get("Range");
    if (range) headers.set("Range", range);

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
<title>B 站视频解析</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;line-height:1.7}code,pre{background:rgba(127,127,127,.15);border-radius:6px;padding:2px 6px}pre{padding:12px;overflow:auto}</style>
</head><body><h1>B 站视频解析</h1>
<pre>解析信息：/api/parse/BV1xxxxxxxxx
直接播放：/api/play/BV1xxxxxxxxx
分 P：?p=2；完整链接：?url=</pre>
<p>流由边缘代理转发并携带 Referer，支持拖动进度。会员/付费/下架内容无法解析。</p>
</body></html>`;
  }

  async function handleRequest(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/stream") return handleStream(request);

    let bvid = null;
    let match = path.match(/^\/api\/(?:parse|play)\/(.+)$/);
    if (match) bvid = extractBvid(decodeURIComponent(match[1]));
    if (!bvid) bvid = extractBvid(url.searchParams.get("url") || "");
    const page = parseInt(url.searchParams.get("p") || "1", 10) || 1;

    if (path.startsWith("/api/parse") || path.startsWith("/api/play")) {
      if (!bvid) return jsonResponse({ code: 400, message: "缺少 BV 号" }, 400);
      try {
        const info = await resolveVideo(bvid, page);
        const play = proxyStreamUrl(url.origin, info);
        if (path.startsWith("/api/play")) {
          return Response.redirect(play, 302);
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
            play,
            raw: info.streamUrl,
            backup: info.backupUrl,
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


/**
 * 腾讯 EdgeOne 站点级边缘函数入口（Service Worker 风格）
 * 运行时仅支持 addEventListener('fetch', ...)，通过 event.respondWith 返回响应。
 * 控制台部署时使用内联后的 dist/edgeone-edge-function.js（单文件，无 import）。
 */

const { handleRequest } = createHandler();

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

