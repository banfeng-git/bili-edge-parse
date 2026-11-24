/**
 * 腾讯 EdgeOne 站点级边缘函数入口（Service Worker 风格）
 * 运行时仅支持 addEventListener('fetch', ...)，通过 event.respondWith 返回响应。
 * 控制台部署时使用内联后的 dist/edgeone-edge-function.js（单文件，无 import）。
 */
import { createHandler } from "../core.js";

// 登录 Cookie（Secret 环境变量 BILI_COOKIE）由控制台注入；代码与仓库不保存凭证。
const biliCookie = (typeof env !== "undefined" && env.BILI_COOKIE) || "";
const { handleRequest } = createHandler({ biliCookie });

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});
